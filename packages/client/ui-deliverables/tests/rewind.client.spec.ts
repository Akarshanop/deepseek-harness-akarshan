/** The browser files side of a Chat rewind reads the preview and restores through the rewind route. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { chatRewindFiles } from '../src/client/rewind.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SESSION = SessionId('owner')
const preview = { atSeq: 7, running: false, files: ['a.txt'], oversized: [], incomplete: false, shellUntracked: false }

function stubFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const response of responses) fetch.mockResolvedValueOnce(response)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('chatRewindFiles', () => {
  it('reads a validated preview and refuses a failed or malformed one', async () => {
    const signal = new AbortController().signal
    const fetch = stubFetch(Response.json(preview), new Response('gone', { status: 404 }), Response.json({ atSeq: 'x' }))
    expect(await chatRewindFiles.preview(SESSION, 3, signal)).toEqual(preview)
    expect(fetch).toHaveBeenCalledWith('api/changes.rewind?sessionId=owner&turn=3', { signal })
    await expect(chatRewindFiles.preview(SESSION, 3, signal)).rejects.toThrow('404')
    await expect(chatRewindFiles.preview(SESSION, 3, signal)).rejects.toThrow('malformed')
  })

  it('restores, reports a running turn, and refuses a failed or malformed answer', async () => {
    const skipped = [{ display: 'big.bin', reason: 'oversized' }]
    const fetch = stubFetch(
      Response.json({ restored: ['a.txt'], skipped, incomplete: false }),
      new Response('running', { status: 409 }),
      new Response('broken', { status: 500 }),
      Response.json({ restored: 'a.txt' }),
    )
    expect(await chatRewindFiles.restore(SESSION, 3)).toEqual({ kind: 'restored', skipped })
    expect(fetch).toHaveBeenCalledWith('api/changes.rewind?sessionId=owner&turn=3', { method: 'POST' })
    expect(await chatRewindFiles.restore(SESSION, 3)).toEqual({ kind: 'running' })
    await expect(chatRewindFiles.restore(SESSION, 3)).rejects.toThrow('500')
    await expect(chatRewindFiles.restore(SESSION, 3)).rejects.toThrow('malformed')
  })
})
