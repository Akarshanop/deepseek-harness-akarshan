// @vitest-environment jsdom
/** The explanation store: served and missing explanations stay, failures retry, resets and disposal forget. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesExplainUrl, isChangesExplanation, type ChangesExplanation } from '../src/changes.ts'
import { ChangesExplainStore } from '../src/client/changes-explain.ts'

afterEach(() => { vi.unstubAllGlobals() })

const SESSION = SessionId('viewed')
const URL_ = changesExplainUrl(SESSION, 5, 1)
const explanation: ChangesExplanation = { purpose: 'Wires the app.', changes: ['Renames `start`.'] }

describe('explanation addresses and records', () => {
  it('addresses one file of one announced summary and validates what the Host serves', () => {
    expect(URL_).toBe('api/changes.explain?sessionId=viewed&seq=5&index=1')
    expect(isChangesExplanation(explanation)).toBe(true)
    expect(isChangesExplanation({ purpose: '', changes: [] })).toBe(true)
    for (const bad of [null, 'text', [], {}, { purpose: 'p' }, { purpose: 1, changes: [] }, { purpose: 'p', changes: 'x' }, { purpose: 'p', changes: [1] }]) {
      expect(isChangesExplanation(bad)).toBe(false)
    }
  })
})

describe('ChangesExplainStore', () => {
  it('keeps served and missing explanations, retries failures, and forgets on reset and disposal', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesExplainStore()
    fetcher.mockResolvedValueOnce(Response.json(explanation))
    await store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toEqual(explanation)
    await store.load(SESSION, 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(new Response('nothing to explain', { status: 404 }))
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[changesExplainUrl(SESSION, 5, 2)]).toBe('missing')
    await store.load(SESSION, 5, 2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const failing = changesExplainUrl(SESSION, 5, 3)
    fetcher.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ purpose: 3 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toBe('error')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json(explanation))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[failing]).toEqual(explanation)
    store.reset()
    expect(store.state.getSnapshot()).toEqual({})
    let settle!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const stale = store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    store.reset()
    settle(Response.json(explanation))
    await stale
    expect(store.state.getSnapshot()[URL_]).toBeUndefined()
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const late = store.load(SESSION, 5, 1)
    const disposal = store.dispose()
    settle(Response.json(explanation))
    await Promise.all([late, disposal])
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    await store.load(SESSION, 6, 0)
    expect(store.state.getSnapshot()[changesExplainUrl(SESSION, 6, 0)]).toBeUndefined()
  })
})
