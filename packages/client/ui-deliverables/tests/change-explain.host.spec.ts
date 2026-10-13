/** The Host wiring of change explanations: the authenticated route, the model route a request runs on, the eager start, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANGES_EXPLAIN_PATH, changesExplainUrl } from '../src/changes.ts'
import type { ExplainConfig } from '../src/explain.ts'
import { assertExplainConfig, ExplainConfigSchema, registerChangeExplain } from '../src/explain-host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const defaults = (): ExplainConfig => ExplainConfigSchema(undefined)
const ANSWER = 'PURPOSE: Holds the library helpers.\nCHANGES:\n- Renames `start` to `boot`.'
const EXPLANATION = { purpose: 'Holds the library helpers.', changes: ['Renames `start` to `boot`.'] }

const summary: WorkspaceChangesSummary = {
  turn: 1, cwd: '/work', total: 3, added: 2, deleted: 1,
  files: [
    { path: 'src/lib/a.ts', display: 'src/lib/a.ts', added: 1, deleted: 1 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
    { path: 'src/new.ts', display: 'src/new.ts', added: 1, deleted: 0 },
  ],
}
const comparison: Extract<WorkspaceFileDiff, { kind: 'text' }> = {
  kind: 'text', path: 'src/lib/a.ts', display: 'src/lib/a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-start', '+boot'] }],
}

interface Setup {
  config?: Partial<ExplainConfig>
  /** Chunks the fake model streams, or a function that makes the stream. */
  stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** Model metadata the route reports to the call configuration. */
  modelInfo?: unknown
  sessions?: 'live' | 'unknown' | 'blank-route' | 'none'
  llm?: boolean
  /** Serve the model through the real runtime with this adapter, instead of the fake call preparation. */
  adapter?: LlmAdapter
  read?: () => Promise<{ text: string }>
}

async function* answer(text: string): AsyncGenerator<StreamChunk> {
  yield { type: 'reasoning-delta', index: 0, text: 'thinking…' }
  yield { type: 'text-delta', index: 1, text: text.slice(0, 10) }
  yield { type: 'text-delta', index: 1, text: text.slice(10) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function fixture(setup: Setup = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const summaryOf = vi.fn((sessionId: SessionId, seq: number) => sessionId === 'owner' && seq === 9 ? summary : undefined)
  const created: WorkspaceFileDiff = { ...comparison, path: 'src/new.ts', display: 'src/new.ts', before: false }
  const diffOf = vi.fn((sessionId: SessionId, seq: number, index: number, _signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> =>
    Promise.resolve(sessionId === 'owner' && seq === 9 ? index === 0 ? comparison : created : undefined))
  ctx.provide('workspaceChanges', { summary: summaryOf, diff: diffOf })
  const read = vi.fn(setup.read ?? (() => Promise.resolve({ text: 'export const start = 1\n' })))
  ctx.provide('workspaceFiles', { read } as never)
  const header = setup.sessions === 'blank-route' ? { config: { provider: '', model: '' } } : { config: { provider: 'gateway', model: 'minimax-m3' } }
  const get = vi.fn((id: SessionId) => setup.sessions === 'none' || setup.sessions === 'unknown' || id !== 'owner' ? undefined
    : { requestHeader: () => header })
  if (setup.sessions !== 'none') ctx.provide('sessions', { get } as never)
  const streamed: GenerateOptions[] = []
  const prepareCall = vi.fn(async (call: { provider: string; model: string; maxTokens?: number }, _signal: AbortSignal | undefined,
    configure?: (controls: object, model: unknown) => object) => {
    const { provider, model, ...controls } = call
    return {
      config: { provider, model, ...configure === undefined ? controls : configure(controls, setup.modelInfo ?? {}) },
      stream: (options: GenerateOptions) => { streamed.push(options); return (setup.stream ?? (() => answer(ANSWER)))(options) },
    }
  })
  if (setup.adapter !== undefined) {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['gateway'], setup.adapter)
  } else if (setup.llm !== false) ctx.provide('llm', { prepareCall } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const config = { ...defaults(), ...setup.config }
  await ctx.plugin({ inject: ['connection', 'workspaceChanges', 'workspaceFiles'], apply: (scope) => { registerChangeExplain(scope, config) } })
  const handler = connection.createSharedFetchHandler('/api')
  const explain = (query = '?sessionId=owner&seq=9&index=0', init?: RequestInit) =>
    handler.fetch(new Request(`http://localhost${CHANGES_EXPLAIN_PATH}${query}`, init))
  return { ctx, handler, explain, prepareCall, streamed, read, get, summaryOf, diffOf, config }
}

/** Emit the event a Session announces when a turn's changes are recorded. */
function announce(ctx: Context, sessionId: string, seq: number, type = 'workspace/changes'): void {
  ctx.emit('session/event', { id: sessionId } as never, { type, seq, data: { turn: 1 } } as never)
}

describe('explanation route', () => {
  it('writes the explanation on the Session\'s current route and serves it, then serves the same one from memory', async () => {
    const { explain, prepareCall, streamed, read } = await fixture()
    expect(changesExplainUrl(SessionId('owner'), 9, 0)).toBe('api/changes.explain?sessionId=owner&seq=9&index=0')
    const response = await explain()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(EXPLANATION)
    expect(prepareCall).toHaveBeenCalledTimes(1)
    expect(prepareCall.mock.calls[0]![0]).toEqual({ provider: 'gateway', model: 'minimax-m3', maxTokens: 4096 })
    expect(read).toHaveBeenCalledWith({ sessionId: 'owner', workspaceRoot: '/work' }, 'src/lib/a.ts', { offset: 1, limit: 120 }, expect.any(AbortSignal))
    const options = streamed[0]!
    expect(options).toMatchObject({ provider: 'gateway', model: 'minimax-m3', maxTokens: 4096 })
    expect(options.system).toContain('Answer in English')
    expect(options.messages).toHaveLength(1)
    const [message] = options.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    expect(message!.role).toBe('user')
    expect(message!.content[0]!.text).toContain('File: src/lib/a.ts')
    expect(message!.content[0]!.text).toContain('-start\n+boot')
    expect(message!.content[0]!.text).toContain('Beginning of the file as it now stands:\nexport const start = 1')
    expect(await (await explain()).json()).toEqual(EXPLANATION)
    expect(prepareCall).toHaveBeenCalledTimes(1)
  })

  it('asks for the route\'s least supported reasoning effort so the output cap is not spent thinking', async () => {
    const low = await fixture({ modelInfo: { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } })
    expect((await low.explain()).status).toBe(200)
    expect(low.streamed[0]).toMatchObject({ reasoningEffort: 'low' })
    const none = await fixture({ modelInfo: { reasoning: { efforts: [] } } })
    expect((await none.explain()).status).toBe(200)
    expect(none.streamed[0]).not.toHaveProperty('reasoningEffort')
  })

  it('runs on the configured route instead of the Session\'s when one is set', async () => {
    const { explain, prepareCall, get } = await fixture({ config: { provider: 'cheap', model: 'small', maxOutputTokens: 900, language: 'Chinese' } })
    expect((await explain()).status).toBe(200)
    expect(prepareCall.mock.calls[0]![0]).toEqual({ provider: 'cheap', model: 'small', maxTokens: 900 })
    expect(get).not.toHaveBeenCalled()
  })

  it('explains a created file from its comparison alone, without reading the file', async () => {
    const { explain, read, streamed } = await fixture()
    expect((await explain('?sessionId=owner&seq=9&index=2')).status).toBe(200)
    expect(read).not.toHaveBeenCalled()
    expect(JSON.stringify(streamed[0]!.messages)).toContain('Change: created')
  })

  it('explains from the comparison alone when the file cannot be read as text', async () => {
    const { explain, streamed } = await fixture({ read: () => Promise.reject(new Error('not text')) })
    expect((await explain()).status).toBe(200)
    expect(JSON.stringify(streamed[0]!.messages)).not.toContain('Beginning of the file')
  })

  it('answers 400 for bad coordinates and 404 for what has nothing to explain', async () => {
    const { explain, prepareCall } = await fixture()
    for (const bad of ['', '?sessionId=owner&seq=9', '?sessionId=owner&seq=x&index=0', '?seq=9&index=0']) {
      expect((await explain(bad)).status, bad).toBe(400)
    }
    for (const gone of ['?sessionId=owner&seq=8&index=0', '?sessionId=other&seq=9&index=0', '?sessionId=owner&seq=9&index=1', '?sessionId=owner&seq=9&index=7']) {
      expect((await explain(gone)).status, gone).toBe(404)
    }
    expect(prepareCall).not.toHaveBeenCalled()
  })

  it('answers 500 with the reason when the model fails, and writes the explanation again on the next request', async () => {
    const failures: Array<() => AsyncIterable<StreamChunk>> = [
      () => (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'gateway down', code: 'X' } } }
      })(),
      () => (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cut off', code: 'Y' } } }
      })(),
      () => (async function* (): AsyncGenerator<StreamChunk> { throw new Error('socket closed') })(),
    ]
    let attempt = 0
    const { explain, prepareCall } = await fixture({
      stream: () => {
        const failure = failures[attempt]
        attempt += 1
        return failure === undefined ? answer(ANSWER) : failure()
      },
    })
    for (const reason of ['gateway down', 'cut off', 'socket closed']) {
      const response = await explain()
      expect(response.status).toBe(500)
      expect(await response.text()).toBe(`Change explanation failed: ${reason}`)
    }
    expect(await (await explain()).json()).toEqual(EXPLANATION)
    expect(prepareCall).toHaveBeenCalledTimes(4)
  })

  it('names a failure that is not an Error by its text', async () => {
    const { explain } = await fixture({ stream: () => (async function* (): AsyncGenerator<StreamChunk> { throw 'plain text failure' })() })
    const response = await explain()
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Change explanation failed: plain text failure')
  })

  it('answers 500 when no model, no route, or no usable answer is available', async () => {
    for (const setup of [{ llm: false }, { sessions: 'unknown' as const }, { sessions: 'none' as const }, { sessions: 'blank-route' as const }]) {
      const { explain } = await fixture(setup)
      const response = await explain()
      expect(response.status, JSON.stringify(setup)).toBe(500)
      expect(await response.text()).toMatch(/change-explain: no model (service|route)/)
    }
    const empty = await fixture({ stream: () => answer('   ') })
    const response = await empty.explain()
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('no text')
  })

  it('registers nothing when explanations are disabled', async () => {
    const { explain, prepareCall } = await fixture({ config: { enabled: false } })
    expect((await explain()).status).toBe(404)
    expect(prepareCall).not.toHaveBeenCalled()
  })
})

describe('real model runtime', () => {
  /** An adapter that advertises two reasoning efforts and records what it is asked. */
  class StubAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []

    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({
        provider, id: model, name: model,
        reasoning: { efforts: [{ id: ReasoningEffortId('minimal'), name: 'Minimal' }, { id: ReasoningEffortId('high'), name: 'High' }] },
      })
    }

    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      yield { type: 'text-delta', index: 0, text: ANSWER }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  it('dispatches the request the runtime prepared, at the route\'s least supported reasoning effort', async () => {
    const adapter = new StubAdapter()
    const { explain } = await fixture({ adapter })
    const response = await explain()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(EXPLANATION)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'gateway', model: 'minimax-m3', maxTokens: 4096, reasoningEffort: 'minimal' })
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('File: src/lib/a.ts')
  })

  it('fails the request, not the plugin, when the route is not registered with the runtime', async () => {
    const { explain } = await fixture({ adapter: new StubAdapter(), config: { provider: 'unregistered', model: 'm' } })
    const response = await explain()
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('Change explanation failed')
  })
})

describe('eager start', () => {
  it('writes the first files of a recorded turn without a request, so the route finds them ready', async () => {
    const { ctx, explain, prepareCall } = await fixture({ config: { eagerFiles: 1 } })
    announce(ctx, 'owner', 9, 'turn/start')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(prepareCall).not.toHaveBeenCalled()
    announce(ctx, 'owner', 9)
    await vi.waitFor(() => { expect(prepareCall).toHaveBeenCalledTimes(1) })
    expect(await (await explain()).json()).toEqual(EXPLANATION)
    expect(prepareCall).toHaveBeenCalledTimes(1)
    // The second file was beyond the eager limit and is written on request.
    expect((await explain('?sessionId=owner&seq=9&index=2')).status).toBe(200)
    expect(prepareCall).toHaveBeenCalledTimes(2)
  })

  it('finds the summary one microtask after the event, as the recorder keeps it only after appending', async () => {
    const { ctx, prepareCall, summaryOf } = await fixture({ config: { eagerFiles: 1 } })
    let kept = false
    summaryOf.mockImplementation((sessionId, seq) => kept && sessionId === 'owner' && seq === 9 ? summary : undefined)
    announce(ctx, 'owner', 9)
    kept = true
    await vi.waitFor(() => { expect(prepareCall).toHaveBeenCalledTimes(1) })
  })

  it('reports an eager failure through the logger and leaves the file to be written on request', async () => {
    let attempt = 0
    const { ctx, explain, prepareCall } = await fixture({
      config: { eagerFiles: 1 },
      stream: () => attempt++ === 0 ? (async function* (): AsyncGenerator<StreamChunk> { throw new Error('rate limited') })() : answer(ANSWER),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    announce(ctx, 'owner', 9)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('change-explain: Error: rate limited') })
    expect((await explain()).status).toBe(200)
    expect(prepareCall).toHaveBeenCalledTimes(2)
  })

  it('cancels the writing of a disposed Session\'s explanations and of every explanation on teardown', async () => {
    const aborted: AbortSignal[] = []
    const hang = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      aborted.push(options.signal!)
      return (async function* (): AsyncGenerator<StreamChunk> {
        await new Promise<void>((_resolve, reject) => { options.signal!.addEventListener('abort', () => { reject(new Error('cancelled')) }) })
      })()
    }
    const { ctx, prepareCall } = await fixture({ config: { eagerFiles: 1 }, stream: hang })
    announce(ctx, 'owner', 9)
    await vi.waitFor(() => { expect(prepareCall).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(aborted).toHaveLength(1) })
    ctx.emit('session/disposed', { id: 'owner' } as never)
    await vi.waitFor(() => { expect(aborted[0]!.aborted).toBe(true) })
    const second = await fixture({ config: { eagerFiles: 1 }, stream: hang })
    announce(second.ctx, 'owner', 9)
    await vi.waitFor(() => { expect(second.streamed).toHaveLength(1) })
    await second.ctx.fiber.dispose()
    expect(aborted[1]!.aborted).toBe(true)
  })
})

describe('explanation settings', () => {
  it('defaults every setting and leaves the route unset', () => {
    expect(defaults()).toEqual({
      enabled: true, eagerFiles: 20, concurrency: 2, maxDiffChars: 24_000, contextLines: 120, maxOutputTokens: 4096,
      timeoutMs: 120_000, language: 'English',
    })
    expect(() => { assertExplainConfig(defaults()) }).not.toThrow()
    expect(() => { assertExplainConfig({ ...defaults(), eagerFiles: 0, provider: 'p', model: 'm' }) }).not.toThrow()
  })

  it('fails loudly on an unusable count, limit, timeout, or half a route', () => {
    for (const field of ['eagerFiles', 'concurrency', 'maxDiffChars', 'contextLines', 'maxOutputTokens', 'timeoutMs'] as const) {
      for (const value of [-1, 1.5, Number.NaN]) {
        expect(() => { assertExplainConfig({ ...defaults(), [field]: value }) }, `${field}=${value}`).toThrow(`explain.${field}`)
      }
    }
    for (const field of ['concurrency', 'maxDiffChars', 'contextLines', 'maxOutputTokens', 'timeoutMs'] as const) {
      expect(() => { assertExplainConfig({ ...defaults(), [field]: 0 }) }).toThrow('positive integer')
    }
    expect(() => { assertExplainConfig({ ...defaults(), eagerFiles: -1 }) }).toThrow('non-negative integer')
    expect(() => { assertExplainConfig({ ...defaults(), timeoutMs: 2_147_483_648 }) }).toThrow('must not exceed')
    expect(() => { assertExplainConfig({ ...defaults(), provider: 'p' }) }).toThrow('set together')
    expect(() => { assertExplainConfig({ ...defaults(), model: 'm' }) }).toThrow('set together')
  })
})
