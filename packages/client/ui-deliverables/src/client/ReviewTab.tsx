/**
 * The review tab: one turn's changed files behind a file selector, with the
 * selected file's turn-start and turn-end comparison drawn unified or side by
 * side, wrapped or scrolling, beside the model's judgment of the change and
 * its explanation of the file, and controls to open the file itself.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconCompareSplitOutlineRegular, IconInspectOutlineRegular,
  IconNowrapFillRegular, IconShieldOutlineRegular, IconSparkleRegular, IconWrapFillRegular, Menu, PathLabel, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceChangedFile } from '@deepseek-ai/dsh-workspace-changes/types'
import {
  changedFileUrl, changesDiffUrl, changesExplainUrl, changesJudgeUrl, changesSummaryUrl, parseChangesReviewAddress,
} from '../changes.ts'
import type { ChangesDiffStore } from './changes-diff.ts'
import type { ChangesExplainStore } from './changes-explain.ts'
import type { ChangesJudgeStore } from './changes-judge.ts'
import type { ChangesSummaryStore } from './changes-summary.ts'
import type { PresentedOpenController } from './present-open.ts'
import type { ChangesReviewParams } from './review-definition.ts'
import type { createReviewStore } from './review-store.ts'
import type { NS } from './locales.ts'
import { ExplainPanel } from './ExplainPanel.tsx'
import { FileDiff } from './FileDiff.tsx'
import { JudgePanel } from './JudgePanel.tsx'
import diffCss from './FileDiff.module.css'
import css from './ReviewTab.module.css'

const GROUPED = new Intl.NumberFormat('en-US')

/** Summary, comparison, explanation, and judgment reads, desktop metadata, and the native open supplied by the plugin. */
export interface ReviewInjected {
  hooks: {
    changesSummary: ObservableSnapshot<ReturnType<ChangesSummaryStore['state']['getSnapshot']>>
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
    changesExplain: ObservableSnapshot<ReturnType<ChangesExplainStore['state']['getSnapshot']>>
    changesJudge: ObservableSnapshot<ReturnType<ChangesJudgeStore['state']['getSnapshot']>>
    presentedOpen: ObservableSnapshot<ReturnType<PresentedOpenController['state']['getSnapshot']>>
    presentedHost: ObservableSnapshot<ReturnType<PresentedOpenController['host']['getSnapshot']>>
  }
  loadChangesSummary: ChangesSummaryStore['load']
  loadChangesDiff: ChangesDiffStore['load']
  loadChangesExplain: ChangesExplainStore['load']
  loadChangesJudge: ChangesJudgeStore['load']
  reloadPresentedHost: PresentedOpenController['loadHost']
  openChanged: PresentedOpenController['openChanged']
}

/** The body's composed props: the tab it draws, its store, its injected face, and its copy. */
export type ReviewTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsStore<ReturnType<typeof createReviewStore>>
  & InjectFace<ReviewInjected> & PropsLocale<typeof NS> & PropsRenderSlots<'deliverables.review.file.actions'>

/** The file index a navigation names, when it names one. */
function navigatedIndex(params: unknown): number | undefined {
  const index = (params as ChangesReviewParams | undefined)?.index
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
}

/** Added and deleted line counts in the card's colors. */
function Counts({ file, t }: { file: WorkspaceChangedFile } & PropsLocale<typeof NS>): ReactNode {
  if (file.binary === true) return <span className={css.label}>{t('changes.binary')}</span>
  if (file.oversized === true) return <span className={css.label}>{t('changes.oversized')}</span>
  return <>
    <span className={css.added}>{t('changes.added', { count: GROUPED.format(file.added) })}</span>
    <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(file.deleted) })}</span>
  </>
}

/**
 * The review type's body, registered under `sidebar.right.pane.tab` as `changes-review`.
 * @param props - composed slot props.
 * @returns the selected file's comparison behind the file selector, or the state that stands in for it.
 */
export function ReviewTab({
  useTabInfo, useSessions, useStore, actions, useChangesSummary, useChangesDiff, useChangesExplain, useChangesJudge, usePresentedOpen,
  usePresentedHost, loadChangesSummary, loadChangesDiff, loadChangesExplain, loadChangesJudge, reloadPresentedHost, openChanged, t,
  renderSlot,
}: ReviewTabProps): ReactNode {
  const { tab } = useTabInfo()
  const { navigation, signal } = tab
  const coordinates = useMemo(() => parseChangesReviewAddress(tab.contentId), [tab.contentId])
  if (coordinates === undefined) throw new Error(`ui-deliverables: not a review address "${tab.contentId}"`)
  // The address names the reviewed Session. The hosting sidebar's Session (the `sessionId` prop) can differ,
  // because a card in any pane opens its review in the selected Session's sidebar.
  const { seq, sessionId } = coordinates
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const summary = useChangesSummary(value => value[changesSummaryUrl(sessionId, seq)])
  const state = useStore(store => store.byTab[tab.id])
  const host = usePresentedHost(value => value)
  // Every navigation to this tab applies its file index once; the first one seeds the tab's choices.
  useEffect(() => {
    if (state?.navigated === navigation.revision) return
    actions.navigated(tab.id, navigation.revision, navigatedIndex(navigation.params) ?? state?.index ?? 0)
  }, [state, navigation.revision, navigation.params, actions, tab.id])
  useEffect(() => {
    const forget = (): void => { actions.forget(tab.id) }
    signal.addEventListener('abort', forget, { once: true })
    return () => { signal.removeEventListener('abort', forget) }
  }, [signal, actions, tab.id])
  useEffect(() => {
    if (summary === undefined) void loadChangesSummary(sessionId, seq)
  }, [summary, sessionId, seq, loadChangesSummary])
  useEffect(() => {
    if (host === null) void reloadPresentedHost()
  }, [host, reloadPresentedHost])
  const files = typeof summary === 'object' ? summary.files : []
  // A navigated index the summary does not list falls back to the first file.
  const index = state !== undefined && files[state.index] !== undefined ? state.index : 0
  const file = files[index]
  const diffState = useChangesDiff(value => file === undefined ? undefined : value[changesDiffUrl(sessionId, seq, index)])
  useEffect(() => {
    if (file !== undefined && diffState === undefined) void loadChangesDiff(sessionId, seq, index)
  }, [file, diffState, sessionId, seq, index, loadChangesDiff])
  // A binary or oversized file has no text for a model to explain.
  const explainable = file !== undefined && file.binary !== true && file.oversized !== true
  const explainState = useChangesExplain(value => explainable ? value[changesExplainUrl(sessionId, seq, index)] : undefined)
  const showExplain = explainable && state?.explain !== false && explainState !== 'missing'
  // The read waits for the seeded tab state, whose index may name another file than the first render's.
  const reading = explainable && state?.explain === true
  useEffect(() => {
    if (reading && explainState === undefined) void loadChangesExplain(sessionId, seq, index)
  }, [reading, explainState, sessionId, seq, index, loadChangesExplain])
  const judgeState = useChangesJudge(value => explainable ? value[changesJudgeUrl(sessionId, seq, index)] : undefined)
  const showJudge = explainable && state?.judge !== false && judgeState !== 'missing'
  const judging = explainable && state?.judge === true
  useEffect(() => {
    if (judging && judgeState === undefined) void loadChangesJudge(sessionId, seq, index)
  }, [judging, judgeState, sessionId, seq, index, loadChangesJudge])
  const phase = usePresentedOpen(value => file === undefined ? undefined : value[changedFileUrl(sessionId, seq, index)])
  const [menuOpen, setMenuOpen] = useState(false)
  const split = state?.split === true
  const wrap = state?.wrap === true
  const native = host !== null && host !== 'error' && host.available && phase !== 'nativeUnavailable'
  const summaryState = summary === undefined || summary === 'loading' ? 'loading' : summary === 'missing' ? 'missing' : 'ready'
  return (
    <div className={`${diffCss.root} ${css.root}`} data-changes-review data-review-state={summaryState}>
      <div className={diffCss.header}>
        {file === undefined
          ? <span className={css.selectorLabel}>{t('review.title', { turn: String(coordinates.turn) })}</span>
          : <Menu className={css.selector} open={menuOpen} autoFocus portal align="start" dense onClose={() => { setMenuOpen(false) }}
            anchor={<button type="button" className={css.selectorButton} aria-haspopup="menu" aria-expanded={menuOpen}
              aria-label={t('review.selectFile')} title={file.display} data-review-file={file.path}
              onClick={() => { setMenuOpen(value => !value) }}>
              <PathLabel path={file.display} />
              <IconChevronDownOutlineRegular size={12} />
            </button>}
            items={files.map((entry, at) => ({ id: String(at), label: <span className={css.item}>
              <span className={css.itemPath}>{entry.display}</span>
              <span className={css.itemCounts}><Counts file={entry} t={t} /></span>
            </span> }))}
            selectedId={String(index)}
            onSelect={(id) => { actions.selected(tab.id, Number(id)); setMenuOpen(false) }} />}
        {file !== undefined && <span className={css.counts}><Counts file={file} t={t} /></span>}
        <span className={css.tools}>
          <Tooltip label={t(split ? 'review.unified' : 'review.split')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-pressed={split} aria-label={t('review.splitAria')} data-review-tool="split"
              onClick={() => { actions.toggledSplit(tab.id) }}>
              <IconCompareSplitOutlineRegular className={css.compareIcon} />
            </button>
          </Tooltip>
          <Tooltip label={t(wrap ? 'review.nowrap' : 'review.wrap')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-pressed={wrap} aria-label={t('review.wrapAria')} data-review-tool="wrap"
              onClick={() => { actions.toggledWrap(tab.id) }}>
              {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
            </button>
          </Tooltip>
          {explainable && judgeState !== 'missing' && <Tooltip label={t(showJudge ? 'review.judgeHide' : 'review.judgeShow')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-pressed={showJudge} aria-label={t('review.judgeAria')} data-review-tool="judge"
              onClick={() => { actions.toggledJudge(tab.id) }}>
              <IconShieldOutlineRegular />
            </button>
          </Tooltip>}
          {explainable && explainState !== 'missing' && <Tooltip label={t(showExplain ? 'review.explainHide' : 'review.explainShow')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-pressed={showExplain} aria-label={t('review.explainAria')} data-review-tool="explain"
              onClick={() => { actions.toggledExplain(tab.id) }}>
              <IconSparkleRegular />
            </button>
          </Tooltip>}
          {file !== undefined && <Tooltip label={t('review.openFile')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-label={t('review.openFileAria', { name: file.display })} data-review-tool="open-file"
              onClick={() => { tab.actions.openResource(fileAddressFor(sessionId, cwd, file.path)) }}><IconInspectOutlineRegular /></button>
          </Tooltip>}
          {file !== undefined && renderSlot('deliverables.review.file.actions', {
            actionUrl: changedFileUrl(sessionId, seq, index), available: native,
            pending: phase === 'opening' || phase === 'revealing',
            onAction: (action, application) => openChanged(sessionId, seq, index, action, application),
          })}
        </span>
      </div>
      {summaryState === 'loading' && <p className={diffCss.status} role="status">{t('diff.loading')}</p>}
      {summaryState === 'missing' && <p className={diffCss.status}>{t('diff.missing')}</p>}
      {file !== undefined && <div className={css.content}>
        <div className={css.split}>
          <div className={css.diff}>
            <FileDiff state={diffState} split={split} wrap={wrap} t={t}
              retry={() => { void loadChangesDiff(sessionId, seq, index) }} />
          </div>
          {(showJudge || showExplain) && <div className={css.panels}>
            {showJudge && <JudgePanel state={judgeState} t={t}
              retry={() => { void loadChangesJudge(sessionId, seq, index) }} />}
            {showExplain && <ExplainPanel state={explainState} t={t}
              retry={() => { void loadChangesExplain(sessionId, seq, index) }} />}
          </div>}
        </div>
      </div>}
    </div>
  )
}
