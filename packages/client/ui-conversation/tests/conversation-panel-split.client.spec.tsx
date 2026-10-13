// @vitest-environment jsdom
/** Split-pane Conversation panel: add picker, sidebar-row drop, close, and the pane limit. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConversationPanel } from '../src/client/skeleton/ConversationPanel.tsx'
import type { ConversationPanelProps } from '../src/client/skeleton/ConversationPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Rows = Record<string, { id: string; displayTitle: string; blank: boolean; origin?: 'subagent'; updatedAt: number }>

const ROWS: Rows = {
  s1: { id: 's1', displayTitle: 'Alpha', blank: false, updatedAt: 1 },
  s2: { id: 's2', displayTitle: 'Beta', blank: false, updatedAt: 3 },
  s3: { id: 's3', displayTitle: 'Gamma', blank: false, updatedAt: 2 },
  s4: { id: 's4', displayTitle: 'Blank', blank: true, updatedAt: 9 },
  s5: { id: 's5', displayTitle: 'Child', blank: false, origin: 'subagent', updatedAt: 8 },
}

const addLabel = zh['split.add']
const closeLabel = zh['split.close']

function setup(paneIds: readonly string[] = [], rows: Rows = ROWS) {
  const panes = paneIds.map((id) => {
    const reference = {} as SessionReference
    return { sessionId: id as SessionId, reference }
  })
  const addPane = vi.fn()
  const removePane = vi.fn()
  const mountPane = vi.fn(() => vi.fn())
  const SessionProvider: ConversationPanelProps['SessionProvider'] = ({ children }): ReactNode => children
  const renderSlot = ((key: string) => <div data-slot={key} />) as ConversationPanelProps['renderSlot']
  const usePanes = ((select: (value: typeof panes) => unknown) => select(panes)) as ConversationPanelProps['usePanes']
  const useSessions = ((select: (value: { byId: Rows }) => unknown) => select({ byId: rows })) as ConversationPanelProps['useSessions']
  const t = makeTranslate(zh, commonZh) as ConversationPanelProps['t']
  const ui = render(
    <ConversationPanel
      {...{ renderSlot, SessionProvider, usePanes, useSessions, addPane, removePane, mountPane, t } as ConversationPanelProps}
    />,
  )
  return { ui, addPane, removePane, mountPane, root: ui.container.firstElementChild as HTMLElement }
}

const drag = (id: string, types: string[] = ['text/plain']) => ({
  dataTransfer: { types, getData: () => id, dropEffect: '' },
})

describe('ConversationPanel split panes', () => {
  it('renders the main Conversation alone with an add button', () => {
    const { ui, root } = setup()
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(1)
    expect(root.dataset.paneCount).toBe('1')
    expect(screen.getByLabelText(addLabel)).toBeTruthy()
  })

  it('renders one Conversation per extra pane and mounts each reference', () => {
    const { ui, mountPane, root } = setup(['s2', 's3'])
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(3)
    expect(root.dataset.paneCount).toBe('3')
    expect(mountPane).toHaveBeenCalledTimes(2)
  })

  it('hides the add button once every pane is open', () => {
    setup(['s2', 's3'])
    expect(screen.queryByLabelText(addLabel)).toBeNull()
  })

  it('closes a pane from its close button', () => {
    const { removePane } = setup(['s2', 's3'])
    fireEvent.click(screen.getAllByLabelText(closeLabel)[1]!)
    expect(removePane).toHaveBeenCalledWith('s3')
  })

  it('lists recent open Sessions, newest first, without blanks, children, or open panes', () => {
    setup(['s3'])
    fireEvent.click(screen.getByLabelText(addLabel))
    expect(screen.getAllByRole('button').filter(b => b.textContent !== '' && !b.getAttribute('aria-label'))
      .map(b => b.textContent)).toEqual(['Beta', 'Alpha'])
  })

  it('adds the picked Session and closes the picker', () => {
    const { addPane } = setup()
    fireEvent.click(screen.getByLabelText(addLabel))
    fireEvent.click(screen.getByText('Gamma'))
    expect(addPane).toHaveBeenCalledWith('s3')
    expect(screen.queryByText(zh['split.hint'])).toBeNull()
  })

  it('says so when there is nothing left to add', () => {
    setup([], { s4: ROWS.s4! })
    fireEvent.click(screen.getByLabelText(addLabel))
    expect(screen.getByText(zh['split.empty'])).toBeTruthy()
  })

  it('closes the picker on an outside pointer press but not an inside one', () => {
    setup()
    fireEvent.click(screen.getByLabelText(addLabel))
    fireEvent.pointerDown(screen.getByText(zh['split.hint']))
    expect(screen.queryByText(zh['split.hint'])).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText(zh['split.hint'])).toBeNull()
  })

  it('toggles the picker from the add button', () => {
    setup()
    const button = screen.getByLabelText(addLabel)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the drop hint while a Session row is dragged over, then clears it', () => {
    vi.useFakeTimers()
    const { root } = setup()
    fireEvent.dragOver(root, drag('s2'))
    expect(screen.getByText(zh['split.drop'])).toBeTruthy()
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByText(zh['split.drop'])).toBeNull()
  })

  it('keeps the drop hint while dragover keeps firing', () => {
    vi.useFakeTimers()
    const { root } = setup()
    fireEvent.dragOver(root, drag('s2'))
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent.dragOver(root, drag('s2'))
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.getByText(zh['split.drop'])).toBeTruthy()
  })

  it('adds a dropped Session', () => {
    const { root, addPane } = setup()
    fireEvent.dragOver(root, drag('s2'))
    fireEvent.drop(root, drag('s2'))
    expect(addPane).toHaveBeenCalledWith('s2')
    expect(screen.queryByText(zh['split.drop'])).toBeNull()
  })

  it.each([
    ['a blank Session', 's4'],
    ['an unknown id', 'nope'],
  ])('ignores a drop of %s', (_label, id) => {
    const { root, addPane } = setup()
    fireEvent.drop(root, drag(id))
    expect(addPane).not.toHaveBeenCalled()
  })

  it('ignores drags that are not text, and any drag when every pane is open', () => {
    const open = setup(['s2', 's3'])
    fireEvent.dragOver(open.root, drag('s1'))
    fireEvent.drop(open.root, drag('s1'))
    expect(open.addPane).not.toHaveBeenCalled()
    expect(screen.queryByText(zh['split.drop'])).toBeNull()
    cleanup()
    const files = setup()
    fireEvent.dragOver(files.root, drag('s1', ['Files']))
    fireEvent.drop(files.root, drag('s1', ['Files']))
    expect(files.addPane).not.toHaveBeenCalled()
    expect(screen.queryByText(zh['split.drop'])).toBeNull()
  })
})
