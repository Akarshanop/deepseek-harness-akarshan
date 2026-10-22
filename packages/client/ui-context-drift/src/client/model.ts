/**
 * Pure browser-side helpers of the drift surfaces: the session-reference
 * mention a new chat starts from, nudge dismissal arming, and compact token
 * formatting. No React and no services.
 */

import type { ContextDriftProjection } from '@deepseek-ai/dsh-context-drift/client'

/** URI scheme of a summarized session reference, owned by dsh-session-reference. */
const SESSION_REFERENCE_SCHEME = 'dsh-session:'

/**
 * Encode a session id as the canonical `dsh-session:` URI: unpadded
 * base64url of the UTF-8 JSON string, matching the host encoder byte for byte.
 * @param sessionId - opaque session id.
 * @returns canonical session-reference URI.
 */
export function sessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64url = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return `${SESSION_REFERENCE_SCHEME}${base64url}`
}

/**
 * Render the `#` mention that makes the host summarize a session into a new chat.
 * @param sessionId - the session to carry over.
 * @param label - display label; backslashes and closing brackets are escaped.
 * @returns `#[label](dsh-session:…)` mention text.
 */
export function summarizedSessionMention(sessionId: string, label: string): string {
  const escaped = label.replace(/[\\\]]/gu, match => `\\${match}`)
  return `#[${escaped}](${sessionReferenceUri(sessionId)})`
}

/** A dismissed nudge, remembered per session against one drift baseline. */
export interface NudgeDismissal {
  /** Baseline checkpoint seq the dismissal applies to. */
  readonly baselineSeq: number
}

/**
 * Whether the composer nudge should show for a drift value.
 * @param drift - current drift value.
 * @param dismissal - stored dismissal, if any.
 * @returns true when drift is high and not dismissed for this baseline.
 */
export function nudgeVisible(drift: ContextDriftProjection, dismissal: NudgeDismissal | null): boolean {
  if (drift.level !== 'high' || drift.action === 'none') return false
  return dismissal === null || dismissal.baselineSeq !== drift.baseline.seq
}

/**
 * Whether a stored dismissal has expired: the score fell below the re-arm
 * threshold or a compaction moved the baseline.
 * @param drift - current drift value.
 * @param dismissal - stored dismissal.
 * @returns true when the dismissal should be cleared.
 */
export function dismissalExpired(drift: ContextDriftProjection, dismissal: NudgeDismissal): boolean {
  return drift.score < drift.thresholds.rearm || dismissal.baselineSeq !== drift.baseline.seq
}

/** Locale templates for compact token counts. */
export interface TokenFormat {
  thousand: (value: string) => string
  million: (value: string) => string
}

/**
 * Format a token count compactly (`950`, `52k`, `1.2M`).
 * @param value - token count.
 * @param format - localized K/M templates.
 * @returns compact localized count.
 */
export function formatTokens(value: number, format: TokenFormat): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return format.thousand(scaled(value / 1_000))
  return format.million(scaled(value / 1_000_000))
}
