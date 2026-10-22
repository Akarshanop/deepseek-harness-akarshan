/**
 * Drift breakdown card body: score and level, the advice for the recommended
 * action, the raw readings, the dominant cause, the baseline, and the action
 * buttons. Rendered inside the header meter's popover.
 */

import { useState } from 'react'
import type { ContextDriftProjection } from '@deepseek-ai/dsh-context-drift/client'
import { Button, IconCompactOutlineRegular, IconNewChatOutlineRegular, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatTokens } from './model.ts'
import type { DriftInjected } from './slots.ts'
import type { NS } from './locales.ts'
import css from './DriftCard.module.css'

/** Localized translate seat of this plugin. */
export type DriftTranslate = TranslateNS<typeof NS>

/** Level CSS class: the tint every drift surface uses for one level. */
export const LEVEL_CLASS: Record<ContextDriftProjection['level'], string | undefined> = {
  fresh: css.fresh,
  drifting: css.drifting,
  high: css.high,
}

/**
 * Format a token count with the plugin's K/M templates.
 * @param value - token count.
 * @param t - plugin translate seat.
 * @returns compact count.
 */
export function tokens(value: number, t: DriftTranslate): string {
  return formatTokens(value, {
    thousand: scaled => t('number.thousand', { value: scaled }),
    million: scaled => t('number.million', { value: scaled }),
  })
}

/**
 * Localized advice sentence for the recommended action.
 * @param drift - current drift value.
 * @param t - plugin translate seat.
 * @returns advice text.
 */
export function advice(drift: ContextDriftProjection, t: DriftTranslate): string {
  return drift.actionReason === undefined ? t('advice.none') : t(`advice.${drift.actionReason}`)
}

/**
 * Compact and new-chat controls with pending and failure state, shared by
 * the card and the nudge.
 * @param actions - session-bound actions.
 * @param t - plugin translate seat.
 * @returns run helpers plus the pending flag and the last failure line.
 */
export function useDriftActions(actions: Pick<DriftInjected, 'compact' | 'newChat'>, t: DriftTranslate) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runCompact = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      setError(await actions.compact())
    } finally {
      setPending(false)
    }
  }
  const runNewChat = (): void => {
    actions.newChat(t('newChat.label'))
  }
  return { pending, error, runCompact, runNewChat }
}

/** Props of {@link DriftCard}. */
export interface DriftCardProps {
  drift: ContextDriftProjection
  actions: Pick<DriftInjected, 'compact' | 'newChat'>
  t: DriftTranslate
  /** Current epoch ms, injected for the baseline age. */
  now: number
}

/** Breakdown card of one drift value. */
export function DriftCard({ drift, actions, t, now }: DriftCardProps) {
  const { pending, error, runCompact, runNewChat } = useDriftActions(actions, t)
  const { readings } = drift
  const percent = (value: number): string => t('percent', { value })
  const age = relativeTime(drift.baseline.time, now)
  const rows: [string, string][] = [
    [t('row.live'), t('row.liveValue', { used: tokens(readings.liveTokens, t), effective: tokens(readings.effectiveTokens, t) })],
    ...readings.contextWindow === undefined ? [] : [[t('row.window'), tokens(readings.contextWindow, t)] as [string, string]],
    [t('row.turns'), String(readings.turns)],
    [t('row.toolErrors'), String(readings.toolErrors)],
    [t('row.corrections'), String(readings.corrections)],
    [t('row.loopWarnings'), String(readings.loopWarnings)],
    [t('row.interrupts'), String(readings.interrupts)],
    [t('row.stale'), percent(readings.stalePercent)],
    [t('row.toolOutput'), percent(readings.toolOutputPercent)],
    [t('row.compactions'), String(readings.compactions)],
  ]
  const levelClass = LEVEL_CLASS[drift.level]
  return (
    <div className={levelClass === undefined ? css.card : `${css.card} ${levelClass}`}>
      <div className={css.header}>
        <span className={css.title}>{t('card.title')}</span>
        <span className={css.score}>{percent(drift.score)}</span>
      </div>
      <div className={css.bar} aria-hidden>
        <div className={css.fill} style={{ width: `${drift.score}%` }} />
      </div>
      <p className={css.advice}>
        <span className={css.level}>{t(`level.${drift.level}`)}</span>
        {' · '}
        {advice(drift, t)}
      </p>
      <dl className={css.rows}>
        {rows.map(([label, value]) => (
          <div key={label} className={css.row}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <dl className={`${css.rows} ${css.section}`}>
        {drift.cause !== undefined && (
          <div className={css.row}>
            <dt>{t('cause.label')}</dt>
            <dd>{t('cause.value', { signal: t(`signal.${drift.cause}`), percent: percent(drift.shares[drift.cause]) })}</dd>
          </div>
        )}
        <div className={css.row}>
          <dt>{t('baseline.label')}</dt>
          <dd>{`${t(`baseline.${drift.baseline.kind}`)} · ${t(`time.${age.unit}`, { n: age.n })}`}</dd>
        </div>
      </dl>
      {drift.degraded === true && <p className={css.note}>{t('degraded')}</p>}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
      {drift.level !== 'fresh' && (
        <div className={css.actions}>
          <Button
            size="sm"
            variant={drift.action === 'compact' ? 'primary' : 'outline'}
            icon={<IconCompactOutlineRegular size={14} />}
            disabled={pending}
            onClick={() => { void runCompact() }}
          >
            {pending ? t('action.compacting') : t('action.compact')}
          </Button>
          <Button
            size="sm"
            variant={drift.action === 'new-chat' ? 'primary' : 'outline'}
            icon={<IconNewChatOutlineRegular size={14} />}
            onClick={runNewChat}
          >
            {t('action.newChat')}
          </Button>
        </div>
      )}
    </div>
  )
}
