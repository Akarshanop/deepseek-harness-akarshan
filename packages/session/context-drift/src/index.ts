/**
 * Function plugin registering the `contextDrift` projection unit: a
 * deterministic, model-call-free estimate of how much long-context quality
 * loss the next request carries since the session start or the last
 * compaction, with a recommendation to compact or start a new chat. Delivery
 * to clients is the projection seam's.
 *
 * @module @deepseek-ai/dsh-context-drift
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CORRECTION_PATTERNS, resolveContextDriftConfig } from './config.ts'
import type { ContextDriftConfig } from './config.ts'
import { createContextDriftProjection } from './projection.ts'

export type * from './types.ts'
export type { ContextDriftConfig, ModelProfileConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'context-drift'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/** Plugin configuration: see {@link ContextDriftConfig}. */
export type Config = ContextDriftConfig

/** Loader schema of the plugin configuration; defaults and cross-field rules resolve at load. */
export const Config: z<Config> = z.object({
  fallbackEffectiveTokens: z.number().step(1).min(1),
  windowRatio: z.number().min(0).max(1),
  modelProfiles: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    effectiveTokens: z.number().step(1).min(1).required(),
  })),
  lengthOnsetRatio: z.number().min(0).max(1),
  turnsOnset: z.number().min(0),
  turnsSaturation: z.number().min(0),
  mistakesScale: z.number().min(0),
  mistakeWeights: z.object({
    toolError: z.number().min(0),
    correction: z.number().min(0),
    loopWarning: z.number().min(0),
    interrupt: z.number().min(0),
  }),
  toolShareOnset: z.number().min(0).max(1),
  toolShareSpan: z.number().min(0).max(1),
  layersOnset: z.number().min(0),
  layersSpan: z.number().min(0),
  weights: z.object({
    length: z.number().min(0).max(1),
    turns: z.number().min(0).max(1),
    mistakes: z.number().min(0).max(1),
    stale: z.number().min(0).max(1),
    noise: z.number().min(0).max(1),
    layers: z.number().min(0).max(1),
  }),
  levels: z.object({
    drifting: z.number().min(0).max(100),
    high: z.number().min(0).max(100),
    rearm: z.number().min(0).max(100),
  }),
  topic: z.object({
    minKeywords: z.number().step(1).min(1),
    minOverlap: z.number().min(0).max(1),
    maxKeywords: z.number().step(1).min(1),
  }),
  // Explicit default: an unset array would otherwise normalize to [] and disable correction matching.
  correctionPatterns: z.array(z.string()).default([...DEFAULT_CORRECTION_PATTERNS]),
  newChatAfterCompactions: z.number().step(1).min(1),
  recentCompactionTurns: z.number().min(0),
})

/**
 * Register the `contextDrift` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - plugin configuration; invalid values fail the load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.sessionProjections.register(createContextDriftProjection(resolveContextDriftConfig(config)))
}
