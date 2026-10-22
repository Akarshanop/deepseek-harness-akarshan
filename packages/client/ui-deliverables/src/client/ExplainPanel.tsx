/** The model's explanation of one changed file: what the file is for and what the turn changed in it. */
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button, IconSparkleRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesExplainState } from './changes-explain.ts'
import type { NS } from './locales.ts'
import css from './ExplainPanel.module.css'

/**
 * Text with its backtick-quoted identifiers set as code; the model's text is never read as markup.
 * @param props - the text.
 * @returns the text with code spans.
 */
export function InlineCode({ text }: { text: string }): ReactNode {
  return text.split(/`([^`]+)`/).map((part, at) => at % 2 === 1
    ? <code key={at} className={css.code}>{part}</code>
    : <Fragment key={at}>{part}</Fragment>)
}

/**
 * Render the explanation beside a comparison, or the state that stands in for it.
 * @param props - the explanation's state, the retry action, and localized copy. The owner draws
 * no panel for a file the Host has no explanation for.
 * @returns the panel.
 */
export function ExplainPanel({ state, retry, t }: {
  state: Exclude<ChangesExplainState, 'missing'> | undefined
  retry: () => void
} & PropsLocale<typeof NS>): ReactNode {
  const writing = state === undefined || state === 'loading'
  return (
    <aside className={css.panel} aria-label={t('review.explainAria')} aria-busy={writing || undefined} data-review-explain>
      <h2 className={css.title}><IconSparkleRegular size={14} />{t('explain.title')}</h2>
      {writing ? <p className={css.status}><TextShimmer active>{t('explain.loading')}</TextShimmer></p>
        : state === 'error' ? <div className={css.status}><span>{t('explain.error')}</span><Button size="sm" onClick={retry}>{t('presented.retry')}</Button></div>
          : <>
            {state.purpose !== '' && <section className={css.section}>
              <h3 className={css.heading}>{t('explain.purpose')}</h3>
              <p className={css.text}><InlineCode text={state.purpose} /></p>
            </section>}
            {state.changes.length > 0 && <section className={css.section}>
              <h3 className={css.heading}>{t('explain.changes')}</h3>
              <ul className={css.list}>{state.changes.map((change, at) => <li key={at}><InlineCode text={change} /></li>)}</ul>
            </section>}
          </>}
    </aside>
  )
}
