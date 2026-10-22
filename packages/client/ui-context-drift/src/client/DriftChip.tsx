/**
 * Session-header drift meter: a gauge glyph, a short level-tinted bar, and
 * the score. Hovering opens the breakdown card after a short delay and a
 * pointer grace keeps it open while the pointer crosses to it; a click pins
 * it open until an outside click or Escape. Renders nothing until the host
 * serves the `contextDrift` projection.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
// Type-only: the `contextDrift` SessionProjectionMap key merge.
import type {} from '@deepseek-ai/dsh-context-drift/client'
import { IconGaugeOutlineRegular, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { DriftCard, LEVEL_CLASS } from './DriftCard.tsx'
import type { DriftInjected } from './slots.ts'
import type { NS } from './locales.ts'
import css from './DriftChip.module.css'

/** Hover delay before the card opens, ms. */
const OPEN_DELAY_MS = 200
/** Pointer grace before a hover-opened card closes, ms. */
const CLOSE_GRACE_MS = 200

/** Full props of the header utility entry. */
export type DriftChipProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<DriftInjected>

/** The props the meter reads: the projection seat, the locale seat, and the actions it forwards. */
export type DriftChipViewProps = Pick<DriftChipProps, 'useProjection' | 't' | 'compact' | 'newChat'>

/** Header drift meter with its hover card. */
export function DriftChip({ useProjection, t, compact, newChat }: DriftChipViewProps) {
  const drift = useProjection('contextDrift')
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const open = (hovered || pinned) && drift !== undefined
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'bottom', align: 'end', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, pinned, (next) => {
    setPinned(next)
    if (!next) setHovered(false)
  }, panelRef)

  useEffect(() => () => { clearTimeout(timer.current) }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPinned(false)
      setHovered(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (drift === undefined) return null

  const enter = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setHovered(true) }, hovered ? 0 : OPEN_DELAY_MS)
  }
  const leave = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setHovered(false) }, CLOSE_GRACE_MS)
  }
  const reading = t('percent', { value: drift.score })
  const levelClass = LEVEL_CLASS[drift.level]

  return (
    <span ref={rootRef} className={css.root} onPointerEnter={enter} onPointerLeave={leave}>
      <button
        type="button"
        className={levelClass === undefined ? css.trigger : `${css.trigger} ${levelClass}`}
        aria-label={t('chip.aria', { percent: reading })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-drift-level={drift.level}
        onClick={() => { setPinned(!pinned) }}
      >
        <IconGaugeOutlineRegular size={14} />
        <span className={css.track} aria-hidden>
          <span className={css.fill} style={{ width: `${drift.score}%` }} />
        </span>
        <span className={css.reading}>{reading}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('card.title')}
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          <DriftCard drift={drift} actions={{ compact, newChat }} t={t} now={Date.now()} />
        </div>,
        document.body,
      )}
    </span>
  )
}
