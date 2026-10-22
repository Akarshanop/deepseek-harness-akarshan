/**
 * Load-time configuration for the context-drift projection: every tunable of
 * the drift formula, validated once and frozen.
 *
 * @module @deepseek-ai/dsh-context-drift/config
 */

import type { ContextDriftSignal } from './types.ts'

/** Exact provider/model override of the effective context. */
export interface ModelProfileConfig {
  /** Exact provider id of the route, as logged in `request/context`. */
  provider: string
  /** Exact model id of the route, as logged in `request/context`. */
  model: string
  /** Prompt tokens at which this model's quality starts to fall. */
  effectiveTokens: number
}

/** Public plugin configuration; every field is optional. */
export interface ContextDriftConfig {
  /** Effective context for routes without a profile and without a reported window. */
  fallbackEffectiveTokens?: number
  /** Fraction of the advertised window the effective context may never exceed. */
  windowRatio?: number
  /** Per-route effective-context overrides. */
  modelProfiles?: ModelProfileConfig[]
  /** Fraction of the effective context below which length scores 0. */
  lengthOnsetRatio?: number
  /** Human turns at which the turns signal starts rising. */
  turnsOnset?: number
  /** Human turns at which the turns signal reaches 1. */
  turnsSaturation?: number
  /** Weighted mistake count at which the mistakes signal reaches 1 − 1/e. */
  mistakesScale?: number
  /** Per-item weights of the mistakes count. */
  mistakeWeights?: {
    /** Weight of one failed tool result still in context. */
    toolError?: number
    /** Weight of one human correction still in context. */
    correction?: number
    /** Weight of one repeat-tool-call warning still in context. */
    loopWarning?: number
    /** Weight of one interrupted assistant reply still in context. */
    interrupt?: number
  }
  /** Tool-output share at which the noise signal starts rising. */
  toolShareOnset?: number
  /** Tool-output share span over which the noise signal rises to 1. */
  toolShareSpan?: number
  /** Compactions before the layers signal starts rising. */
  layersOnset?: number
  /** Compaction span over which the layers signal rises to 1. */
  layersSpan?: number
  /** Combination weight of each signal, each in [0, 1). */
  weights?: Partial<Record<ContextDriftSignal, number>>
  /** Score thresholds of the drifting and high levels, and the nudge re-arm score. */
  levels?: {
    /** Score at which the level becomes `drifting`. */
    drifting?: number
    /** Score at which the level becomes `high` and clients may nudge. */
    high?: number
    /** Score a high session must fall below before clients nudge again after a dismissal. */
    rearm?: number
  }
  /** Topic-change detection. */
  topic?: {
    /** Keywords a human message needs before it can start a new topic. */
    minKeywords?: number
    /** Share of a message's keywords that must appear in the current topic for it to stay on topic. */
    minOverlap?: number
    /** Newest keywords retained per topic. */
    maxKeywords?: number
  }
  /** Case-insensitive regular-expression sources that mark a human message as a correction. */
  correctionPatterns?: string[]
  /** Compactions after which the recommendation becomes a new chat. */
  newChatAfterCompactions?: number
  /** Human turns after a compaction during which a high score recommends a new chat. */
  recentCompactionTurns?: number
}

/** Fold-time configuration: changing it changes the fold state, so it keys the projection state version. */
export interface ResolvedFoldConfig {
  readonly topic: { readonly minKeywords: number; readonly minOverlap: number; readonly maxKeywords: number }
  readonly correctionPatterns: readonly string[]
}

/** Fully resolved configuration consumed by the fold and the score. */
export interface ResolvedContextDriftConfig {
  readonly fold: ResolvedFoldConfig
  readonly corrections: readonly RegExp[]
  readonly fallbackEffectiveTokens: number
  readonly windowRatio: number
  readonly modelProfiles: readonly ModelProfileConfig[]
  readonly lengthOnsetRatio: number
  readonly turnsOnset: number
  readonly turnsSaturation: number
  readonly mistakesScale: number
  readonly mistakeWeights: {
    readonly toolError: number
    readonly correction: number
    readonly loopWarning: number
    readonly interrupt: number
  }
  readonly toolShareOnset: number
  readonly toolShareSpan: number
  readonly layersOnset: number
  readonly layersSpan: number
  readonly weights: Readonly<Record<ContextDriftSignal, number>>
  readonly levels: { readonly drifting: number; readonly high: number; readonly rearm: number }
  readonly newChatAfterCompactions: number
  readonly recentCompactionTurns: number
}

/**
 * Default correction phrases: openers that reject the last reply, reports that
 * the result still fails, undo requests, and the Chinese equivalents.
 */
export const DEFAULT_CORRECTION_PATTERNS: readonly string[] = [
  String.raw`^\s*(no|nope|nah|wrong|incorrect)\b`,
  String.raw`\b(that'?s|that is|this is|it'?s) (not right|not what|wrong)\b`,
  String.raw`\bstill (not|broken|failing|wrong|the same|doesn'?t)\b`,
  String.raw`\b(doesn'?t|does not|didn'?t|did not) work\b`,
  String.raw`\b(revert|undo|roll ?back)\b`,
  String.raw`\byou (broke|missed|forgot|ignored)\b`,
  String.raw`\bnot what i (asked|wanted|meant)\b`,
  String.raw`\bi (already )?(said|told you)\b`,
  '不对|错了|不是这样|还是不行|没用|撤销|回滚|我说过',
]

const DEFAULT_WEIGHTS: Record<ContextDriftSignal, number> = {
  length: 0.6,
  turns: 0.25,
  mistakes: 0.35,
  stale: 0.4,
  noise: 0.2,
  layers: 0.3,
}

/** Copy of a partial record without `undefined` entries, so defaults survive Loader normalization. */
function defined<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function fail(message: string): never {
  throw new Error(`ContextDriftConfig: ${message}`)
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`)
  return value
}

function within(name: string, value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || value < low || value > high) fail(`${name} must be in [${low}, ${high}]`)
  return value
}

/**
 * Resolve defaults and validate cross-field invariants.
 * @param config - plugin configuration after Loader normalization.
 * @returns frozen resolved configuration.
 * @throws when a value is out of range, levels are unordered, a profile route
 *   repeats, or a correction pattern is not a valid regular expression.
 */
export function resolveContextDriftConfig(config: ContextDriftConfig = {}): ResolvedContextDriftConfig {
  const weights = { ...DEFAULT_WEIGHTS, ...defined(config.weights) }
  for (const [key, value] of Object.entries(weights)) {
    // A weight of 1 would let one saturated signal pin the score at 100 regardless of the rest.
    if (!Number.isFinite(value) || value < 0 || value >= 1) fail(`weights.${key} must be in [0, 1)`)
  }
  const levels = { drifting: 35, high: 60, rearm: 50, ...defined(config.levels) }
  if (!(levels.drifting < levels.high)) fail('levels.drifting must be below levels.high')
  if (!(levels.rearm <= levels.high)) fail('levels.rearm must not exceed levels.high')
  const turnsOnset = config.turnsOnset ?? 8
  const turnsSaturation = config.turnsSaturation ?? 30
  if (!(turnsSaturation > turnsOnset)) fail('turnsSaturation must exceed turnsOnset')
  const routes = new Set<string>()
  const modelProfiles = (config.modelProfiles ?? []).map((profile, index) => {
    const route = `${profile.provider}\u0000${profile.model}`
    if (routes.has(route)) fail(`modelProfiles[${index}] repeats ${profile.provider}/${profile.model}`)
    routes.add(route)
    return { ...profile, effectiveTokens: positive(`modelProfiles[${index}].effectiveTokens`, profile.effectiveTokens) }
  })
  const correctionPatterns = config.correctionPatterns ?? DEFAULT_CORRECTION_PATTERNS
  const corrections = correctionPatterns.map((source, index) => {
    try {
      return new RegExp(source, 'iu')
    } catch (error) {
      return fail(`correctionPatterns[${index}] is not a valid regular expression: ${String(error)}`)
    }
  })
  const resolved: ResolvedContextDriftConfig = {
    fold: {
      topic: {
        minKeywords: config.topic?.minKeywords ?? 6,
        minOverlap: within('topic.minOverlap', config.topic?.minOverlap ?? 0.15, 0, 1),
        maxKeywords: config.topic?.maxKeywords ?? 256,
      },
      correctionPatterns: [...correctionPatterns],
    },
    corrections,
    fallbackEffectiveTokens: positive('fallbackEffectiveTokens', config.fallbackEffectiveTokens ?? 64_000),
    windowRatio: positive('windowRatio', config.windowRatio ?? 0.5),
    modelProfiles,
    lengthOnsetRatio: within('lengthOnsetRatio', config.lengthOnsetRatio ?? 0.25, 0, 0.99),
    turnsOnset,
    turnsSaturation,
    mistakesScale: positive('mistakesScale', config.mistakesScale ?? 8),
    mistakeWeights: { toolError: 1, correction: 2, loopWarning: 2, interrupt: 1, ...defined(config.mistakeWeights) },
    toolShareOnset: within('toolShareOnset', config.toolShareOnset ?? 0.5, 0, 1),
    toolShareSpan: positive('toolShareSpan', config.toolShareSpan ?? 0.4),
    layersOnset: config.layersOnset ?? 1,
    layersSpan: positive('layersSpan', config.layersSpan ?? 2),
    weights,
    levels,
    newChatAfterCompactions: config.newChatAfterCompactions ?? 2,
    recentCompactionTurns: config.recentCompactionTurns ?? 3,
  }
  return Object.freeze(resolved)
}
