/** Cache of the model-written explanations the Host serves for listed changed files, read once per file and again after a failure. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesExplainUrl, isChangesExplanation, type ChangesExplanation } from '../changes.ts'
import { HostReadStore, jsonReadPolicy } from './host-read-store.ts'

/**
 * An explanation, `'missing'` when the Host has none to give (a file with nothing to explain, or explanations
 * composed out), `'error'` for a failed read a later request retries, or `'loading'` while the Host writes it.
 */
export type ChangesExplainState = ChangesExplanation | 'missing' | 'error' | 'loading'

/** One browser plugin's explanation reads; a failed read is the one state a later request replaces. */
export class ChangesExplainStore extends HostReadStore<ChangesExplainState> {
  constructor() {
    super(jsonReadPolicy(isChangesExplanation))
  }

  /**
   * Read one explanation; a cached or missing one is kept, a failed one is read again.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @param index - the file's index in the summary.
   * @returns after the state is published.
   */
  load(sessionId: SessionId, seq: number, index: number): Promise<void> {
    return this.loadUrl(changesExplainUrl(sessionId, seq, index))
  }
}
