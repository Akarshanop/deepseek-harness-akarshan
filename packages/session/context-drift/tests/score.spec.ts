/**
 * The drift formula: signal curves, the weighted noisy-OR combination and its
 * additive shares, effective-context resolution, and the recommendation rules.
 */

import { describe, expect, it } from 'vitest'
import { resolveContextDriftConfig } from '../src/config.ts'
import { effectiveTokens, scoreDrift } from '../src/score.ts'
import type { DriftInputs } from '../src/score.ts'

const config = resolveContextDriftConfig()

function inputs(overrides: Partial<DriftInputs> = {}): DriftInputs {
  return {
    liveTokens: 0,
    turns: 0,
    toolErrors: 0,
    corrections: 0,
    loopWarnings: 0,
    interrupts: 0,
    messageTokens: 0,
    staleTokens: 0,
    toolTokens: 0,
    compactions: 0,
    turnsSinceBaseline: 0,
    baseline: { kind: 'session-start', seq: 0, time: 0 },
    degraded: false,
    ...overrides,
  }
}

describe('effectiveTokens', () => {
  it('caps an unprofiled large window at the fallback', () => {
    expect(effectiveTokens({ contextWindow: 1_000_000 }, config)).toBe(64_000)
  })

  it('uses half of a small window', () => {
    expect(effectiveTokens({ contextWindow: 32_000 }, config)).toBe(16_000)
  })

  it('uses the fallback when no window is known', () => {
    expect(effectiveTokens({}, config)).toBe(64_000)
  })

  it('prefers an exact route profile, still capped by half the window', () => {
    const profiled = resolveContextDriftConfig({
      modelProfiles: [{ provider: 'deepseek', model: 'v4', effectiveTokens: 180_000 }],
    })
    expect(effectiveTokens({ provider: 'deepseek', model: 'v4', contextWindow: 1_000_000 }, profiled)).toBe(180_000)
    expect(effectiveTokens({ provider: 'deepseek', model: 'v4', contextWindow: 200_000 }, profiled)).toBe(100_000)
    expect(effectiveTokens({ provider: 'deepseek', model: 'other', contextWindow: 1_000_000 }, profiled)).toBe(64_000)
  })
})

describe('scoreDrift', () => {
  it('scores an empty context as fresh with no cause or action', () => {
    const view = scoreDrift(inputs(), config)
    expect(view).toMatchObject({ score: 0, level: 'fresh', action: 'none' })
    expect(view.cause).toBeUndefined()
    expect(view.shares).toEqual({ length: 0, turns: 0, mistakes: 0, stale: 0, noise: 0, layers: 0 })
  })

  it('reaches exactly the high threshold from length alone at the effective context', () => {
    const view = scoreDrift(inputs({ liveTokens: 64_000, contextWindow: 1_000_000 }), config)
    expect(view).toMatchObject({ score: 60, level: 'high', cause: 'length', action: 'compact', actionReason: 'cause' })
    expect(view.shares.length).toBe(100)
  })

  it('keeps length at zero below a quarter of the effective context', () => {
    expect(scoreDrift(inputs({ liveTokens: 15_999, contextWindow: 1_000_000 }), config).score).toBe(0)
  })

  it('reproduces the worked example: 76, length-led, compact', () => {
    const messageTokens = 40_000
    const view = scoreDrift(inputs({
      liveTokens: 52_000,
      contextWindow: 1_000_000,
      turns: 21,
      toolErrors: 5,
      corrections: 2,
      loopWarnings: 1,
      messageTokens,
      staleTokens: 0.4 * messageTokens,
      toolTokens: 0.72 * messageTokens,
    }), config)
    expect(view).toMatchObject({ score: 76, level: 'high', cause: 'length', action: 'compact' })
    expect(view.shares).toEqual({ length: 50, turns: 12, mistakes: 21, stale: 10, noise: 7, layers: 0 })
    expect(view.readings).toMatchObject({ effectiveTokens: 64_000, stalePercent: 40, toolOutputPercent: 72 })
  })

  it('caps turns and mistakes below the high threshold when the context is short', () => {
    const view = scoreDrift(inputs({ turns: 40, toolErrors: 40 }), config)
    expect(view.score).toBeLessThan(60)
    expect(view.level).toBe('drifting')
  })

  it('gates stale and tool-noise shares by length', () => {
    const short = scoreDrift(inputs({
      liveTokens: 10_000, messageTokens: 9_000, staleTokens: 9_000, toolTokens: 9_000,
    }), config)
    expect(short.score).toBe(0)
  })

  it('recommends a new chat once the context sits on enough compactions', () => {
    const view = scoreDrift(inputs({ liveTokens: 64_000, compactions: 2, turnsSinceBaseline: 10 }), config)
    expect(view).toMatchObject({ action: 'new-chat', actionReason: 'layers' })
  })

  it('recommends a new chat when old topics dominate', () => {
    const view = scoreDrift(inputs({
      liveTokens: 60_000, messageTokens: 50_000, staleTokens: 50_000, toolErrors: 30,
    }), resolveContextDriftConfig({ weights: { length: 0.2, stale: 0.9 } }))
    expect(view).toMatchObject({ cause: 'stale', action: 'new-chat', actionReason: 'stale' })
  })

  it('recommends a new chat when a compaction just ran and the score is still high', () => {
    const view = scoreDrift(inputs({
      liveTokens: 64_000,
      compactions: 1,
      turnsSinceBaseline: 1,
      baseline: { kind: 'compaction', seq: 9, time: 1 },
    }), config)
    expect(view).toMatchObject({ action: 'new-chat', actionReason: 'recent-compaction' })
  })

  it('carries the configured thresholds and the degraded mark', () => {
    const view = scoreDrift(inputs({ degraded: true }), config)
    expect(view.thresholds).toEqual({ drifting: 35, high: 60, rearm: 50 })
    expect(view.degraded).toBe(true)
  })
})

describe('resolveContextDriftConfig', () => {
  it('rejects unordered levels, saturated weights, repeated profiles, and invalid patterns', () => {
    expect(() => resolveContextDriftConfig({ levels: { drifting: 70, high: 60 } })).toThrow(/levels.drifting/)
    expect(() => resolveContextDriftConfig({ weights: { length: 1 } })).toThrow(/weights.length/)
    expect(() => resolveContextDriftConfig({
      modelProfiles: [
        { provider: 'p', model: 'm', effectiveTokens: 1 },
        { provider: 'p', model: 'm', effectiveTokens: 2 },
      ],
    })).toThrow(/repeats/)
    expect(() => resolveContextDriftConfig({ correctionPatterns: ['('] })).toThrow(/correctionPatterns\[0\]/)
  })
})
