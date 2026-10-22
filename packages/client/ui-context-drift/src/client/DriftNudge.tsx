/**
 * Composer nudge: a one-line card above the composer while drift is high,
 * with the recommended action first. Dismissing it hides it for the current
 * baseline until the score falls below the host's re-arm threshold or a
 * compaction moves the baseline.
 */

import { useEffect, useState } from 'react'
// Type-only: the `contextDrift` SessionProjectionMap key merge.
import type {} from '@deepseek-ai/dsh-context-drift/client'
import {
  IconCloseOutlineRegular, IconCompactOutlineRegular, IconGaugeOutlineRegular, IconNewChatOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { advice, LEVEL_CLASS, useDriftActions } from './DriftCard.tsx'
import { dismissalExpired, nudgeVisible } from './model.ts'
import type { NudgeDismissal } from './model.ts'
import type { DriftInjected } from './slots.ts'
import type { NS } from './locales.ts'
import css from './DriftNudge.module.css'

/** Full props of the input-dock entry. */
export type DriftNudgeProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & InjectFace<DriftInjected>

/** The props the nudge reads: the projection seat, the locale seat, and the session actions. */
export type DriftNudgeViewProps = Pick<
  DriftNudgeProps, 'useProjection' | 't' | 'compact' | 'newChat' | 'readDismissal' | 'writeDismissal'
>

/** High-drift nudge above the composer. */
export function DriftNudge({ useProjection, t, compact, newChat, readDismissal, writeDismissal }: DriftNudgeViewProps) {
  const drift = useProjection('contextDrift')
  const [dismissal, setDismissal] = useState<NudgeDismissal | null>(readDismissal)
  const { pending, error, runCompact, runNewChat } = useDriftActions({ compact, newChat }, t)

  useEffect(() => {
    if (drift === undefined || dismissal === null || !dismissalExpired(drift, dismissal)) return
    setDismissal(null)
    writeDismissal(null)
  }, [drift, dismissal, writeDismissal])

  if (drift === undefined || !nudgeVisible(drift, dismissal)) return null

  const dismiss = (): void => {
    const next = { baselineSeq: drift.baseline.seq }
    setDismissal(next)
    writeDismissal(next)
  }
  const compactButton = (
    <button key="compact" type="button" className={css.action} disabled={pending} onClick={() => { void runCompact() }}>
      <IconCompactOutlineRegular size={14} />
      {pending ? t('action.compacting') : t('action.compact')}
    </button>
  )
  const newChatButton = (
    <button key="new-chat" type="button" className={css.action} onClick={runNewChat}>
      <IconNewChatOutlineRegular size={14} />
      {t('action.newChat')}
    </button>
  )
  const levelClass = LEVEL_CLASS[drift.level]

  return (
    <div className={css.dock} data-context-drift-nudge>
      <div className={levelClass === undefined ? css.bar : `${css.bar} ${levelClass}`}>
        <span className={css.glyph}><IconGaugeOutlineRegular size={14} /></span>
        <span className={css.label}>{t('nudge.title', { percent: t('percent', { value: drift.score }) })}</span>
        <span className={error === null ? css.text : css.error} role={error === null ? undefined : 'alert'}>
          {error ?? advice(drift, t)}
        </span>
        <div className={css.actions}>
          {drift.action === 'new-chat' ? [newChatButton, compactButton] : [compactButton, newChatButton]}
          <Tooltip portal label={t('action.dismiss')} side="bottom" delayMs={500}>
            <button type="button" className={css.iconBtn} onClick={dismiss} aria-label={t('action.dismiss')}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
