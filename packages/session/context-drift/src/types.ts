/**
 * Pure types of the context-drift domain: the `contextDrift` wire value and
 * its `SessionProjectionMap` key merge, free of host-side value imports so
 * client programs can merge the key through `./client`.
 *
 * @module @deepseek-ai/dsh-context-drift/types
 */

// Marks this file a module so the declaration below augments the projection table.
export {}

/** Drift band derived from the score and the configured level thresholds. */
export type ContextDriftLevel = 'fresh' | 'drifting' | 'high'

/** One of the six scored signals; also names the dominant cause of a score. */
export type ContextDriftSignal = 'length' | 'turns' | 'mistakes' | 'stale' | 'noise' | 'layers'

/** What the drift view recommends the human do next. */
export type ContextDriftAction = 'none' | 'compact' | 'new-chat'

/**
 * Why {@link ContextDriftProjection.action} was chosen: `layers` when the
 * context already sits on too many compaction summaries, `stale` when old
 * topics dominate, `recent-compaction` when a compaction just ran and the
 * score is still high, `cause` for the default compact recommendation.
 */
export type ContextDriftActionReason = 'layers' | 'stale' | 'recent-compaction' | 'cause'

/** Raw readings behind the score, all whole numbers. */
export interface ContextDriftReadings {
  /** Next request's prompt tokens: provider-anchored when usage exists, heuristic otherwise. */
  liveTokens: number
  /** Effective context of the current route: where quality starts to fall. */
  effectiveTokens: number
  /** Advertised route capacity; absent when no adapter reported one. */
  contextWindow?: number
  /** Human-typed messages still in context. */
  turns: number
  /** Failed tool results still in context. */
  toolErrors: number
  /** Human corrections still in context. */
  corrections: number
  /** Repeat-tool-call warnings still in context. */
  loopWarnings: number
  /** Interrupted assistant replies still in context. */
  interrupts: number
  /** Percent of message tokens that belong to earlier topics (0–100). */
  stalePercent: number
  /** Percent of message tokens that are tool output (0–100). */
  toolOutputPercent: number
  /** Successful compactions in this session. */
  compactions: number
}

/** The point drift is measured from: session start or the newest compaction checkpoint. */
export interface ContextDriftBaseline {
  kind: 'session-start' | 'compaction'
  /** Durable seq of the checkpoint; 0 for session start. */
  seq: number
  /** Unix epoch milliseconds of the baseline event (session creation for session start). */
  time: number
}

/** Level thresholds the host resolved from configuration, shared with clients. */
export interface ContextDriftThresholds {
  /** Score at which the level becomes `drifting`. */
  drifting: number
  /** Score at which the level becomes `high` and clients may nudge. */
  high: number
  /** Score a high session must fall below before clients nudge again. */
  rearm: number
}

/**
 * Long-context quality-loss estimate for the next request. A deterministic
 * fold of the durable log; it counts only content still on the model-visible
 * surface, so compaction removes the shadowed history from every reading.
 */
export interface ContextDriftProjection {
  /** Combined drift, 0–100. */
  score: number
  level: ContextDriftLevel
  /** Signal with the largest share of the score; absent when the score is 0. */
  cause?: ContextDriftSignal
  action: ContextDriftAction
  /** Absent when {@link action} is `none`. */
  actionReason?: ContextDriftActionReason
  /** Each signal's share of the score in whole percent; all zero when the score is 0. */
  shares: Record<ContextDriftSignal, number>
  readings: ContextDriftReadings
  baseline: ContextDriftBaseline
  thresholds: ContextDriftThresholds
  /** Present when the fold met an inconsistent log entry and readings are approximate. */
  degraded?: true
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Long-context drift score, readings, and recommendation; see {@link ContextDriftProjection}. */
    contextDrift: ContextDriftProjection
  }
}
