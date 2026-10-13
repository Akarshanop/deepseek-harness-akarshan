// Highlight-to-ask: a floating action over text selected inside the chat flow,
// and the small composer it opens. It only reads the DOM selection; sending and
// saving belong to the injected `ask`.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './SideQaSelection.module.css'

/** A selection inside the chat flow and where its last line ends on screen. */
interface ChatSelection {
  readonly text: string
  readonly top: number
  readonly left: number
}

const FLOW_SELECTOR = '[data-chat-flow]'

/** Widest control (the composer) plus the viewport margin it keeps. */
const CONTROL_ROOM = 396

/** Keep a control that starts at `left` inside the viewport. */
function placeLeft(left: number): number {
  return Math.max(8, Math.min(left, window.innerWidth - CONTROL_ROOM))
}

function insideFlow(node: Node | null, scope: Element | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest(FLOW_SELECTOR) != null && scope?.contains(element) === true
}

/**
 * Read the current selection, or null when it is empty or leaves this view's chat flow.
 * Several chat views can be mounted at once (split panes), and each reacts only to its own text.
 */
export function readChatSelection(scope: Element | null): ChatSelection | null {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  if (!insideFlow(selection.anchorNode, scope) || !insideFlow(selection.focusNode, scope)) return null
  const text = selection.toString().trim()
  if (text.length === 0) return null
  const rects = selection.getRangeAt(0).getClientRects()
  const last = rects.item(rects.length - 1)
  if (last === null) return null
  return { text, top: last.bottom, left: last.right }
}

export interface SideQaSelectionProps {
  /** The chat view that owns this control; selections outside it are ignored. */
  scope: RefObject<HTMLElement | null>
  /** Send one question; the owning view decides where the answer is shown. */
  ask: (selection: string, question: string) => void
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Floating "ask a side question" action and composer for selected chat text.
 * @param props - the ask callback and locale seat.
 * @returns the fixed-position controls, or null while nothing is selected.
 */
export function SideQaSelection({ scope, ask, t }: SideQaSelectionProps) {
  const [selection, setSelection] = useState<ChatSelection | null>(null)
  // Focusing the composer collapses the DOM selection, so the text asked about is frozen here.
  const [composing, setComposing] = useState<ChatSelection | null>(null)
  const [question, setQuestion] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (composing !== null) return undefined
    const update = (): void => { setSelection(readChatSelection(scope.current)) }
    document.addEventListener('selectionchange', update)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [composing, scope])

  useEffect(() => {
    if (composing !== null) input.current?.focus()
  }, [composing])

  const close = useCallback(() => {
    setComposing(null)
    setQuestion('')
    setSelection(null)
  }, [])

  const submit = useCallback(() => {
    const trimmed = question.trim()
    if (composing === null || trimmed.length === 0) return
    ask(composing.text, trimmed)
    close()
  }, [ask, close, composing, question])

  // Fixed controls render under <body>: a pane's own overflow or transform would otherwise clip them.
  const floating = (node: ReactNode) => createPortal(node, document.body)
  if (composing !== null) {
    return floating(
      <div className={css.composer} style={{ top: composing.top + 8, left: placeLeft(composing.left) }}
        role="dialog" aria-label={t('sideQa.ask')}>
        <blockquote className={css.quote}>{composing.text}</blockquote>
        <textarea
          ref={input}
          className={css.input}
          rows={2}
          value={question}
          placeholder={t('sideQa.placeholder')}
          onChange={(event) => { setQuestion(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close()
            else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className={css.actions}>
          <span className={css.hint}>{t('sideQa.notice')}</span>
          <Button size="sm" variant="outline" onClick={close}>{t('cancel')}</Button>
          <Button size="sm" variant="primary" disabled={question.trim().length === 0} onClick={submit}>
            {t('sideQa.send')}
          </Button>
        </div>
      </div>,
    )
  }
  if (selection === null) return null
  return floating(
    <button
      type="button"
      className={css.trigger}
      style={{ top: selection.top + 8, left: placeLeft(selection.left) }}
      // Keeps the text selected through the click.
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={() => { setComposing(selection) }}
    >
      {t('sideQa.ask')}
    </button>,
  )
}
