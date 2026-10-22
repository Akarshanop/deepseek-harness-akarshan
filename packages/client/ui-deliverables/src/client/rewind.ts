/** The files side of a Chat rewind, served by the Host rewind route. */
import type { ChatRewindFiles } from '@deepseek-ai/dsh-client-ui-chat/client'
import { changesRewindUrl, isChangesRewindPreview, isChangesRewindResult } from '../changes.ts'

/** Reads the rewind preview and puts files back through the authenticated rewind route. */
export const chatRewindFiles: ChatRewindFiles = {
  preview: async (sessionId, turn, signal) => {
    const response = await fetch(changesRewindUrl(sessionId, turn), { signal })
    if (!response.ok) throw new Error(`rewind preview answered ${response.status}`)
    const value: unknown = await response.json()
    if (!isChangesRewindPreview(value)) throw new Error('rewind preview is malformed')
    return value
  },
  restore: async (sessionId, turn) => {
    const response = await fetch(changesRewindUrl(sessionId, turn), { method: 'POST' })
    if (response.status === 409) return { kind: 'running' }
    if (!response.ok) throw new Error(`rewind answered ${response.status}`)
    const value: unknown = await response.json()
    if (!isChangesRewindResult(value)) throw new Error('rewind result is malformed')
    return { kind: 'restored', skipped: value.skipped }
  },
}
