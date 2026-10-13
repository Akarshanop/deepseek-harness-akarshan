// @vitest-environment jsdom
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SideQuestionId, SideQuestionRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSideQaSource, type SideQaRemote } from '../src/client/side-qa/side-qa-source.ts'
import { readChatSelection, SideQaSelection } from '../src/client/side-qa/SideQaSelection.tsx'

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges() })

const sessionId = 's1' as SessionId
const record = (id: string, extra: Partial<SideQuestionRecord> = {}): SideQuestionRecord => ({
  id: id as SideQuestionId, sessionId, askedAt: '2026-01-01T00:00:00.000Z', selection: 'sel', question: 'q',
  system: 'sys', prompt: 'p', contextMessageCount: 2, provider: 'p', model: 'm', answer: 'a', ...extra,
})
const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
const fail = (message: string) => Promise.resolve({ ok: false as const, error: { message } })

function remote(overrides: Partial<SideQaRemote> = {}): SideQaRemote {
  return {
    askSideQuestion: () => ok(record('new')),
    listSideQuestions: () => ok({ questions: [record('a')] }),
    deleteSideQuestion: () => ok({ deleted: true }),
    ...overrides,
  }
}

describe('side-qa source', () => {
  it('loads, asks, and deletes', async () => {
    const source = createSideQaSource(remote(), sessionId)
    await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ loaded: true, records: [{ id: 'a' }] })
    const asking = source.ask('sel', 'q')
    expect(source.getSnapshot().pending).toHaveLength(1)
    await asking
    expect(source.getSnapshot().pending).toEqual([])
    expect(source.getSnapshot().records.map(item => item.id)).toEqual(['a', 'new'])
    await source.remove('a' as SideQuestionId)
    expect(source.getSnapshot().records.map(item => item.id)).toEqual(['new'])
  })

  it('keeps failures visible until dismissed', async () => {
    const source = createSideQaSource(remote({
      askSideQuestion: () => fail('no model'),
      listSideQuestions: () => fail('offline'),
      deleteSideQuestion: () => fail('busy'),
    }), sessionId)
    await source.refresh()
    expect(source.getSnapshot().loadFailure).toBe('offline')
    await source.ask('sel', 'q')
    const [pending] = source.getSnapshot().pending
    expect(pending?.failure).toBe('no model')
    await source.remove('x' as SideQuestionId)
    expect(source.getSnapshot().loadFailure).toBe('busy')
    source.dismiss(pending?.key ?? -1)
    expect(source.getSnapshot().pending).toEqual([])
  })
})

function selectIn(root: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.getClientRects = () => ({ length: 1, item: () => ({ bottom: 40, right: 100 }) }) as unknown as DOMRectList
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  vi.spyOn(selection as Selection, 'getRangeAt').mockReturnValue(range)
}

const t = ((key: string) => key) as never

const scopeOf = (element: HTMLElement) => ({ current: element })

/** A chat view whose own control is mounted beside it. */
function Pane({ id, ask }: { id: string; ask: (selection: string, question: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} data-testid={`pane-${id}`}>
      <div data-chat-flow=""><p data-testid={`in-${id}`}>text {id}</p></div>
      <SideQaSelection scope={ref} ask={ask} t={t} />
    </div>
  )
}

describe('side-qa selection', () => {
  it('ignores selections outside the view and reads those inside it', () => {
    render(<><p data-testid="out">outside</p><div data-testid="view"><div data-chat-flow=""><p data-testid="in">inside text</p></div></div></>)
    const scope = screen.getByTestId('view')
    selectIn(screen.getByTestId('out'))
    expect(readChatSelection(scope)).toBeNull()
    selectIn(screen.getByTestId('in'))
    expect(readChatSelection(scope)).toEqual({ text: 'inside text', top: 40, left: 100 })
    expect(readChatSelection(null)).toBeNull()
  })

  it('reads a selection only in the view that owns it when several chats are mounted', () => {
    render(<><Pane id="a" ask={vi.fn()} /><Pane id="b" ask={vi.fn()} /></>)
    selectIn(screen.getByTestId('in-b'))
    expect(readChatSelection(scopeOf(screen.getByTestId('pane-a')).current)).toBeNull()
    expect(readChatSelection(scopeOf(screen.getByTestId('pane-b')).current)?.text).toBe('text b')
    fireEvent(document, new Event('selectionchange'))
    expect(screen.getAllByText('sideQa.ask')).toHaveLength(1)
  })

  it('reads nothing for an empty, whitespace-only or unmeasurable selection', () => {
    render(<div data-testid="view"><div data-chat-flow=""><p data-testid="in">inside text</p><p data-testid="blank">   </p></div></div>)
    const scope = screen.getByTestId('view')
    expect(readChatSelection(scope)).toBeNull()
    selectIn(screen.getByTestId('blank'))
    expect(readChatSelection(scope)).toBeNull()
    selectIn(screen.getByTestId('in'))
    vi.spyOn(window.getSelection() as Selection, 'getRangeAt').mockReturnValue(
      { getClientRects: () => ({ length: 0, item: () => null }) } as unknown as Range,
    )
    expect(readChatSelection(scope)).toBeNull()
  })

  it('keeps the composer open for a blank question and renders nothing without a selection', () => {
    const ask = vi.fn()
    render(<Pane id="a" ask={ask} />)
    fireEvent(document, new Event('selectionchange'))
    expect(screen.queryByText('sideQa.ask')).toBeNull()
    selectIn(screen.getByTestId('in-a'))
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(screen.getByText('sideQa.ask'))
    const input = screen.getByPlaceholderText('sideQa.placeholder')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(ask).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
  })

  it('offers the action for a chat selection and submits the question', () => {
    const ask = vi.fn()
    render(<Pane id="a" ask={ask} />)
    selectIn(screen.getByTestId('in-a'))
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(screen.getByText('sideQa.ask'))
    const input = screen.getByPlaceholderText('sideQa.placeholder')
    fireEvent.change(input, { target: { value: '  why?  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(ask).toHaveBeenCalledWith('text a', 'why?')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads a selection anchored in a text node and closes from the Cancel button', () => {
    const ask = vi.fn()
    render(<Pane id="a" ask={ask} />)
    selectIn(screen.getByTestId('in-a').firstChild as HTMLElement)
    fireEvent(document, new Event('selectionchange'))
    // The press must not move focus, or the browser would collapse the highlighted text before the click.
    expect(fireEvent.mouseDown(screen.getByText('sideQa.ask'))).toBe(false)
    fireEvent.click(screen.getByText('sideQa.ask'))
    fireEvent.click(screen.getByText('cancel'))
    expect(ask).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape without asking', () => {
    const ask = vi.fn()
    render(<Pane id="a" ask={ask} />)
    selectIn(screen.getByTestId('in-a'))
    fireEvent(document, new Event('selectionchange'))
    fireEvent.click(screen.getByText('sideQa.ask'))
    fireEvent.keyDown(screen.getByPlaceholderText('sideQa.placeholder'), { key: 'Escape' })
    expect(ask).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
