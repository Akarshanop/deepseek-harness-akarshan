/**
 * Claude-plan card on the Models page: whether the Claude Code plugin is on,
 * whether Claude Code is signed in with a Claude plan, and the one next step —
 * turn the plugin on, run the sign-in command in Claude Code, or pick the
 * Claude-plan route in the model picker. Sign-in itself never happens here.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClaudePlanState, ClaudePlanStatus, ClaudePlanStore } from './claude-plan.ts'
import type { en } from './locales.ts'
import css from './ChatGptPlanCard.module.css'

/** Injected dependencies of the card (slot `inject`). */
export interface ClaudePlanInjected {
  hooks: {
    /** Claude Code's sign-in state. */
    claudePlan: SnapshotStore<ClaudePlanState>
  }
  /** Status reads. */
  controller: ClaudePlanStore
  /** Places text on the clipboard; resolves whether the browser accepted it. */
  copyText: (text: string) => Promise<boolean>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props of the footer seat. */
export type ClaudePlanFooterProps = PropsRuntime<'settings.models.footer'> & InjectFace<ClaudePlanInjected>

/** Claude Code reports plans in lower case (`pro`, `max`); the product names are capitalized. */
function planName(subscriptionType: string): string {
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
}

/**
 * The footer card.
 * @param props - injected store, actions, and copy.
 * @returns the card once the first status read settles.
 */
export function ClaudePlanFooter(props: ClaudePlanFooterProps): ReactNode {
  const { controller, useClaudePlan, copyText, t } = props
  const state = useClaudePlan(snapshot => snapshot)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  if (state.status === 'idle' || state.status === 'loading') return null

  const recheck = (
    <Button variant="outline" size="sm" disabled={state.busy} onClick={() => { void controller.load() }}>
      {t('claudeCheckAgain')}
    </Button>
  )
  const signInSteps = (plan: ClaudePlanStatus): ReactNode => (
    <>
      <code className={css.command}>{plan.signInCommand}</code>
      <div className={css.actions}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void copyText(plan.signInCommand).then(setCopied) }}
        >
          {copied ? t('claudeCopied') : t('claudeCopyCommand')}
        </Button>
        {recheck}
      </div>
    </>
  )

  let body: ReactNode
  const plan = state.plan
  if (state.status === 'plugin-off') {
    body = (
      <>
        <p className={css.text}>{t('claudePluginOff')}</p>
        <div className={css.actions}>{recheck}</div>
      </>
    )
  } else if (plan === undefined) {
    body = <div className={css.actions}>{recheck}</div>
  } else if (!plan.installed) {
    body = <p className={css.warning} role="status">{t('claudeUnavailable')}</p>
  } else if (plan.usesPlan) {
    const name = plan.subscriptionType === undefined ? undefined : planName(plan.subscriptionType)
    const account = plan.email ?? t('claudeAccountUnknown')
    body = (
      <>
        <p className={css.account}>
          {(name === undefined ? t('claudeSignedIn') : t('claudeSignedInPlan'))
            .replace('{email}', () => account)
            .replace('{plan}', () => name ?? '')}
        </p>
        <p className={css.text}>
          {t('claudeInUse')
            .replace('{route}', () => plan.route.name)
            .replace('{models}', () => plan.route.models.map(model => model.name).join(', '))}
        </p>
        <div className={css.actions}>
          <a className={css.link} href={plan.usageUrl} target="_blank" rel="noopener noreferrer">{t('chatGptManageUsage')}</a>
          {recheck}
        </div>
      </>
    )
  } else if (plan.loggedIn) {
    body = (
      <>
        <p className={css.warning} role="status">{t('claudeNotPlan').replace('{method}', () => plan.authMethod ?? '')}</p>
        {signInSteps(plan)}
      </>
    )
  } else {
    body = (
      <>
        <p className={css.text}>{t('claudeSignInIntro')}</p>
        {signInSteps(plan)}
      </>
    )
  }

  const failure = plan?.error ?? state.error
  return (
    <section className={css.card} aria-label={t('claudeTitle')}>
      <span className={css.title}>{t('claudeTitle')}</span>
      <p className={css.hint}>{t('claudeIntro')}</p>
      {body}
      {failure === undefined ? null : <p className={css.error} role="alert">{t('claudeFailed').replace('{error}', () => failure)}</p>}
    </section>
  )
}
