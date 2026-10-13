// The Side Q&A tab: every question asked about a highlighted passage, each with
// its answer and the exact request that produced it. Nothing here is part of the
// conversation the Agent sees.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SideQuestionRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { markdownLabels } from '../markdown-labels.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { PendingSideQuestion, SideQaSource } from './side-qa-source.ts'
import css from './SideQaView.module.css'

/** Id of the `conversation.view` entry this tab registers. */
export const SIDE_QA_VIEW_ID = 'side-qa'

/** Source injected into the tab for the current Session. */
export interface SideQaViewInjected {
  readonly source: SideQaSource
}

type Translate = ChatViewSlotProps['t']

export function SideQaView({
  source, viewRequest, completeViewRequest, t,
}: ConvViewProps & InjectFace<SideQaViewInjected> & PropsLocale<'chat'>) {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const labels = useMemo(() => markdownLabels(t), [t])
  useEffect(() => { void source.refresh() }, [source])
  const requested = viewRequest?.view === SIDE_QA_VIEW_ID
  useEffect(() => {
    if (requested) completeViewRequest()
  }, [requested, completeViewRequest])

  const empty = state.loaded && state.records.length === 0 && state.pending.length === 0
  return (
    <div className={css.root}>
      <p className={css.notice}>{t('sideQa.notice')}</p>
      {state.loadFailure !== undefined && <p className={css.failure}>{t('sideQa.loadFailed', { message: state.loadFailure })}</p>}
      {empty && <p className={css.empty}>{t('sideQa.empty')}</p>}
      {state.records.map(record => (
        <RecordCard key={record.id} record={record} labels={labels} t={t}
          onDelete={() => { void source.remove(record.id) }} />
      ))}
      {state.pending.map(item => (
        <PendingCard key={item.key} item={item} t={t} onDismiss={() => { source.dismiss(item.key) }} />
      ))}
    </div>
  )
}

function Quote({ selection, question }: { selection: string; question: string }) {
  return (
    <>
      <blockquote className={css.quote}>{selection}</blockquote>
      <p className={css.question}>{question}</p>
    </>
  )
}

function PendingCard({ item, t, onDismiss }: { item: PendingSideQuestion; t: Translate; onDismiss: () => void }) {
  return (
    <article className={css.card}>
      <Quote selection={item.selection} question={item.question} />
      {item.failure === undefined
        ? <p className={css.status}>{t('sideQa.asking')}</p>
        : (
          <>
            <p className={css.failure}>{t('sideQa.failed', { message: item.failure })}</p>
            <Button size="sm" variant="outline" onClick={onDismiss}>{t('close')}</Button>
          </>
        )}
    </article>
  )
}

function RecordCard({ record, labels, t, onDelete }: {
  record: SideQuestionRecord
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  onDelete: () => void
}) {
  return (
    <article className={css.card}>
      <Quote selection={record.selection} question={record.question} />
      {record.error === undefined
        ? <div className={css.answer}><MarkdownText text={record.answer} streaming={false} labels={labels} /></div>
        : <p className={css.failure}>{t('sideQa.failed', { message: record.error })}</p>}
      <details className={css.sent}>
        <summary>{t('sideQa.sent')}</summary>
        <dl>
          <dt>{t('sideQa.model')}</dt>
          <dd>{record.provider} / {record.model}</dd>
          <dt>{t('sideQa.context')}</dt>
          <dd>{t('sideQa.contextCount', { count: record.contextMessageCount })}</dd>
          <dt>{t('sideQa.system')}</dt>
          <dd><pre>{record.system}</pre></dd>
          <dt>{t('sideQa.userPrompt')}</dt>
          <dd><pre>{record.prompt}</pre></dd>
        </dl>
      </details>
      <div className={css.footer}>
        <time dateTime={record.askedAt}>{new Date(record.askedAt).toLocaleString()}</time>
        <Button size="sm" variant="ghost" onClick={onDelete}>{t('sideQa.delete')}</Button>
      </div>
    </article>
  )
}
