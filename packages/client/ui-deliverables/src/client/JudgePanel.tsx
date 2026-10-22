/**
 * The model's judgment of one changed file against the project's codebase docs: its verdict and confidence,
 * the issues it found, the per-aspect checks, and its suggestions.
 */
import type { ReactNode } from 'react'
import {
  Button, IconCheckCircleOutlineRegular, IconCloseCircleFillRegular, IconInfoOutlineRegular, IconShieldOutlineRegular,
  IconWarningTriangleOutlineRegular, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { JudgeAspect, JudgeCheckStatus, JudgeSeverity, JudgeVerdict } from '../changes.ts'
import type { ChangesJudgeState } from './changes-judge.ts'
import type { DeliverablesKey, NS } from './locales.ts'
import { InlineCode } from './ExplainPanel.tsx'
import css from './JudgePanel.module.css'

const VERDICT_KEYS: Record<JudgeVerdict, DeliverablesKey> = {
  pass: 'judge.verdict.pass', concerns: 'judge.verdict.concerns', fail: 'judge.verdict.fail',
}
const SEVERITY_KEYS: Record<JudgeSeverity, DeliverablesKey> = {
  high: 'judge.severity.high', medium: 'judge.severity.medium', low: 'judge.severity.low',
}
const ASPECT_KEYS: Record<JudgeAspect, DeliverablesKey> = {
  request: 'judge.aspect.request', docs: 'judge.aspect.docs', correctness: 'judge.aspect.correctness',
  errors: 'judge.aspect.errors', security: 'judge.aspect.security', tests: 'judge.aspect.tests',
}
const STATUS_KEYS: Record<JudgeCheckStatus, DeliverablesKey> = {
  pass: 'judge.status.pass', warn: 'judge.status.warn', fail: 'judge.status.fail', na: 'judge.status.na',
}

/** The icon of a verdict or a check status. */
function StatusIcon({ status }: { status: JudgeVerdict | JudgeCheckStatus }): ReactNode {
  switch (status) {
    case 'pass': return <IconCheckCircleOutlineRegular size={14} />
    case 'concerns':
    case 'warn': return <IconWarningTriangleOutlineRegular size={14} />
    case 'fail': return <IconCloseCircleFillRegular size={14} />
    case 'na': return <span className={css.dash} aria-hidden>–</span>
  }
}

/**
 * Render the judgment beside a comparison, or the state that stands in for it.
 * @param props - the judgment's state, the retry action, and localized copy. The owner draws
 * no panel for a file the Host has no judgment for.
 * @returns the panel.
 */
export function JudgePanel({ state, retry, t }: {
  state: Exclude<ChangesJudgeState, 'missing'> | undefined
  retry: () => void
} & PropsLocale<typeof NS>): ReactNode {
  const writing = state === undefined || state === 'loading'
  return (
    <aside className={css.panel} aria-label={t('review.judgeAria')} aria-busy={writing || undefined} data-review-judge>
      <h2 className={css.title}><IconShieldOutlineRegular size={14} />{t('judge.title')}</h2>
      {writing ? <p className={css.status}><TextShimmer active>{t('judge.loading')}</TextShimmer></p>
        : state === 'error' ? <div className={css.status}><span>{t('judge.error')}</span><Button size="sm" onClick={retry}>{t('presented.retry')}</Button></div>
          : <>
            <div className={css.verdict} data-verdict={state.verdict}>
              <span className={css.badge}><StatusIcon status={state.verdict} />{t(VERDICT_KEYS[state.verdict])}</span>
              <span className={css.confidenceText}>{t('judge.confidence', { value: String(state.confidence) })}</span>
            </div>
            <div className={css.meter} role="meter" aria-label={t('judge.confidenceAria')}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.confidence} data-verdict={state.verdict}>
              <span className={css.meterFill} style={{ width: `${state.confidence}%` }} />
            </div>
            {state.summary !== '' && <p className={css.text}><InlineCode text={state.summary} /></p>}
            {(!state.basis.docs || !state.basis.request) && <ul className={css.caveats}>
              {!state.basis.docs && <li><IconInfoOutlineRegular size={12} />{t('judge.noDocs')}</li>}
              {!state.basis.request && <li><IconInfoOutlineRegular size={12} />{t('judge.noRequest')}</li>}
            </ul>}
            <section className={css.section}>
              <h3 className={css.heading}>{t('judge.issues')}</h3>
              {state.issues.length === 0 ? <p className={css.muted}>{t('judge.noIssues')}</p>
                : <ul className={css.issues}>{state.issues.map((issue, at) => <li key={at} className={css.issue}
                  data-severity={issue.severity}>
                  <div className={css.issueHead}>
                    <span className={css.severity}>{t(SEVERITY_KEYS[issue.severity])}</span>
                    <span className={css.issueTitle}><InlineCode text={issue.title} /></span>
                  </div>
                  {issue.detail !== '' && <p className={css.detail}><InlineCode text={issue.detail} /></p>}
                  {issue.line !== undefined && <span className={css.muted}>{t('judge.line', { line: String(issue.line) })}</span>}
                </li>)}</ul>}
            </section>
            {state.checks.length > 0 && <section className={css.section}>
              <h3 className={css.heading}>{t('judge.checks')}</h3>
              <ul className={css.checks}>{state.checks.map(check => <li key={check.aspect} className={css.check} data-status={check.status}>
                <span className={css.checkIcon} title={t(STATUS_KEYS[check.status])} aria-label={t(STATUS_KEYS[check.status])} role="img">
                  <StatusIcon status={check.status} />
                </span>
                <span className={css.checkBody}>
                  <span className={css.checkLabel}>{t(ASPECT_KEYS[check.aspect])}</span>
                  {check.note !== '' && <span className={css.muted}><InlineCode text={check.note} /></span>}
                </span>
              </li>)}</ul>
            </section>}
            {state.suggestions.length > 0 && <section className={css.section}>
              <h3 className={css.heading}>{t('judge.suggestions')}</h3>
              <ul className={css.list}>{state.suggestions.map((suggestion, at) => <li key={at}><InlineCode text={suggestion} /></li>)}</ul>
            </section>}
          </>}
    </aside>
  )
}
