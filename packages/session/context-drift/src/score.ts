/**
 * The drift formula: six normalized signals combined by a weighted
 * noisy-OR into a 0–100 score, with per-signal shares, a level, and a
 * recommended action. Pure function of its inputs and the resolved config.
 *
 * @module @deepseek-ai/dsh-context-drift/score
 */

import type { ResolvedContextDriftConfig } from './config.ts'
import type {
  ContextDriftAction,
  ContextDriftActionReason,
  ContextDriftBaseline,
  ContextDriftLevel,
  ContextDriftProjection,
  ContextDriftSignal,
} from './types.ts'

/** Counts the fold derives from the retained surface and its route records. */
export interface DriftInputs {
  readonly liveTokens: number
  readonly provider?: string
  readonly model?: string
  readonly contextWindow?: number
  readonly turns: number
  readonly toolErrors: number
  readonly corrections: number
  readonly loopWarnings: number
  readonly interrupts: number
  /** Non-system surface tokens. */
  readonly messageTokens: number
  /** Non-system surface tokens from earlier topics. */
  readonly staleTokens: number
  /** Tool-result surface tokens. */
  readonly toolTokens: number
  readonly compactions: number
  /** Human turns appended after the baseline checkpoint. */
  readonly turnsSinceBaseline: number
  readonly baseline: ContextDriftBaseline
  readonly degraded: boolean
}

/** Signal order used for shares and tie-breaking of the cause. */
const SIGNALS: readonly ContextDriftSignal[] = ['length', 'turns', 'mistakes', 'stale', 'noise', 'layers']

const clamp = (value: number): number => Math.min(1, Math.max(0, value))

/** Cubic S-curve on [0, 1]: 0 and 1 at the ends, 0.5 at the middle, flat at both ends. */
const smooth = (value: number): number => {
  const x = clamp(value)
  return x * x * (3 - 2 * x)
}

/**
 * Effective context of the current route: its profile when configured, else
 * the window-ratio share capped by the fallback, else the fallback; never
 * above the window-ratio share of a known window.
 * @param inputs - route identity and capacity.
 * @param config - resolved configuration.
 * @returns effective prompt tokens.
 */
export function effectiveTokens(
  inputs: Pick<DriftInputs, 'provider' | 'model' | 'contextWindow'>,
  config: ResolvedContextDriftConfig,
): number {
  const profile = config.modelProfiles.find(entry => entry.provider === inputs.provider && entry.model === inputs.model)
  const ceiling = inputs.contextWindow === undefined ? undefined : config.windowRatio * inputs.contextWindow
  const base = profile?.effectiveTokens
    ?? (ceiling === undefined ? config.fallbackEffectiveTokens : Math.min(ceiling, config.fallbackEffectiveTokens))
  return Math.max(1, Math.round(ceiling === undefined ? base : Math.min(base, ceiling)))
}

/**
 * Score one drift snapshot.
 * @param inputs - counts folded from the session.
 * @param config - resolved configuration.
 * @returns the complete `contextDrift` wire value.
 */
export function scoreDrift(inputs: DriftInputs, config: ResolvedContextDriftConfig): ContextDriftProjection {
  const effective = effectiveTokens(inputs, config)
  const onset = config.lengthOnsetRatio * effective
  const length = smooth((inputs.liveTokens - onset) / (effective - onset))
  const turns = smooth((inputs.turns - config.turnsOnset) / (config.turnsSaturation - config.turnsOnset))
  const weightedMistakes = config.mistakeWeights.toolError * inputs.toolErrors
    + config.mistakeWeights.correction * inputs.corrections
    + config.mistakeWeights.loopWarning * inputs.loopWarnings
    + config.mistakeWeights.interrupt * inputs.interrupts
  const mistakes = 1 - Math.exp(-weightedMistakes / config.mistakesScale)
  const staleShare = inputs.messageTokens === 0 ? 0 : inputs.staleTokens / inputs.messageTokens
  const toolShare = inputs.messageTokens === 0 ? 0 : inputs.toolTokens / inputs.messageTokens
  const stale = staleShare * length
  const noise = clamp((toolShare - config.toolShareOnset) / config.toolShareSpan) * length
  const layers = clamp((inputs.compactions - config.layersOnset) / config.layersSpan)

  const signals: Record<ContextDriftSignal, number> = { length, turns, mistakes, stale, noise, layers }
  // Noisy-OR in log space: each signal's -ln(1 - w·s) adds, so shares sum to the whole score.
  const logs = SIGNALS.map((signal) => {
    const value = -Math.log(1 - config.weights[signal] * signals[signal])
    // -ln(1) is -0, which the lossless JSON state check rejects.
    return value > 0 ? value : 0
  })
  const totalLog = logs.reduce((sum, value) => sum + value, 0)
  const score = Math.round(100 * (1 - Math.exp(-totalLog)))

  const shares: Record<ContextDriftSignal, number> = { length: 0, turns: 0, mistakes: 0, stale: 0, noise: 0, layers: 0 }
  let cause: ContextDriftSignal | undefined
  if (score > 0) {
    let best = -1
    SIGNALS.forEach((signal, index) => {
      const value = logs[index] ?? 0
      shares[signal] = Math.round(100 * value / totalLog)
      if (value > best) {
        best = value
        cause = signal
      }
    })
  }

  const level: ContextDriftLevel = score >= config.levels.high
    ? 'high'
    : score >= config.levels.drifting ? 'drifting' : 'fresh'
  const recommendation = recommend(level, cause, inputs, config)

  return {
    score,
    level,
    ...cause === undefined ? {} : { cause },
    action: recommendation.action,
    ...recommendation.reason === undefined ? {} : { actionReason: recommendation.reason },
    shares,
    readings: {
      liveTokens: Math.round(inputs.liveTokens),
      effectiveTokens: effective,
      ...inputs.contextWindow === undefined ? {} : { contextWindow: inputs.contextWindow },
      turns: inputs.turns,
      toolErrors: inputs.toolErrors,
      corrections: inputs.corrections,
      loopWarnings: inputs.loopWarnings,
      interrupts: inputs.interrupts,
      stalePercent: Math.round(100 * staleShare),
      toolOutputPercent: Math.round(100 * toolShare),
      compactions: inputs.compactions,
    },
    baseline: inputs.baseline,
    thresholds: { ...config.levels },
    ...inputs.degraded ? { degraded: true as const } : {},
  }
}

function recommend(
  level: ContextDriftLevel,
  cause: ContextDriftSignal | undefined,
  inputs: DriftInputs,
  config: ResolvedContextDriftConfig,
): { action: ContextDriftAction; reason?: ContextDriftActionReason } {
  if (level === 'fresh') return { action: 'none' }
  if (inputs.compactions >= config.newChatAfterCompactions) return { action: 'new-chat', reason: 'layers' }
  if (cause === 'stale') return { action: 'new-chat', reason: 'stale' }
  if (inputs.baseline.kind === 'compaction' && inputs.turnsSinceBaseline < config.recentCompactionTurns) {
    return { action: 'new-chat', reason: 'recent-compaction' }
  }
  return { action: 'compact', reason: 'cause' }
}
