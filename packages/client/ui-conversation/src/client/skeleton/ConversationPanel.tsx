/**
 * Root-scoped main occupant. Every open Session is a pane in one row: the Session the sidebar
 * selected is rendered by the `main.conversation` child, every other one through its own
 * `SessionProvider`. Panes stay open until closed. With a split view (two or more panes), selecting a
 * Session that is not open appends it on the right; selecting an open one keeps the row as it is. A single
 * pane is simply replaced by the new selection. Either way the row scrolls to the
 * selected pane and the pane glows in its identity color. Every pane is a third of the panel
 * wide (at least 320px) and the row scrolls sideways past three. Panes are also added from the
 * picker button or by dropping a sidebar Session row onto the panel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { IconCloseOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { SplitPaneSnapshot, SplitPanesState } from '../split-panes.ts'
import { sessionColorProperty } from '../session-colors.ts'
import css from './ConversationPanel.module.css'

/** Extra-pane state and commands injected by the Conversation plugin. */
export interface ConversationPanelInjected {
  readonly hooks: { readonly panes: HostObservable<SplitPanesState> }
  /** Follow the sidebar selection: it joins the open Sessions when it is new. */
  readonly syncPanes: (selected: SessionId | undefined) => void
  /** Select a Session in the sidebar sense, making it the one the main pane renders. */
  readonly selectSession: (sessionId: SessionId) => void
  readonly addPane: (sessionId: SessionId) => void
  /** Create a blank Session in a Workspace and open it in a new pane; rejects when creation fails. */
  readonly createPane: (workspaceId: WorkspaceId) => Promise<SessionId>
  readonly removePane: (sessionId: SessionId) => void
  readonly mountPane: (reference: SessionReference) => () => void
}

/** Full props of the main-panel occupant. */
export type ConversationPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderSlots<'main.conversation'>
  & PropsLocale<'conversation'>
  & InjectFace<ConversationPanelInjected>

/** How long a pane glows after the user navigates to it. */
const FLASH_MS = 1800

/** Glow around a pane in its Session's identity color; remounting it (new key) replays the animation. */
function PaneFlash({ sessionId }: { readonly sessionId: string }) {
  return (
    <div
      className={css.flash}
      style={{ '--dsh-flash-color': `var(${sessionColorProperty(sessionId)}, currentColor)` } as CSSProperties}
      data-pane-flash=""
      aria-hidden
    />
  )
}

function PaneBody({ pane, SessionProvider, renderSlot, mountPane, removePane, closeLabel, flashKey }:
  Pick<ConversationPanelProps, 'SessionProvider' | 'renderSlot' | 'mountPane' | 'removePane'>
  & { readonly pane: SplitPaneSnapshot; readonly closeLabel: string; readonly flashKey: number | undefined }) {
  useLayoutEffect(() => mountPane(pane.reference), [mountPane, pane.reference])
  return (
    <div className={css.pane} data-split-pane={pane.sessionId} data-pane-session={pane.sessionId}>
      {flashKey !== undefined && <PaneFlash key={flashKey} sessionId={pane.sessionId} />}
      <button
        type="button"
        className={css.closePane}
        aria-label={closeLabel}
        title={closeLabel}
        onClick={() => { removePane(pane.sessionId) }}
      >
        <IconCloseOutlineRegular size={14} />
      </button>
      <SessionProvider session={pane.reference}>
        {renderSlot('main.conversation', {})}
      </SessionProvider>
    </div>
  )
}

/**
 * Render the Conversation panes and their add controls.
 * @param props - main-slot inputs, the Conversation renderer, and the injected pane commands.
 * @returns the pane row.
 */
export function ConversationPanel({
  renderSlot, SessionProvider, usePanes, useSessions, useWorkspaces,
  addPane, createPane, removePane, syncPanes, selectSession, mountPane, t,
}: ConversationPanelProps) {
  const { order, panes } = usePanes(value => value)
  const byId = useSessions(state => state.byId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [creation, setCreation] = useState<'idle' | 'creating' | 'failed'>('idle')
  const [flash, setFlash] = useState<{ readonly id: string; readonly key: number } | undefined>()
  const [closing, setClosing] = useState<SessionId | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  // The Session the sidebar selected. One Session owns one editor, so it is shown in exactly one pane.
  const mainId = useMemo(
    () => Object.values(byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id,
    [byId],
  )
  // New panes open in the selected Session's Workspace, else the first one.
  const newSessionWorkspace = useWorkspaces(state =>
    state.items.find(item => mainId !== undefined && item.sessionIds.includes(mainId))?.workspaceId
      ?? state.items.at(0)?.workspaceId)

  // The row's panes in order. A selection the list has not caught up with yet is shown at the end
  // already, so the first render after a click is the final arrangement.
  const rendered = useMemo(() => {
    const open = mainId === undefined || order.includes(mainId)
      ? order
      : order.length <= 1 ? [mainId] : [...order, mainId]
    return open.filter(id => id !== closing)
  }, [order, mainId, closing])
  const paneOf = (id: SessionId): SplitPaneSnapshot | undefined => panes.find(pane => pane.sessionId === id)

  // Bring a pane into view and make it glow; the same pane glowing again within half a second is not restarted.
  const lastFlash = useRef({ id: '', at: 0 })
  const reveal = useCallback((id: string): boolean => {
    const scroller = scrollerRef.current
    const pane = scroller === null
      ? undefined
      : [...scroller.children].find((child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.paneSession === id)
    // A single pane has nowhere to scroll to and nothing to tell apart, so it neither scrolls nor glows.
    if (scroller === null || pane === undefined || scroller.children.length < 2) return false
    scroller.scrollTo({
      left: pane.offsetLeft - (scroller.clientWidth - pane.offsetWidth) / 2,
      behavior: 'smooth',
    })
    const now = Date.now()
    if (lastFlash.current.id !== id || now - lastFlash.current.at > 500) {
      lastFlash.current = { id, at: now }
      setFlash({ id, key: now })
    }
    return true
  }, [])
  useEffect(() => {
    if (flash === undefined) return
    const fade = setTimeout(() => { setFlash(undefined) }, FLASH_MS)
    return () => { clearTimeout(fade) }
  }, [flash])

  // A pane the user just added is revealed as soon as it is on screen.
  const pendingReveal = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (pendingReveal.current !== undefined && reveal(pendingReveal.current)) pendingReveal.current = undefined
  })

  // The selection joins the open Sessions, and moving it to another Session reveals that Session.
  // Layout effect, so the arrangement is never painted half-updated.
  const previousMain = useRef<SessionId | undefined>(undefined)
  useLayoutEffect(() => {
    const former = previousMain.current
    previousMain.current = mainId
    syncPanes(mainId)
    if (closing !== undefined && mainId !== closing) setClosing(undefined)
    if (former !== undefined && mainId !== undefined && former !== mainId) reveal(mainId)
  }, [mainId, closing, syncPanes, reveal])

  // Clicking a Session row in the sidebar brings that Session's pane into view and makes it glow, also
  // when it is already the selected one. The row marker `data-row-key="session:<id>"` is ui-workspace's DOM contract.
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined
    const onClick = (event: MouseEvent): void => {
      const row = event.target instanceof Element ? event.target.closest('[data-row-key^="session:"]') : null
      if (row === null) return
      const id = (row.getAttribute('data-row-key') ?? '').slice('session:'.length)
      clearTimeout(settle)
      settle = setTimeout(() => { reveal(id) }, 60)
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      clearTimeout(settle)
    }
  }, [reveal])

  const closeMain = (selected: SessionId): void => {
    const index = rendered.indexOf(selected)
    const next = rendered[index + 1] ?? rendered[index - 1]
    if (next === undefined) return
    setClosing(selected)
    selectSession(next)
    removePane(selected)
  }

  const open = (id: SessionId): void => {
    pendingReveal.current = id
    addPane(id)
  }

  const createSession = (workspaceId: WorkspaceId): void => {
    setCreation('creating')
    createPane(workspaceId).then(
      (id) => { pendingReveal.current = id; setCreation('idle'); setPickerOpen(false) },
      () => { setCreation('failed') },
    )
  }

  const choices = useMemo(() => {
    const shown = new Set<string>(rendered)
    return Object.values(byId)
      .filter(row => !row.blank && row.origin === undefined && !shown.has(row.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [byId, rendered])

  useEffect(() => {
    if (!pickerOpen) return
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || event.target.closest('[data-split-picker]') === null) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [pickerOpen])

  const droppedId = (event: DragEvent): SessionId | undefined => {
    const id = event.dataTransfer.getData('text/plain') as SessionId
    const row: (typeof byId)[SessionId] | undefined = byId[id]
    return row !== undefined && !row.blank && !rendered.includes(id) ? id : undefined
  }
  // dragover repeats while a drag hovers; silence for a moment (cancelled drag, drop elsewhere) clears the hint.
  const dropTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(dropTimer.current) }, [])
  const acceptsDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes('text/plain')

  const mainPane = (selected: SessionId | undefined): ReactNode => (
    <div key="main" className={css.pane} data-pane-session={selected}>
      {selected !== undefined && flash?.id === selected && <PaneFlash key={flash.key} sessionId={selected} />}
      {selected !== undefined && rendered.length > 1 && (
        <button
          type="button"
          className={css.closePane}
          aria-label={t('split.close')}
          title={t('split.close')}
          onClick={() => { closeMain(selected) }}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      )}
      {renderSlot('main.conversation', {})}
    </div>
  )
  const paneItems: ReactNode[] = rendered.flatMap((id): ReactNode[] => {
    if (id === mainId) return [mainPane(id)]
    const pane = paneOf(id)
    if (pane === undefined) return []
    return [(
      <PaneBody
        key={id}
        pane={pane}
        SessionProvider={SessionProvider}
        renderSlot={renderSlot}
        mountPane={mountPane}
        removePane={removePane}
        closeLabel={t('split.close')}
        flashKey={flash?.id === id ? flash.key : undefined}
      />
    )]
  })
  // With no Session selected the main child still renders, for the empty state.
  if (mainId === undefined) paneItems.unshift(mainPane(undefined))

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-pane-count={paneItems.length}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
        clearTimeout(dropTimer.current)
        dropTimer.current = setTimeout(() => { setDropping(false) }, 200)
      }}
      onDrop={(event) => {
        clearTimeout(dropTimer.current)
        setDropping(false)
        if (!acceptsDrag(event)) return
        const id = droppedId(event)
        if (id === undefined) return
        event.preventDefault()
        open(id)
      }}
    >
      <div ref={scrollerRef} className={css.scroller}>
        {paneItems}
      </div>
      <div className={css.add} data-split-picker="">
        <button
          type="button"
          className={css.addButton}
          aria-label={t('split.add')}
          aria-expanded={pickerOpen}
          title={t('split.add')}
          onClick={() => { setPickerOpen(open => !open) }}
        >
          <IconPlusOutlineRegular size={16} />
        </button>
        {pickerOpen && (
          <div className={css.picker}>
            <div className={css.pickerHint}>{t('split.hint')}</div>
            {newSessionWorkspace !== undefined && (
              <button
                type="button"
                className={clsx(css.pickerItem, css.pickerNew)}
                disabled={creation === 'creating'}
                data-split-new=""
                onClick={() => { createSession(newSessionWorkspace) }}
              >
                <IconPlusOutlineRegular size={14} />
                <span>{t('split.new')}</span>
              </button>
            )}
            {creation === 'failed' && <div className={css.pickerError} role="alert">{t('split.createFailed')}</div>}
            {choices.length === 0
              ? <div className={css.pickerEmpty}>{t('split.empty')}</div>
              : choices.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={css.pickerItem}
                  onClick={() => { open(row.id); setPickerOpen(false) }}
                >
                  {row.displayTitle}
                </button>
              ))}
          </div>
        )}
      </div>
      {dropping && <div className={css.dropHint}>{t('split.drop')}</div>}
    </div>
  )
}
