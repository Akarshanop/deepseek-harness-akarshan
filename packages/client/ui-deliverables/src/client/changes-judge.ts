/** Cache of the model judgments the Host serves for listed changed files, read once per file and again after a failure. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesJudgeUrl, isChangesJudgment, type ChangesJudgment } from '../changes.ts'
import { HostReadStore, jsonReadPolicy } from './host-read-store.ts'

/**
 * A judgment, `'missing'` when the Host has none to give (a file with nothing to judge, or judgments composed out),
 * `'error'` for a failed read a later request retries, or `'loading'` while the Host writes it.
 */
export type ChangesJudgeState = ChangesJudgment | 'missing' | 'error' | 'loading'

/** One browser plugin's judgment reads; a failed read is the one state a later request replaces. */
export class ChangesJudgeStore extends HostReadStore<ChangesJudgeState> {
  constructor() {
    super(jsonReadPolicy(isChangesJudgment))
  }

  /**
   * Read one judgment; a cached or missing one is kept, a failed one is read again.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @param index - the file's index in the summary.
   * @returns after the state is published.
   */
  load(sessionId: SessionId, seq: number, index: number): Promise<void> {
    return this.loadUrl(changesJudgeUrl(sessionId, seq, index))
  }
}
