/**
 * Injected face shared by the header meter and the composer nudge. The
 * target slots are declared and typed by ui-conversation; this package only
 * contributes entries. The drift value itself arrives through
 * `useProjection('contextDrift')`.
 */

import type { NudgeDismissal } from './model.ts'

/** Session-bound actions of the drift surfaces. */
export interface DriftInjected {
  /**
   * Run `/compact` in the bound session.
   * @returns null when the command succeeded; a user-visible failure line otherwise.
   */
  compact: () => Promise<string | null>
  /**
   * Open a new chat whose draft summarizes the bound session through a `#` reference.
   * @param label - display label of the reference.
   */
  newChat: (label: string) => void
  /**
   * Read the bound session's stored nudge dismissal.
   * @returns the dismissal, or null when none is stored or storage is unavailable.
   */
  readDismissal: () => NudgeDismissal | null
  /**
   * Store or clear the bound session's nudge dismissal; storage failures are ignored.
   * @param value - dismissal to store, or null to clear it.
   */
  writeDismissal: (value: NudgeDismissal | null) => void
}
