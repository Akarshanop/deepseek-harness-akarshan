// @vitest-environment jsdom
/** The judgment store: served and missing judgments stay, failures and invalid records retry. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesJudgeUrl, type ChangesJudgment } from '../src/changes.ts'
import { ChangesJudgeStore } from '../src/client/changes-judge.ts'

afterEach(() => { vi.unstubAllGlobals() })

const SESSION = SessionId('viewed')
const URL_ = changesJudgeUrl(SESSION, 5, 1)
const judgment: ChangesJudgment = {
  verdict: 'pass', confidence: 90, summary: 'Fine.', issues: [], checks: [{ aspect: 'request', status: 'pass', note: '' }],
  suggestions: [], basis: { docs: true, request: true },
}

describe('ChangesJudgeStore', () => {
  it('keeps served and missing judgments and reads a failed or invalid one again', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesJudgeStore()
    expect(URL_).toBe('api/changes.judge?sessionId=viewed&seq=5&index=1')
    fetcher.mockResolvedValueOnce(Response.json(judgment))
    await store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toEqual(judgment)
    await store.load(SESSION, 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(new Response('nothing to judge', { status: 404 }))
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[changesJudgeUrl(SESSION, 5, 2)]).toBe('missing')
    const failing = changesJudgeUrl(SESSION, 5, 3)
    fetcher.mockResolvedValueOnce(Response.json({ ...judgment, confidence: 900 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json(judgment))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toEqual(judgment)
    await store.dispose()
  })
})
