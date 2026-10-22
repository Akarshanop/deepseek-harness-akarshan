/**
 * Sign in with ChatGPT card: offers "Continue with ChatGPT", shows the waiting
 * attempt and the signed-in account, links to ChatGPT usage settings, and signs
 * out. It renders in the Models page footer and inside the `openai` provider
 * card; both read one {@link ChatGptPlanStore}. A deployment without the Host
 * route renders nothing.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatGptPlanState, ChatGptPlanStore } from './chatgpt-plan.ts'
import { CHATGPT_PLAN_PROVIDER } from './chatgpt-plan.ts'
import type { en } from './locales.ts'
import css from './ChatGptPlanCard.module.css'

/** Injected dependencies of the card (slot `inject`). */
export interface ChatGptPlanInjected {
  hooks: {
    /** Sign-in state shared by every card on the page. */
    plan: SnapshotStore<ChatGptPlanState>
  }
  /** Sign-in actions. */
  controller: ChatGptPlanStore
  /** Opens a page in a new browser tab; returns false when the browser blocked it. */
  openPage: (url: string) => boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props of the footer seat. */
export type ChatGptPlanFooterProps = PropsRuntime<'settings.models.footer'> & InjectFace<ChatGptPlanInjected>

/** Props of the provider-card seat. */
export type ChatGptPlanProviderProps = PropsRuntime<'settings.models.provider-card'> & InjectFace<ChatGptPlanInjected>

/**
 * The footer card on the Models page.
 * @param props - injected store, actions, and copy.
 * @returns the card, or null where the Host serves no sign-in route.
 */
export function ChatGptPlanFooter(props: ChatGptPlanFooterProps): ReactNode {
  return <ChatGptPlanPanel injected={props} framed />
}

/**
 * The same panel inside the add-provider card while `openai` is selected, so
 * signing in is offered where an API key would otherwise be typed. A saved
 * `openai` row renders nothing here: the footer card already shows its state.
 * @param props - the card's directory row plus injected store, actions, and copy.
 * @returns the panel for an unconfigured `openai`, otherwise null.
 */
export function ChatGptPlanProviderExtra(props: ChatGptPlanProviderProps): ReactNode {
  if (props.provider.provider !== CHATGPT_PLAN_PROVIDER || props.configured) return null
  return <ChatGptPlanPanel injected={props} framed={false} />
}

function ChatGptPlanPanel({ injected, framed }: { injected: InjectFace<ChatGptPlanInjected>; framed: boolean }): ReactNode {
  const { controller, usePlan, openPage, t } = injected
  const state = usePlan(snapshot => snapshot)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  if (state.status === 'idle' || state.status === 'loading' || state.status === 'unavailable') return null
  const plan = state.plan

  const begin = (): void => {
    void controller.start((url) => { openPage(url) })
  }

  let body: ReactNode
  if (plan === undefined) {
    body = null
  } else if (plan.pending) {
    body = (
      <>
        <p className={css.text}>{t('chatGptPending')}</p>
        <div className={css.actions}>
          {plan.url === undefined
            ? null
            : <a className={css.link} href={plan.url} target="_blank" rel="noopener noreferrer">{t('chatGptOpenPage')}</a>}
          <Button variant="outline" size="sm" disabled={state.busy} onClick={() => { void controller.cancel() }}>
            {t('chatGptCancel')}
          </Button>
        </div>
      </>
    )
  } else if (plan.signedIn) {
    const models = plan.planModels ?? []
    body = (
      <>
        <p className={css.account}>
          {plan.email === undefined ? t('chatGptSignedInNoEmail') : t('chatGptSignedIn').replace('{email}', () => plan.email ?? '')}
        </p>
        {plan.apiKeyConfigured
          ? <p className={css.warning} role="status">{t('chatGptApiKeyWins')}</p>
          : <p className={css.text}>{t('chatGptInUse')}</p>}
        {models.length === 0 ? null : <p className={css.hint}>{t('chatGptModels').replace('{models}', () => models.join(', '))}</p>}
        {state.justSignedIn === true
          ? (
            <div className={css.confirm} role="status">
              <p className={css.confirmTitle}>{t('chatGptConfirmTitle')}</p>
              <p className={css.text}>{t('chatGptConfirmBody')}</p>
              <div className={css.actions}>
                <Button variant="primary" size="sm" onClick={() => { controller.acknowledge() }}>{t('chatGptConfirmDismiss')}</Button>
              </div>
            </div>
          )
          : null}
        <div className={css.actions}>
          <a className={css.link} href={plan.usageUrl} target="_blank" rel="noopener noreferrer">{t('chatGptManageUsage')}</a>
          <Button variant="outline" size="sm" disabled={state.busy} onClick={() => { void controller.signOut() }}>
            {state.busy ? t('chatGptSigningOut') : t('chatGptSignOut')}
          </Button>
        </div>
      </>
    )
  } else {
    body = (
      <>
        <p className={css.text}>{t('chatGptIntro')}</p>
        {plan.revocation === 'unconfirmed' ? <p className={css.warning} role="status">{t('chatGptRevokeUnconfirmed')}</p> : null}
        <div className={css.actions}>
          <Button variant="primary" size="sm" className={css.continue} disabled={state.busy} onClick={begin}>
            {t('chatGptContinue')}
          </Button>
        </div>
      </>
    )
  }

  const failure = plan?.error ?? state.error
  return (
    <section className={framed ? css.card : css.inline} aria-label={t('chatGptTitle')}>
      <span className={css.title}>{t('chatGptTitle')}</span>
      {body}
      {failure === undefined ? null : <p className={css.error} role="alert">{t('chatGptFailed').replace('{error}', () => failure)}</p>}
    </section>
  )
}
