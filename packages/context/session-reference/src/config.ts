/** Configuration and stable diagnostics for session references. */

/** Hard maximum references accepted by one message. */
export const MAX_REFERENCES = 3
/** Default number of discovery candidates returned to a host. */
export const DEFAULT_CANDIDATE_LIMIT = 50
/** Minimum automatic UTF-8 budget for one rendered reference JSON object. */
export const DEFAULT_MAX_REFERENCE_BYTES = 65_536
/** Largest delay a timer accepts; a longer deadline would fire at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Default fraction of the model context window one summarization request may read from a source. */
export const DEFAULT_COMPACT_CONTEXT_FRACTION = 0.5
/** Default output-token cap of one summarization request, covering any reasoning the route performs. */
export const DEFAULT_COMPACT_MAX_TOKENS = 4096
/** Default milliseconds one summarization request may take. */
export const DEFAULT_COMPACT_TIMEOUT_MS = 120_000

/** Session-reference service configuration. */
export interface Config {
  /** Maximum distinct source sessions referenced by one message, from one to three. */
  maxReferences?: number
  /** Default host candidate-list limit. */
  candidateLimit?: number
  /** Explicit maximum rendered UTF-8 bytes per source; absent uses the model-relative budget with a 64 KiB floor. */
  maxReferenceBytes?: number
  /** Fraction of the model context window per source, estimated at four bytes per token; between zero and one. */
  referenceContextFraction?: number
  /**
   * Fraction of the model context window, at four bytes per token with a 64 KiB floor, that the
   * summarization request for one `#` reference may read from its source; between zero and one.
   */
  compactContextFraction?: number
  /** Output-token cap of one summarization request, covering any reasoning the route performs. */
  compactMaxTokens?: number
  /** Milliseconds one summarization request may take before the message's preparation fails. */
  compactTimeoutMs?: number
}

/** Stable failure codes exposed to host adapters. */
export type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED'
  | 'SESSION_REFERENCE_COMPACT_FAILED'

/** Typed session-reference failure suitable for host protocol error mapping. */
export class SessionReferenceError extends Error {
  /** @param message Human-readable diagnosis. @param code Stable routing code. @param options Optional cause. */
  constructor(
    message: string,
    readonly code: SessionReferenceErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionReferenceError'
  }
}
