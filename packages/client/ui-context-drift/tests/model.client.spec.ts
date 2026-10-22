/**
 * Pure drift-surface helpers: the session-reference mention matches the host
 * encoder, nudge visibility and dismissal re-arming follow the host
 * thresholds and baseline, and token counts format compactly.
 */

import { describe, expect, it } from 'vitest'
import type { ContextDriftProjection } from '@deepseek-ai/dsh-context-drift/client'
import { dismissalExpired, formatTokens, nudgeVisible, sessionReferenceUri, summarizedSessionMention } from '../src/client/model.ts'

function drift(overrides: Partial<ContextDriftProjection> = {}): ContextDriftProjection {
  return {
    score: 70,
    level: 'high',
    cause: 'length',
    action: 'compact',
    actionReason: 'cause',
    shares: { length: 100, turns: 0, mistakes: 0, stale: 0, noise: 0, layers: 0 },
    readings: {
      liveTokens: 70_000, effectiveTokens: 64_000, turns: 3, toolErrors: 0, corrections: 0,
      loopWarnings: 0, interrupts: 0, stalePercent: 0, toolOutputPercent: 0, compactions: 0,
    },
    baseline: { kind: 'session-start', seq: 0, time: 0 },
    thresholds: { drifting: 35, high: 60, rearm: 50 },
    ...overrides,
  }
}

describe('session reference mention', () => {
  it('encodes ids exactly like the host base64url JSON encoder', () => {
    for (const id of ['plain', 'ünïcode-会话', 'a"quote\\slash']) {
      const host = `dsh-session:${Buffer.from(JSON.stringify(id), 'utf8').toString('base64url')}`
      expect(sessionReferenceUri(id)).toBe(host)
    }
  })

  it('renders a summarized mention and escapes the label', () => {
    expect(summarizedSessionMention('s1', 'a]b\\c')).toBe(`#[a\\]b\\\\c](${sessionReferenceUri('s1')})`)
  })
})

describe('nudge arming', () => {
  it('shows only for high drift with an action and no dismissal on this baseline', () => {
    expect(nudgeVisible(drift(), null)).toBe(true)
    expect(nudgeVisible(drift({ level: 'drifting' }), null)).toBe(false)
    expect(nudgeVisible(drift({ action: 'none' }), null)).toBe(false)
    expect(nudgeVisible(drift(), { baselineSeq: 0 })).toBe(false)
    expect(nudgeVisible(drift({ baseline: { kind: 'compaction', seq: 9, time: 1 } }), { baselineSeq: 0 })).toBe(true)
  })

  it('expires a dismissal below the re-arm score or after the baseline moves', () => {
    expect(dismissalExpired(drift({ score: 55 }), { baselineSeq: 0 })).toBe(false)
    expect(dismissalExpired(drift({ score: 49 }), { baselineSeq: 0 })).toBe(true)
    expect(dismissalExpired(drift({ baseline: { kind: 'compaction', seq: 4, time: 1 } }), { baselineSeq: 0 })).toBe(true)
  })
})

describe('formatTokens', () => {
  const format = { thousand: (value: string) => `${value}k`, million: (value: string) => `${value}M` }

  it('formats units, thousands, and millions', () => {
    expect(formatTokens(950, format)).toBe('950')
    expect(formatTokens(52_400, format)).toBe('52.4k')
    expect(formatTokens(128_000, format)).toBe('128k')
    expect(formatTokens(1_000_000, format)).toBe('1M')
  })
})
