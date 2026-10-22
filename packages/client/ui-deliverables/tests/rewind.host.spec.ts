/** The rewind route: the conversation cut point before a turn, the file plan, and the restore refused while a turn runs. */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkspaceRewindPlan, WorkspaceRewindResult } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHANGES_REWIND_PATH, changesRewindUrl, isChangesRewindPreview, isChangesRewindResult,
} from '../src/changes.ts'
import { registerRewind, rewindBoundary } from '../src/rewind-host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A log of the given event types; `turn/start` and `turn/end` carry the listed turn numbers in order. */
function log(...types: Array<string | [string, number]>): SessionEvent[] {
  return types.map((entry, seq) => {
    const [type, turn] = typeof entry === 'string' ? [entry, 0] : entry
    return { seq, type, data: { turn }, surfaceOp: type === 'user/message' ? 'append' : undefined } as never
  })
}

const events = log(
  'permission/preset', 'sandbox/mode', 'agent/inbox/spliced', ['turn/start', 1], 'user/message', ['turn/end', 1],
  'workspace/changes', 'session/title', 'agent/inbox/spliced', ['turn/start', 2], 'user/message', ['turn/end', 2],
)

describe('rewindBoundary', () => {
  it('cuts after the previous turn and its standalone events, before the prompt was queued', () => {
    expect(rewindBoundary(events, 2)).toBe(7)
    expect(rewindBoundary(events, 1)).toBe(1)
    expect(rewindBoundary(events, 3)).toBeUndefined()
    expect(rewindBoundary(log(['turn/start', 1]), 1)).toBeUndefined()
    // A prompt appended directly, or a turn opened without a queued prompt, also ends the kept prefix.
    expect(rewindBoundary(log(['turn/end', 1], 'session/title', 'user/message', ['turn/start', 2]), 2)).toBe(1)
    expect(rewindBoundary(log(['turn/end', 1], ['turn/start', 2], ['turn/end', 2], ['turn/start', 3]), 3)).toBe(2)
    // A replacement user message is a compaction rewrite, not a new prompt.
    const rewritten = log(['turn/end', 1], 'user/message', ['turn/start', 2])
    rewritten[1] = { ...rewritten[1], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as never
    expect(rewindBoundary(rewritten, 2)).toBe(1)
  })
})

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const observeSession = vi.fn(async (sessionId: SessionId) => {
    if (sessionId !== 'owner') throw new Error('missing')
    return { events, [Symbol.dispose]: () => undefined }
  })
  ctx.provide('sessionQuery', { observeSession } as never)
  const plan: WorkspaceRewindPlan = { files: ['a.txt'], oversized: ['big.bin'], incomplete: false, shellUntracked: true }
  const result: WorkspaceRewindResult = { restored: ['a.txt'], skipped: [{ display: 'big.bin', reason: 'oversized' }], incomplete: false }
  const rewind = vi.fn(async () => result)
  ctx.provide('workspaceChanges', { rewindPlan: () => plan, rewind } as never)
  let status = 'idle'
  ctx.provide('agents', { get: () => ({ status }) } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  await ctx.plugin({ inject: ['connection', 'sessionQuery', 'workspaceChanges'], apply: registerRewind })
  const handler = connection.createSharedFetchHandler('/api')
  const call = (query: string, method = 'GET') => handler.fetch(new Request(`http://localhost${CHANGES_REWIND_PATH}${query}`, { method }))
  return { call, plan, result, rewind, setStatus: (next: string) => { status = next } }
}

describe('rewind route', () => {
  it('previews the cut point and the plan, and restores only while no turn runs', async () => {
    const { call, plan, result, rewind, setStatus } = await fixture()
    const preview: unknown = await (await call('?sessionId=owner&turn=2')).json()
    expect(preview).toEqual({ ...plan, atSeq: 7, running: false })
    expect(isChangesRewindPreview(preview)).toBe(true)
    expect(await (await call('?sessionId=owner&turn=9')).json()).toMatchObject({ atSeq: null })

    setStatus('running')
    expect(await (await call('?sessionId=owner&turn=2')).json()).toMatchObject({ running: true })
    expect((await call('?sessionId=owner&turn=2', 'POST')).status).toBe(409)
    expect(rewind).not.toHaveBeenCalled()

    setStatus('idle')
    const restored: unknown = await (await call('?sessionId=owner&turn=2', 'POST')).json()
    expect(restored).toEqual(result)
    expect(isChangesRewindResult(restored)).toBe(true)
    expect(rewind).toHaveBeenCalledWith('owner', 2, expect.any(AbortSignal))
  })

  it('rejects malformed coordinates and answers 404 for an unreadable Session', async () => {
    const { call } = await fixture()
    for (const query of ['', '?sessionId=owner', '?sessionId=owner&turn=0', '?sessionId=owner&turn=x', '?turn=1']) {
      expect((await call(query)).status).toBe(400)
    }
    expect((await call('?sessionId=other&turn=1')).status).toBe(404)
  })

  it('validates what the browser reads and builds its coordinates', () => {
    expect(changesRewindUrl(SessionId('a b'), 3)).toBe('api/changes.rewind?sessionId=a+b&turn=3')
    const plan = { running: false, files: [], oversized: [], incomplete: false, shellUntracked: false }
    expect(isChangesRewindPreview({ ...plan, atSeq: -1 })).toBe(false)
    expect(isChangesRewindPreview(null)).toBe(false)
    expect(isChangesRewindResult({ restored: [], skipped: [{ display: 'x', reason: 'other' }], incomplete: false })).toBe(false)
    expect(isChangesRewindResult([])).toBe(false)
  })
})
