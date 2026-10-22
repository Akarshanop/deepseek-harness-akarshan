/** The Host wiring of the codebase docs: when a project starts documenting, on which route, and the filesystem it uses. */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodebaseDocsConfig } from '../src/codebase-docs.ts'
import { CodebaseDocsConfigSchema, registerCodebaseDocs } from '../src/codebase-docs-host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

interface Setup {
  config?: Partial<CodebaseDocsConfig>
  defaultModel?: { provider: string; model: string } | 'none'
  sessionRoute?: { provider: string; model: string }
}

async function fixture(setup: Setup = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const disk = new Map<string, string>([['/work/src/a.ts', 'export const a = 1'], ['/work/src/dir/b.ts', 'export const b = 2']])
  const fs = {
    resolve: vi.fn((path: string, options: { cwd: string }) => Promise.resolve(path === '.' ? options.cwd : `${options.cwd}/${path}`)),
    listDir: vi.fn((target: string) => {
      const prefix = `${target}/`
      const children = new Map<string, 'file' | 'directory'>()
      for (const path of disk.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        children.set(rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file')
      }
      return Promise.resolve([...children].map(([name, type]) => ({ name, type, target: `${prefix}${name}`, ...type === 'file' ? { size: 10 } : {} })))
    }),
    stat: vi.fn((target: string) => Promise.resolve(disk.has(target) ? { type: 'file', version: '1' } : target === '/work/src' ? { type: 'directory', version: '1' } : undefined)),
    readText: vi.fn((target: string) => target.endsWith('b.ts') ? Promise.reject(new Error('EACCES')) : Promise.resolve(disk.get(target)!)),
    writeText: vi.fn((target: string, text: string, _intent?: unknown, _signal?: AbortSignal, _policy?: unknown) => { disk.set(target, text); return Promise.resolve({ operation: 'create', version: '1' }) }),
  }
  ctx.provide('fs', fs as never)
  const route = setup.sessionRoute ?? { provider: 'session-p', model: 'session-m' }
  ctx.provide('sessions', { get: () => ({ requestHeader: () => ({ config: route }) }) } as never)
  if (setup.defaultModel !== 'none') {
    const selection = setup.defaultModel ?? { provider: 'default-p', model: 'default-m' }
    ctx.provide('agentDefaultModel', { currentSelection: () => selection } as never)
  }
  const calls: Array<{ provider: string; model: string }> = []
  ctx.provide('llm', {
    prepareCall: (call: { provider: string; model: string }) => {
      calls.push({ provider: call.provider, model: call.model })
      return Promise.resolve({
        config: call,
        stream: async function* (_options: GenerateOptions): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', index: 0, text: 'SUMMARY: Holds a.\n## Purpose\nA.' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })
    },
  } as never)
  const warn = vi.spyOn(ctx.logger, 'warn')
  let host: ReturnType<typeof registerCodebaseDocs>
  await ctx.plugin({ inject: ['fs'], apply: (scope) => { host = registerCodebaseDocs(scope, { ...CodebaseDocsConfigSchema(undefined), ...setup.config }) } })
  const session = (id: string, header: object = { cwd: '/work' }) => ({ id: SessionId(id), header })
  return { ctx, disk, fs, calls, warn, host: host!, session }
}

describe('codebase docs wiring', () => {
  it('documents a project when a top-level Session opens in it, on the default model', async () => {
    const { ctx, disk, fs, calls, warn, session } = await fixture()
    ctx.emit('session/created', session('s1') as never)
    await vi.waitFor(() => { expect(disk.get('/work/codebase_docs/INDEX.md')).toContain('src/a.ts') })
    expect(calls).toEqual([{ provider: 'default-p', model: 'default-m' }])
    expect(disk.get('/work/codebase_docs/src/a.ts.md')).toContain('> Holds a.')
    expect(disk.get('/work/codebase_docs/.gitignore')).toBe('*\n')
    // Every write is confined to the documented project.
    expect(fs.writeText.mock.calls.every(call => JSON.stringify(call[4]) === JSON.stringify({ mode: 'workspace-write', workspaceRoot: '/work' }))).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    // Delegated Sessions and Sessions without a working directory start nothing.
    ctx.emit('session/created', session('sub', { cwd: '/work', origin: 'subagent' }) as never)
    ctx.emit('session/created', session('deep', { cwd: '/work', delegationDepth: 1 }) as never)
    ctx.emit('session/created', session('nowhere', {}) as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toHaveLength(1)
  })

  it('uses the configured route over the default model', async () => {
    const { ctx, calls, session } = await fixture({ config: { provider: 'cfg-p', model: 'cfg-m' } })
    ctx.emit('session/created', session('s1') as never)
    await vi.waitFor(() => { expect(calls).toEqual([{ provider: 'cfg-p', model: 'cfg-m' }]) })
  })

  it('waits for the Session\'s first request when no route is known at creation', async () => {
    const { ctx, calls, session } = await fixture({ defaultModel: { provider: '', model: '' } })
    const s1 = session('s1')
    ctx.emit('session/created', s1 as never)
    ctx.emit('session/event', s1 as never, { type: 'turn/start', seq: 1, data: { turn: 1 } } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toHaveLength(0)
    ctx.emit('session/event', s1 as never, { type: 'request/header', seq: 2, data: {} } as never)
    await vi.waitFor(() => { expect(calls).toEqual([{ provider: 'session-p', model: 'session-m' }]) })
    // A later header of the same Session starts nothing new.
    ctx.emit('session/event', s1 as never, { type: 'request/header', seq: 3, data: {} } as never)
    const s2 = session('s2')
    ctx.emit('session/created', s2 as never)
    ctx.emit('session/disposed', s2 as never)
    ctx.emit('session/event', s2 as never, { type: 'request/header', seq: 1, data: {} } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toHaveLength(1)
  })

  it('keeps waiting when neither the default model nor the Session names a route', async () => {
    const { ctx, calls, session } = await fixture({ defaultModel: 'none', sessionRoute: { provider: '', model: '' } })
    const s1 = session('s1')
    ctx.emit('session/created', s1 as never)
    ctx.emit('session/event', s1 as never, { type: 'request/header', seq: 1, data: {} } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls).toHaveLength(0)
  })

  it('refreshes a turn\'s files on the Session\'s route, or the default model, or not at all', async () => {
    const { calls, host, disk } = await fixture({ defaultModel: 'none' })
    host.refresh(SessionId('s1'), '/work', ['src/a.ts'])
    await vi.waitFor(() => { expect(calls).toEqual([{ provider: 'session-p', model: 'session-m' }]) })
    await vi.waitFor(() => { expect(disk.has('/work/codebase_docs/src/a.ts.md')).toBe(true) })
    const blank = await fixture({ defaultModel: { provider: 'default-p', model: 'default-m' }, sessionRoute: { provider: '', model: '' } })
    blank.host.refresh(SessionId('s1'), '/work', ['src/a.ts'])
    await vi.waitFor(() => { expect(blank.calls).toEqual([{ provider: 'default-p', model: 'default-m' }]) })
    const none = await fixture({ defaultModel: 'none', sessionRoute: { provider: '', model: '' } })
    none.host.refresh(SessionId('s1'), '/work', ['src/a.ts'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(none.calls).toHaveLength(0)
  })

  it('logs a project that cannot be listed', async () => {
    const { ctx, fs, warn, session } = await fixture()
    fs.listDir.mockRejectedValueOnce(new Error('EACCES'))
    ctx.emit('session/created', session('s1') as never)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('codebase-docs: /work: Error: EACCES') })
  })

  it('reads an unreadable or absent file as no text, and registers nothing when disabled', async () => {
    const { host } = await fixture()
    const signal = new AbortController().signal
    expect(await host.docs.baseline('/work', ['src/dir/b.ts', 'src/missing.ts'], signal)).toEqual({ index: undefined, docs: {} })
    const off = await fixture({ config: { enabled: false } })
    expect(off.host).toBeUndefined()
  })
})
