/**
 * Root-scoped main occupant. The first pane is the selected Session's Conversation;
 * up to two more panes show other Sessions beside it. Panes are added from the picker
 * button or by dropping a sidebar Session row onto the panel.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCloseOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import { MAX_VISIBLE_PANES } from '../split-panes.ts'
import type { SplitPaneSnapshot } from '../split-panes.ts'
import css from './ConversationPanel.module.css'

/** Extra-pane state and commands injected by the Conversation plugin. */
export interface ConversationPanelInjected {
  readonly hooks: { readonly panes: HostObservable<readonly SplitPaneSnapshot[]> }
  readonly addPane: (sessionId: SessionId) => void
  readonly removePane: (sessionId: SessionId) => void
  readonly mountPane: (reference: SessionReference) => () => void
}

/** Full props of the main-panel occupant. */
export type ConversationPanelProps =
  & PropsRuntime<'main'>
  & PropsRenderSlots<'main.conversation'>
  & PropsLocale<'conversation'>
  & InjectFace<ConversationPanelInjected>

/** Most recent Sessions offered by the picker. */
const PICKER_LIMIT = 15

function PaneBody({ pane, SessionProvider, renderSlot, mountPane, removePane, closeLabel }:
  Pick<ConversationPanelProps, 'SessionProvider' | 'renderSlot' | 'mountPane' | 'removePane'>
  & { readonly pane: SplitPaneSnapshot; readonly closeLabel: string }) {
  useLayoutEffect(() => mountPane(pane.reference), [mountPane, pane.reference])
  return (
    <div className={css.pane} data-split-pane={pane.sessionId}>
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
  renderSlot, SessionProvider, usePanes, useSessions, addPane, removePane, mountPane, t,
}: ConversationPanelProps) {
  const panes = usePanes(value => value)
  const byId = useSessions(state => state.byId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const full = panes.length >= MAX_VISIBLE_PANES - 1

  const choices = useMemo(() => {
    const shown = new Set(panes.map(pane => pane.sessionId))
    return Object.values(byId)
      .filter(row => !row.blank && row.origin === undefined && !shown.has(row.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PICKER_LIMIT)
  }, [byId, panes])

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
    return row !== undefined && !row.blank ? id : undefined
  }
  // dragover repeats while a drag hovers; silence for a moment (cancelled drag, drop elsewhere) clears the hint.
  const dropTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(dropTimer.current) }, [])
  const acceptsDrag = (event: DragEvent): boolean => !full && event.dataTransfer.types.includes('text/plain')

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-pane-count={panes.length + 1}
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
        addPane(id)
      }}
    >
      <div className={css.pane}>{renderSlot('main.conversation', {})}</div>
      {panes.map(pane => (
        <PaneBody
          key={pane.sessionId}
          pane={pane}
          SessionProvider={SessionProvider}
          renderSlot={renderSlot}
          mountPane={mountPane}
          removePane={removePane}
          closeLabel={t('split.close')}
        />
      ))}
      {!full && (
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
              {choices.length === 0
                ? <div className={css.pickerEmpty}>{t('split.empty')}</div>
                : choices.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className={css.pickerItem}
                    onClick={() => { addPane(row.id); setPickerOpen(false) }}
                  >
                    {row.displayTitle}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {dropping && <div className={css.dropHint}>{t('split.drop')}</div>}
    </div>
  )
}
