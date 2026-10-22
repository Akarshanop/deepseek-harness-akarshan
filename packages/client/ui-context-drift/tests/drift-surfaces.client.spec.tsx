// @vitest-environment jsdom

/**
 * Drift surfaces: the header meter renders nothing until the projection
 * exists and opens the breakdown card on click; the card shows readings,
 * cause, baseline, and actions; the nudge appears only for high drift, runs
 * the actions, and stays dismissed for its baseline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { ContextDriftProjection } from '@deepseek-ai/dsh-context-drift/client'
import { DriftCard } from '../src/client/DriftCard.tsx'
import { DriftChip, type DriftChipProps, type DriftChipViewProps } from '../src/client/DriftChip.tsx'
import { DriftNudge, type DriftNudgeViewProps } from '../src/client/DriftNudge.tsx'
import { en } from '../src/client/locales.ts'
import type { NudgeDismissal } from '../src/client/model.ts'

afterEach(cleanup)

/** A projection seat serving one fixed contextDrift value. */
function serving(value: ContextDriftProjection | undefined): DriftChipViewProps['useProjection'] {
  const values: Record<string, unknown> = { contextDrift: value }
  return (key: string) => values[key]
}

const t = makeTranslate(en, commonEn) as DriftChipProps['t']

function drift(overrides: Partial<ContextDriftProjection> = {}): ContextDriftProjection {
  return {
    score: 76,
    level: 'high',
    cause: 'length',
    action: 'compact',
    actionReason: 'cause',
    shares: { length: 50, turns: 12, mistakes: 21, stale: 10, noise: 7, layers: 0 },
    readings: {
      liveTokens: 52_000, effectiveTokens: 64_000, contextWindow: 1_000_000, turns: 21, toolErrors: 5,
      corrections: 2, loopWarnings: 1, interrupts: 0, stalePercent: 40, toolOutputPercent: 72, compactions: 0,
    },
    baseline: { kind: 'session-start', seq: 0, time: 1_000 },
    thresholds: { drifting: 35, high: 60, rearm: 50 },
    ...overrides,
  }
}

function actions() {
  return {
    compact: vi.fn(async (): Promise<string | null> => null),
    newChat: vi.fn((_label: string) => {}),
  }
}

describe('DriftChip', () => {
  it('renders nothing until the host serves the projection', () => {
    const props: DriftChipViewProps = { useProjection: serving(undefined), t, ...actions() }
    expect(render(<DriftChip {...props} />).container.textContent).toBe('')
  })

  it('shows the score and opens the breakdown card on click', () => {
    const value = drift()
    const props: DriftChipViewProps = { useProjection: serving(value), t, ...actions() }
    render(<DriftChip {...props} />)
    const trigger = screen.getByRole('button', { name: 'Context drift 76%' })
    expect(trigger.getAttribute('data-drift-level')).toBe('high')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Context drift' })
    expect(dialog.textContent).toContain('52k / 64k effective')
    expect(dialog.textContent).toContain('Length · 50%')
  })
})

describe('DriftCard', () => {
  it('lists readings, cause, baseline age, and advice', () => {
    render(<DriftCard drift={drift()} actions={actions()} t={t} now={1_000 + 2 * 3_600_000} />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('High drift · Compacting the chat usually restores answer quality.')
    expect(text).toContain('Failed tool calls5')
    expect(text).toContain('Old-topic context40%')
    expect(text).toContain('Chat start · 2h ago')
  })

  it('runs compact and reports a failure line', async () => {
    const face = actions()
    face.compact.mockResolvedValueOnce('busy')
    render(<DriftCard drift={drift()} actions={face} t={t} now={1_000} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Compact now/u })) })
    expect(face.compact).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toBe('busy')
  })

  it('opens a new chat with the localized reference label', () => {
    const face = actions()
    render(<DriftCard drift={drift({ action: 'new-chat', actionReason: 'stale' })} actions={face} t={t} now={1_000} />)
    fireEvent.click(screen.getByRole('button', { name: /New chat/u }))
    expect(face.newChat).toHaveBeenCalledWith('previous chat')
  })

  it('hides actions while the context is fresh', () => {
    render(<DriftCard drift={drift({ score: 10, level: 'fresh', action: 'none' })} actions={actions()} t={t} now={1_000} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('DriftNudge', () => {
  function nudge(value: ContextDriftProjection, stored: NudgeDismissal | null = null) {
    const writeDismissal = vi.fn((_value: NudgeDismissal | null) => {})
    const props: DriftNudgeViewProps = {
      useProjection: serving(value),
      t,
      ...actions(),
      readDismissal: () => stored,
      writeDismissal,
    }
    return { writeDismissal, ...render(<DriftNudge {...props} />) }
  }

  it('stays hidden below the high level', () => {
    expect(nudge(drift({ score: 40, level: 'drifting' })).container.textContent).toBe('')
  })

  it('shows the score, the advice, and the recommended action first', () => {
    const { container } = nudge(drift({ action: 'new-chat', actionReason: 'layers' }))
    expect(container.textContent).toContain('Context drift 76%')
    const buttons = screen.getAllByRole('button').map(button => button.textContent)
    expect(buttons.slice(0, 2)).toEqual(['New chat', 'Compact now'])
  })

  it('hides after dismissal and stores the baseline', () => {
    const { container, writeDismissal } = nudge(drift())
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(container.textContent).toBe('')
    expect(writeDismissal).toHaveBeenCalledWith({ baselineSeq: 0 })
  })

  it('clears a dismissal once the baseline moves', () => {
    const { container, writeDismissal } = nudge(
      drift({ baseline: { kind: 'compaction', seq: 7, time: 1_000 }, action: 'new-chat', actionReason: 'recent-compaction' }),
      { baselineSeq: 0 },
    )
    expect(container.textContent).toContain('Context drift 76%')
    expect(writeDismissal).toHaveBeenCalledWith(null)
  })
})
