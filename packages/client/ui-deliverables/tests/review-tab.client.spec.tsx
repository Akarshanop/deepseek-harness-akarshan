// @vitest-environment jsdom
/** The review tab type: its addresses, its store, the row pairing of the split view, and the states its body draws. */
import { renderFileActions } from './file-actions.tsx'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types'
import {
  changesDiffUrl, changesExplainUrl, changesJudgeUrl, changesReviewAddress, changesSummaryUrl, parseChangesReviewAddress,
  type ChangesDiff, type ChangesExplanation, type ChangesJudgment, type ChangesSummary,
} from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { ChangesExplainStore } from '../src/client/changes-explain.ts'
import { ChangesJudgeStore } from '../src/client/changes-judge.ts'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'
import {
  ReviewTab, type ReviewInjected, type ReviewTabProps,
} from '../src/client/ReviewTab.tsx'
import { hunkRows, MAX_RENDERED_LINES, renderedHunks, splitRows } from '../src/client/FileDiff.tsx'
import { changesReviewDefinition } from '../src/client/review-definition.ts'
import { createReviewStore } from '../src/client/review-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SESSION = SessionId('viewed')
const TAB = 'tab-1' as TabId
const COORDINATES = { sessionId: SESSION, seq: 5, turn: 2 }
const ADDRESS = changesReviewAddress(COORDINATES)
const SUMMARY_URL = changesSummaryUrl(SESSION, 5)

const summary: ChangesSummary = {
  turn: 2, total: 4, added: 4, deleted: 2,
  files: [
    { path: 'src/app/main.ts', display: 'src/app/main.ts', added: 3, deleted: 1 },
    { path: '/tmp/out/big.bin', display: '~/out/big.bin', added: 0, deleted: 0, oversized: true },
    { path: 'notes.txt', display: 'notes.txt', added: 1, deleted: 1 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
  ],
}

const text: ChangesDiff = {
  kind: 'text', path: 'src/app/main.ts', display: 'src/app/main.ts', before: true, after: true, coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+c', ' d'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-x', '+y'] },
    { oldStart: 20, oldLines: 1, newStart: 22, newLines: 0, lines: ['-z'] },
  ],
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

describe('review addresses', () => {
  it('round-trips coordinates and titles the tab by the turn', () => {
    expect(ADDRESS).toBe('dsh-resource://changes-review/session/viewed/5/2')
    expect(parseChangesReviewAddress(ADDRESS)).toEqual(COORDINATES)
    const definition = changesReviewDefinition(makeTranslate(zh))
    expect(definition).toMatchObject({ kind: 'changes-review', priority: 'builtin', patterns: ['dsh-resource://changes-review/**'] })
    expect(definition.canOpen?.(ADDRESS)).toBe(true)
    expect(definition.title(ADDRESS)).toBe('第 2 轮改动')
    for (const bad of [
      'dsh-resource://file/session/viewed/a.ts', 'dsh-resource://changes-review/session/viewed/5',
      'dsh-resource://changes-review/session//5/2', 'dsh-resource://changes-review/session/viewed/x/2',
      'dsh-resource://changes-review/session/viewed/5/0', 'dsh-resource://changes-review/session/%E0%A4%A/5/2',
    ]) {
      expect(parseChangesReviewAddress(bad)).toBeUndefined()
      expect(definition.canOpen?.(bad)).toBe(false)
      expect(definition.title(bad)).toBe(bad)
    }
  })
})

describe('review store', () => {
  it('seeds a tab on its first navigation, applies later ones, toggles views, and forgets', () => {
    const store = createReviewStore().create()
    store.actions.navigated(TAB, 1, 2)
    expect(store.getSnapshot().byTab[TAB]).toEqual({ index: 2, split: true, wrap: false, explain: true, judge: true, navigated: 1 })
    store.actions.toggledSplit(TAB)
    store.actions.toggledWrap(TAB)
    store.actions.toggledExplain(TAB)
    store.actions.toggledJudge(TAB)
    store.actions.selected(TAB, 0)
    store.actions.navigated(TAB, 2, 1)
    expect(store.getSnapshot().byTab[TAB]).toEqual({ index: 1, split: false, wrap: true, explain: false, judge: false, navigated: 2 })
    store.actions.forget(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(() => { store.actions.selected(TAB, 0) }).toThrow('no review state')
  })
})

describe('hunk rows', () => {
  it('numbers unified rows on the side they belong to and pairs deletions with additions for the split view', () => {
    expect(hunkRows(text.hunks[0]!)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: undefined, text: 'b' },
      { kind: 'add', old: undefined, new: 2, text: 'B' },
      { kind: 'add', old: undefined, new: 3, text: 'c' },
      { kind: 'context', old: 3, new: 4, text: 'd' },
    ])
    expect(splitRows(text.hunks[0]!)).toEqual([
      { left: { no: 1, text: 'a', kind: 'context' }, right: { no: 1, text: 'a', kind: 'context' } },
      { left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: 'B', kind: 'add' } },
      { right: { no: 3, text: 'c', kind: 'add' } },
      { left: { no: 3, text: 'd', kind: 'context' }, right: { no: 4, text: 'd', kind: 'context' } },
    ])
    // A trailing run of deletions with no additions ends the hunk on the left alone.
    expect(splitRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-p', '-q'] })).toEqual([
      { left: { no: 1, text: 'p', kind: 'del' } }, { left: { no: 2, text: 'q', kind: 'del' } },
    ])
  })

  it('cuts the drawn hunks at the rendered-line cap', () => {
    const long = (count: number): string[] => Array.from({ length: count }, (_, at) => `+line ${at}`)
    const whole: WorkspaceDiffHunk = {
      oldStart: 1, oldLines: 0, newStart: 1, newLines: MAX_RENDERED_LINES + 2, lines: long(MAX_RENDERED_LINES + 2),
    }
    const cut = renderedHunks([whole])
    expect(cut.truncated).toBe(true)
    expect(cut.hunks[0]!.lines).toHaveLength(MAX_RENDERED_LINES)
    const small: WorkspaceDiffHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    expect(renderedHunks([small, small])).toEqual({ hunks: [small, small], truncated: false })
    const two = renderedHunks([{ ...whole, lines: long(MAX_RENDERED_LINES) }, small])
    expect(two.hunks).toHaveLength(1)
    expect(two.truncated).toBe(true)
  })
})

describe('ReviewTab', () => {
  function mount(options: {
    summaries?: ChangesSummaryStore
    diffs?: ChangesDiffStore
    explanations?: ChangesExplainStore
    judgments?: ChangesJudgeStore
    controller?: PresentedOpenController
    locale?: typeof en
    params?: unknown
    revision?: number
    address?: string
    cwd?: string | undefined
    /** The Session whose sidebar hosts the tab; defaults to the Session the address names. */
    hostSessionId?: SessionId
  } = {}) {
    const summaries = options.summaries ?? new ChangesSummaryStore()
    const diffs = options.diffs ?? new ChangesDiffStore()
    const explanations = options.explanations ?? new ChangesExplainStore()
    const judgments = options.judgments ?? new ChangesJudgeStore()
    const controller = options.controller ?? new PresentedOpenController()
    const store = createReviewStore().create()
    const aborter = new AbortController()
    const tabActions = {
      openResource: vi.fn<SidebarRightTabActions['openResource']>(),
      openTab: vi.fn<SidebarRightTabActions['openTab']>(),
      close: vi.fn<SidebarRightTabActions['close']>(),
    }
    const injected = {
      loadChangesSummary: vi.fn<ReviewInjected['loadChangesSummary']>(() => Promise.resolve()),
      loadChangesDiff: vi.fn<ReviewInjected['loadChangesDiff']>(() => Promise.resolve()),
      loadChangesExplain: vi.fn<ReviewInjected['loadChangesExplain']>(() => Promise.resolve()),
      loadChangesJudge: vi.fn<ReviewInjected['loadChangesJudge']>(() => Promise.resolve()),
      reloadPresentedHost: vi.fn<ReviewInjected['reloadPresentedHost']>(() => Promise.resolve()),
      openChanged: vi.fn<ReviewInjected['openChanged']>(() => Promise.resolve(null)),
    }
    const hostSessionId = options.hostSessionId ?? SESSION
    const sessions: SessionListState = {
      ids: hostSessionId === SESSION ? [SESSION] : [hostSessionId, SESSION],
      byId: {
        [SESSION]: { id: SESSION, displayTitle: 'Workspace', cwd: options.cwd ?? '/work/app',
          running: false, retainedBy: {}, blank: false, updatedAt: 0 },
        [hostSessionId]: { id: hostSessionId, displayTitle: 'Workspace', cwd: hostSessionId === SESSION ? options.cwd ?? '/work/app' : '/work/other',
          running: false, retainedBy: {}, blank: false, updatedAt: 0 },
      },
      phase: 'ready', projectionsBySession: {},
    }
    const navigation = { address: options.address ?? ADDRESS, params: options.params, revision: options.revision ?? 1 }
    const runtime = {
      renderSlot: renderFileActions,
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' },
        tab: { id: TAB, kind: 'changes-review', contentId: options.address ?? ADDRESS, title: 'Review', visible: true, navigation, signal: aborter.signal, actions: tabActions },
      }),
      sessionId: hostSessionId,
      useSessions: <T,>(select: (state: SessionListState) => T): T => select(sessions),
      useStore: hookOf(store),
      actions: store.actions,
      useChangesSummary: hookOf(summaries.state),
      useChangesDiff: hookOf(diffs.state),
      useChangesExplain: hookOf(explanations.state),
      useChangesJudge: hookOf(judgments.state),
      usePresentedOpen: hookOf(controller.state),
      usePresentedHost: hookOf(controller.host),
      t: makeTranslate(options.locale ?? en),
      ...injected,
    } as ReviewTabProps
    const view = render(<ReviewTab {...runtime} />)
    return {
      view, injected, tabActions, store, aborter, summaries, diffs, explanations, judgments, controller,
      rerender: () => { view.rerender(<ReviewTab {...runtime} />) },
    }
  }

  it('reads the summary, opens on the navigated file, and switches files through the selector', () => {
    const summaries = new ChangesSummaryStore()
    const diffs = new ChangesDiffStore()
    const { view, injected, store } = mount({ summaries, diffs, params: { index: 2 } })
    expect(injected.loadChangesSummary).toHaveBeenCalledWith('viewed', 5)
    expect(injected.reloadPresentedHost).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-changes-review]')?.getAttribute('data-review-state')).toBe('loading')
    expect(view.getByText('Review · turn 2')).toBeTruthy()
    act(() => { summaries.state.set({ [SUMMARY_URL]: summary }) })
    expect(store.getSnapshot().byTab[TAB]).toMatchObject({ index: 2, navigated: 1 })
    const selector = view.getByRole('button', { name: en['review.selectFile'] })
    expect(selector.getAttribute('data-review-file')).toBe('notes.txt')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 2)
    expect(view.getAllByText('+1')).toHaveLength(1)
    fireEvent.click(selector)
    expect(selector.getAttribute('aria-expanded')).toBe('true')
    // Escape closes the selector without changing the file.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByRole('button', { name: en['review.selectFile'] }))
    const items = view.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual([
      'src/app/main.ts+3-1', '~/out/big.bin' + en['changes.oversized'], 'notes.txt+1-1', 'logo.png' + en['changes.binary'],
    ])
    fireEvent.click(items[0]!)
    expect(store.getSnapshot().byTab[TAB]?.index).toBe(0)
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('data-review-file')).toBe('src/app/main.ts')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 0)
    act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: text }) })
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('split')
    fireEvent.click(view.getByRole('button', { name: en['review.splitAria'] }))
    const lines = [...view.container.querySelectorAll('[data-diff-line]')]
    expect(lines.map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'add', 'context', 'del', 'add', 'del'])
    expect(lines[1]?.textContent).toBe('2-b')
    expect(lines[4]?.textContent).toBe('34 d')
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
  })

  it('reads the Session its address names when another Session\'s sidebar hosts the tab', () => {
    // A card in one pane opens its review in the selected Session's sidebar, so the hosting Session is not the reviewed one.
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const controller = new PresentedOpenController()
    controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
    const { view, injected, tabActions } = mount({ summaries, controller, hostSessionId: SessionId('host'), params: { index: 1 } })
    expect(injected.loadChangesSummary).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-changes-review]')?.getAttribute('data-review-state')).toBe('ready')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 1)
    fireEvent.click(view.getByRole('button', { name: 'Open ~/out/big.bin in sidebar' }))
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, '/work/app', '/tmp/out/big.bin'))
    fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
    expect(injected.openChanged).toHaveBeenCalledWith('viewed', 5, 1, 'open', undefined)
  })

  it('draws the split view by default and wraps lines on request, and keeps both choices in the tab store', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: text })
    const { view, store } = mount({ summaries, diffs })
    expect(store.getSnapshot().byTab[TAB]?.index).toBe(0)
    expect(store.getSnapshot().byTab[TAB]?.split).toBe(true)
    const body = view.container.querySelector('[data-review-view]')
    expect(body?.getAttribute('data-review-view')).toBe('split')
    expect(body?.hasAttribute('data-review-wrap')).toBe(false)
    // Without wrapping each side is its own column, so a long line scrolls within its side.
    const side = (name: string) => [...view.container.querySelectorAll(`[data-diff-side="${name}"] [data-diff-line]`)]
    expect(side('left').map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'context', 'del', 'del'])
    expect(side('left').map(line => line.textContent)).toEqual(['1a', '2b', '', '3d', '10x', '20z'])
    expect(side('right').map(line => line.textContent)).toEqual(['1a', '2B', '3c', '4d', '11y', ''])
    // The two sides scroll together on both axes, whichever side the reader drags.
    const [left, right] = ['left', 'right'].map(name => view.container.querySelector(`[data-diff-side="${name}"]`) as HTMLDivElement)
    fireEvent.scroll(left!, { target: { scrollLeft: 40, scrollTop: 66 } })
    expect([right!.scrollLeft, right!.scrollTop]).toEqual([40, 66])
    fireEvent.scroll(right!, { target: { scrollLeft: 15 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 66])
    fireEvent.scroll(right!, { target: { scrollTop: 22 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 22])
    fireEvent.scroll(right!, { target: { scrollLeft: 15, scrollTop: 22 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 22])
    // A short peer clamps horizontal writes to zero, including the resulting scroll event.
    Object.defineProperty(right, 'scrollLeft', { configurable: true, get: () => 0, set: () => {} })
    fireEvent.scroll(left!, { target: { scrollLeft: 100 } })
    fireEvent.scroll(right!)
    expect(left!.scrollLeft).toBe(100)
    fireEvent.scroll(left!, { target: { scrollTop: 44 } })
    fireEvent.scroll(right!)
    expect([left!.scrollLeft, right!.scrollTop]).toEqual([100, 44])
    expect(view.getByRole('button', { name: en['review.splitAria'] }).getAttribute('aria-pressed')).toBe('true')
    // Wrapped lines vary in height, so both sides share one row per pair.
    fireEvent.click(view.getByRole('button', { name: en['review.wrapAria'] }))
    expect(view.container.querySelector('[data-review-view]')?.hasAttribute('data-review-wrap')).toBe(true)
    expect(view.container.querySelectorAll('[data-diff-side]')).toHaveLength(0)
    const rows = [...view.container.querySelectorAll('[data-diff-line]')]
    expect(rows.map(row => row.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'context', 'del', 'del'])
    expect(rows[1]?.textContent).toBe('2b2B')
    expect(rows[2]?.textContent).toBe('3c')
    expect(rows[5]?.textContent).toBe('20z')
    expect(store.getSnapshot().byTab[TAB]).toMatchObject({ split: true, wrap: true })

    const oneSidedHunks: WorkspaceDiffHunk[] = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] },
      { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-old'] },
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' context', '+new'] },
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [' context', '-old'] },
    ]
    for (const wrap of [true, false]) {
      if (!wrap) fireEvent.click(view.getByRole('button', { name: en['review.wrapAria'] }))
      for (const hunk of oneSidedHunks) {
        act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: { ...text, hunks: [hunk] } }) })
        expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
        expect(view.container.querySelectorAll('[data-diff-line]')).toHaveLength(hunk.lines.length)
        expect(view.getByRole('button', { name: en['review.splitAria'] }).getAttribute('aria-pressed')).toBe('true')
        expect(store.getSnapshot().byTab[TAB]).toMatchObject({ split: true, wrap })
      }
      act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: { ...text, hunks: oneSidedHunks } }) })
      expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('split')
    }
  })

  it('syntax-highlights recognized source files with the shared code grammar', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    diffs.state.set({
      [changesDiffUrl(SESSION, 5, 0)]: {
        ...text,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-const before = 1', '-', '+const after = 2', '+'] }],
      },
    })
    const { view } = mount({ summaries, diffs })
    const highlighted = [...view.container.querySelectorAll('[data-diff-code]')]
    expect(highlighted.map(line => line.textContent)).toEqual(['const before = 1', '', 'const after = 2', ''])
    expect(view.container.querySelectorAll('[data-diff-code] span[style]').length).toBeGreaterThan(2)
  })

  it('keeps unknown source files as plain text', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: { ...summary, files: [{ ...summary.files[0]!, path: 'notes.unknown' }] } })
    const diffs = new ChangesDiffStore()
    diffs.state.set({
      [changesDiffUrl(SESSION, 5, 0)]: {
        ...text,
        path: 'notes.unknown',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      },
    })
    const { view } = mount({ summaries, diffs })
    expect(view.container.querySelector('[data-diff-code]')).toBeNull()
    expect(view.getByText('before')).toBeTruthy()
    expect(view.getByText('after')).toBeTruthy()
  })

  it('opens the whole file in the sidebar and the native open only with a desktop', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const controller = new PresentedOpenController()
    controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
    const { view, injected, tabActions } = mount({ summaries, controller, params: { index: 1 } })
    expect(injected.reloadPresentedHost).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-review-tool="open-file"] svg')?.getAttribute('width')).toBe('12')
    fireEvent.click(view.getByRole('button', { name: 'Open ~/out/big.bin in sidebar' }))
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, '/work/app', '/tmp/out/big.bin'))
    fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
    expect(injected.openChanged).toHaveBeenCalledWith('viewed', 5, 1, 'open', undefined)
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'opening' }) })
    expect((view.getByRole('button', { name: 'Native file action' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'error' }) })
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'nativeUnavailable' }) })
    expect(view.queryByRole('button', { name: 'Native file action' })).toBeNull()
    act(() => {
      controller.state.set({})
      controller.host.set({ name: 'server', available: false, fileManager: null })
    })
    expect(view.queryByRole('button', { name: 'Native file action' })).toBeNull()
    expect(view.getByText(en['changes.oversized'])).toBeTruthy()
  })

  it('states the summary and comparison that stand in for hunks, and retries a failed read', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: 'missing' })
    const missing = mount({ summaries, locale: zh })
    expect(missing.view.getByText(zh['diff.missing'])).toBeTruthy()
    expect(missing.view.getByText('第 2 轮改动')).toBeTruthy()
    missing.view.unmount()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    const { view, injected } = mount({ summaries, diffs, locale: zh })
    const url = changesDiffUrl(SESSION, 5, 0)
    expect(view.getByRole('status').textContent).toBe(zh['diff.loading'])
    act(() => { diffs.state.set({ [url]: 'error' }) })
    fireEvent.click(view.getByRole('button', { name: zh['presented.retry'] }))
    expect(injected.loadChangesDiff).toHaveBeenCalledTimes(2)
    act(() => { diffs.state.set({ [url]: 'missing' }) })
    expect(view.getByText(zh['diff.missing'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { kind: 'binary', path: 'p', display: 'p' } }) })
    expect(view.getByText(zh['diff.binary'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { kind: 'oversized', path: 'p', display: 'p' } }) })
    expect(view.getByText(zh['diff.oversized'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { ...text, before: false, coarse: true } }) })
    expect(view.getByText(zh['diff.created'])).toBeTruthy()
    expect(view.container.querySelector('[data-diff-coarse]')?.textContent).toBe(zh['diff.coarse'])
    act(() => { diffs.state.set({ [url]: { ...text, after: false } }) })
    expect(view.getByText(zh['diff.deleted'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { ...text, hunks: [] } }) })
    expect(view.getByText(zh['diff.unchanged'])).toBeTruthy()
    const long = Array.from({ length: MAX_RENDERED_LINES + 1 }, (_, at) => `+line ${at}`)
    act(() => {
      diffs.state.set({ [url]: { ...text, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: long.length, lines: long }] } })
    })
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
    expect(view.container.querySelectorAll('[data-diff-line]')).toHaveLength(MAX_RENDERED_LINES)
    expect(view.container.querySelector('[data-diff-truncated]')?.textContent).toBe(`只显示前 ${MAX_RENDERED_LINES} 行`)
  })

  it('falls back to the first file for an index the summary does not list, and forgets its state with the tab', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const { view, store, aborter, injected } = mount({ summaries, params: { index: 9 } })
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('data-review-file')).toBe('src/app/main.ts')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 0)
    expect(store.getSnapshot().byTab[TAB]).toBeDefined()
    aborter.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  describe('explanation', () => {
    const EXPLAIN_URL = changesExplainUrl(SESSION, 5, 0)
    const explanation: ChangesExplanation = {
      purpose: 'Entry point that wires the `App` together.',
      changes: ['Renames `start` to `boot`.', 'Drops the unused import.'],
    }
    const withSummary = (explanations = new ChangesExplainStore(), params?: unknown) => {
      const summaries = new ChangesSummaryStore()
      summaries.state.set({ [SUMMARY_URL]: summary })
      return mount({ summaries, explanations, params })
    }
    const panelOf = (view: ReturnType<typeof mount>['view']) => view.queryByRole('complementary', { name: en['review.explainAria'] })

    it('asks for the shown file\'s explanation and draws it beside the comparison as plain text with code spans', () => {
      const { view, injected, explanations } = withSummary()
      expect(injected.loadChangesExplain).toHaveBeenCalledTimes(1)
      expect(injected.loadChangesExplain).toHaveBeenLastCalledWith('viewed', 5, 0)
      expect(panelOf(view)?.getAttribute('aria-busy')).toBe('true')
      expect(view.getByText(en['explain.loading'])).toBeTruthy()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: explanation }) })
      const panel = panelOf(view)!
      expect(panel.hasAttribute('aria-busy')).toBe(false)
      expect(view.getByText(en['explain.title'])).toBeTruthy()
      expect(view.getByText(en['explain.purpose'])).toBeTruthy()
      expect(view.getByText(en['explain.changes'])).toBeTruthy()
      expect([...panel.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Renames start to boot.', 'Drops the unused import.'])
      expect([...panel.querySelectorAll('code')].map(code => code.textContent)).toEqual(['App', 'start', 'boot'])
      // The panel shares the content row with the comparison.
      expect(panel.parentElement?.parentElement?.querySelector('[data-review-view], [role="status"]')).toBeTruthy()
      expect(injected.loadChangesExplain).toHaveBeenCalledTimes(1)
    })

    it('omits the section a model left empty, and never reads the text as markup', () => {
      const { view, explanations } = withSummary()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: { purpose: '', changes: ['<img src=x onerror=alert(1)> done'] } }) })
      expect(view.queryByText(en['explain.purpose'])).toBeNull()
      expect(view.getByText('<img src=x onerror=alert(1)> done')).toBeTruthy()
      expect(panelOf(view)?.querySelector('img')).toBeNull()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: { purpose: 'Only a purpose.', changes: [] } }) })
      expect(view.getByText('Only a purpose.')).toBeTruthy()
      expect(view.queryByText(en['explain.changes'])).toBeNull()
    })

    it('keeps the comparison and offers a retry when the explanation cannot be written', () => {
      const { view, injected, explanations } = withSummary()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: 'error' }) })
      expect(view.getByText(en['explain.error'])).toBeTruthy()
      expect(view.container.querySelector('[data-changes-review]')?.getAttribute('data-review-state')).toBe('ready')
      fireEvent.click(view.getByRole('button', { name: en['presented.retry'] }))
      expect(injected.loadChangesExplain).toHaveBeenCalledTimes(2)
    })

    it('shows no panel and no toggle when the Host has no explanation to give', () => {
      const { view, explanations } = withSummary()
      expect(view.getByRole('button', { name: en['review.explainAria'] })).toBeTruthy()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: 'missing' }) })
      expect(panelOf(view)).toBeNull()
      expect(view.queryByRole('button', { name: en['review.explainAria'] })).toBeNull()
    })

    it('does not ask for the explanation of a binary or oversized file', () => {
      for (const params of [{ index: 1 }, { index: 3 }]) {
        const { view, injected } = withSummary(new ChangesExplainStore(), params)
        expect(injected.loadChangesExplain).not.toHaveBeenCalled()
        expect(panelOf(view)).toBeNull()
        expect(view.queryByRole('button', { name: en['review.explainAria'] })).toBeNull()
        view.unmount()
      }
    })

    it('hides and shows the panel from the header, and reads nothing while it is hidden', () => {
      const { view, injected, store, explanations } = withSummary()
      act(() => { explanations.state.set({ [EXPLAIN_URL]: explanation }) })
      const toggle = view.getByRole('button', { name: en['review.explainAria'] })
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      fireEvent.click(toggle)
      expect(store.getSnapshot().byTab[TAB]?.explain).toBe(false)
      expect(panelOf(view)).toBeNull()
      expect(view.getByRole('button', { name: en['review.explainAria'] }).getAttribute('aria-pressed')).toBe('false')
      act(() => { store.actions.selected(TAB, 2) })
      expect(injected.loadChangesExplain).toHaveBeenCalledTimes(1)
      fireEvent.click(view.getByRole('button', { name: en['review.explainAria'] }))
      expect(panelOf(view)).toBeTruthy()
      expect(injected.loadChangesExplain).toHaveBeenLastCalledWith('viewed', 5, 2)
    })

    it('reads the explanation under the reviewed Session when another Session\'s sidebar hosts the tab', () => {
      const summaries = new ChangesSummaryStore()
      summaries.state.set({ [SUMMARY_URL]: summary })
      const { injected } = mount({ summaries, hostSessionId: SessionId('host') })
      expect(injected.loadChangesExplain).toHaveBeenCalledWith('viewed', 5, 0)
    })
  })

  describe('judge', () => {
    const JUDGE_URL = changesJudgeUrl(SESSION, 5, 0)
    const judgment: ChangesJudgment = {
      verdict: 'concerns', confidence: 72, summary: 'Renames `start` but misses one caller.',
      issues: [
        { severity: 'high', title: 'Caller still uses `start`', detail: 'Update `main.ts` to call `boot`.', line: 12 },
        { severity: 'low', title: 'Stale comment', detail: '' },
      ],
      checks: [
        { aspect: 'request', status: 'pass', note: 'Does the rename.' },
        { aspect: 'docs', status: 'fail', note: 'The documented `start` entry point is gone.' },
        { aspect: 'tests', status: 'na', note: '' },
      ],
      suggestions: ['Keep `start` as a deprecated alias.'],
      basis: { docs: true, request: true },
    }
    const withSummary = (judgments = new ChangesJudgeStore(), params?: unknown) => {
      const summaries = new ChangesSummaryStore()
      summaries.state.set({ [SUMMARY_URL]: summary })
      return mount({ summaries, judgments, params })
    }
    const panelOf = (view: ReturnType<typeof mount>['view']) => view.queryByRole('complementary', { name: en['review.judgeAria'] })

    it('asks for the shown file\'s judgment and draws its verdict, confidence, issues, checks, and suggestions', () => {
      const { view, injected, judgments } = withSummary()
      expect(injected.loadChangesJudge).toHaveBeenCalledTimes(1)
      expect(injected.loadChangesJudge).toHaveBeenLastCalledWith('viewed', 5, 0)
      expect(panelOf(view)?.getAttribute('aria-busy')).toBe('true')
      expect(view.getByText(en['judge.loading'])).toBeTruthy()
      act(() => { judgments.state.set({ [JUDGE_URL]: judgment }) })
      const panel = panelOf(view)!
      expect(panel.hasAttribute('aria-busy')).toBe(false)
      expect(view.getByText(en['judge.verdict.concerns'])).toBeTruthy()
      expect(view.getByText('Confidence 72%')).toBeTruthy()
      expect(view.getByRole('meter', { name: en['judge.confidenceAria'] }).getAttribute('aria-valuenow')).toBe('72')
      expect(view.getByText(en['judge.aspect.docs'])).toBeTruthy()
      expect(view.getByRole('img', { name: en['judge.status.fail'] })).toBeTruthy()
      expect(view.getByText('Line 12')).toBeTruthy()
      expect(view.getByText(en['judge.suggestions'])).toBeTruthy()
      expect([...panel.querySelectorAll('[data-severity]')].map(item => item.getAttribute('data-severity'))).toEqual(['high', 'low'])
      expect(view.queryByText(en['judge.noDocs'])).toBeNull()
      // The judgment sits before the explanation, beside the comparison.
      const explain = view.getByRole('complementary', { name: en['review.explainAria'] })
      expect(panel.compareDocumentPosition(explain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('states the evidence the judge lacked and that it found no issues', () => {
      const { view, judgments } = withSummary()
      act(() => { judgments.state.set({ [JUDGE_URL]: { ...judgment, verdict: 'pass', issues: [], checks: [], suggestions: [], summary: '', basis: { docs: false, request: false } } }) })
      expect(view.getByText(en['judge.verdict.pass'])).toBeTruthy()
      expect(view.getByText(en['judge.noIssues'])).toBeTruthy()
      expect(view.getByText(en['judge.noDocs'])).toBeTruthy()
      expect(view.getByText(en['judge.noRequest'])).toBeTruthy()
      expect(view.queryByText(en['judge.checks'])).toBeNull()
      act(() => { judgments.state.set({ [JUDGE_URL]: { ...judgment, verdict: 'fail', checks: [{ aspect: 'security', status: 'warn', note: '' }] } }) })
      expect(view.getByText(en['judge.verdict.fail'])).toBeTruthy()
      expect(view.getByRole('img', { name: en['judge.status.warn'] })).toBeTruthy()
    })

    it('offers a retry when the judgment cannot be written, and shows nothing when the Host has none', () => {
      const { view, injected, judgments } = withSummary()
      act(() => { judgments.state.set({ [JUDGE_URL]: 'error' }) })
      expect(view.getByText(en['judge.error'])).toBeTruthy()
      fireEvent.click(view.getByRole('button', { name: en['presented.retry'] }))
      expect(injected.loadChangesJudge).toHaveBeenCalledTimes(2)
      act(() => { judgments.state.set({ [JUDGE_URL]: 'missing' }) })
      expect(panelOf(view)).toBeNull()
      expect(view.queryByRole('button', { name: en['review.judgeAria'] })).toBeNull()
    })

    it('hides and shows the panel from the header, and reads nothing while it is hidden', () => {
      const { view, injected, store, judgments } = withSummary()
      act(() => { judgments.state.set({ [JUDGE_URL]: judgment }) })
      const toggle = view.getByRole('button', { name: en['review.judgeAria'] })
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      fireEvent.click(toggle)
      expect(store.getSnapshot().byTab[TAB]?.judge).toBe(false)
      expect(panelOf(view)).toBeNull()
      act(() => { store.actions.selected(TAB, 2) })
      expect(injected.loadChangesJudge).toHaveBeenCalledTimes(1)
      fireEvent.click(view.getByRole('button', { name: en['review.judgeAria'] }))
      expect(panelOf(view)).toBeTruthy()
      expect(injected.loadChangesJudge).toHaveBeenLastCalledWith('viewed', 5, 2)
    })

    it('does not ask for the judgment of a binary or oversized file', () => {
      for (const params of [{ index: 1 }, { index: 3 }]) {
        const { view, injected } = withSummary(new ChangesJudgeStore(), params)
        expect(injected.loadChangesJudge).not.toHaveBeenCalled()
        expect(panelOf(view)).toBeNull()
        view.unmount()
      }
    })
  })

  it('refuses an address it did not mint', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => mount({ address: 'dsh-resource://file/session/viewed/a.ts' })).toThrow('not a review address')
    error.mockRestore()
  })
})
