// @vitest-environment jsdom
/** Split-pane Conversation panel: open Sessions as tabs, the picker, drops, closing, and the navigation cue. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConversationPanel } from '../src/client/skeleton/ConversationPanel.tsx'
import type { ConversationPanelProps } from '../src/client/skeleton/ConversationPanel.tsx'
import { zh } from '../src/client/locales.ts'

// jsdom has no element scrolling; every test starts with a stub the panel's reveal can call.
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollTo', { value: vi.fn(), configurable: true })
})

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollTo')
  cleanup()
  vi.useRealTimers()
})

type Rows = Record<string, {
  id: string
  displayTitle: string
  blank: boolean
  origin?: 'subagent'
  updatedAt: number
  retainedBy: { mainView?: number }
}>

const ROWS: Rows = {
  s1: { id: 's1', displayTitle: 'Alpha', blank: false, updatedAt: 1, retainedBy: {} },
  s2: { id: 's2', displayTitle: 'Beta', blank: false, updatedAt: 3, retainedBy: {} },
  s3: { id: 's3', displayTitle: 'Gamma', blank: false, updatedAt: 2, retainedBy: {} },
  s4: { id: 's4', displayTitle: 'Blank', blank: true, updatedAt: 9, retainedBy: {} },
  s5: { id: 's5', displayTitle: 'Child', blank: false, origin: 'subagent', updatedAt: 8, retainedBy: {} },
}

type Workspaces = { items: { workspaceId: string; sessionIds: string[] }[] }
const WORKSPACES: Workspaces = { items: [
  { workspaceId: 'w1', sessionIds: ['s9'] },
  { workspaceId: 'w2', sessionIds: ['s1', 's2'] },
] }

const addLabel = zh['split.add']
const closeLabel = zh['split.close']

const withMain = (id: string | undefined, rows: Rows = ROWS): Rows =>
  Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, { ...row, retainedBy: key === id ? { mainView: 1 } : {} }]))

/**
 * Render the panel with `order` as the open Sessions and `main` as the sidebar selection.
 * Sessions in `order` other than `main` get a pane record, as the real owner provides.
 */
function setup(options: { order?: readonly string[]; main?: string; rows?: Rows; workspaces?: Workspaces } = {}) {
  const { workspaces = WORKSPACES } = options
  let main = options.main
  let order = options.order ?? (main === undefined ? [] : [main])
  let rows = options.rows ?? ROWS
  const records = new Map<string, SessionReference>()
  const recordOf = (id: string): SessionReference => {
    const existing = records.get(id)
    if (existing !== undefined) return existing
    const reference = {} as SessionReference
    records.set(id, reference)
    return reference
  }
  const state = () => ({
    order: order as readonly SessionId[],
    panes: order.filter(id => id !== main).map(id => ({ sessionId: id as SessionId, reference: recordOf(id) })),
  })
  const addPane = vi.fn()
  const removePane = vi.fn()
  const syncPanes = vi.fn()
  const selectSession = vi.fn()
  const createPane = vi.fn((): Promise<SessionId> => Promise.resolve('created' as SessionId))
  const mountPane = vi.fn(() => vi.fn())
  const SessionProvider: ConversationPanelProps['SessionProvider'] = ({ children }): ReactNode => children
  const renderSlot = ((key: string) => <div data-slot={key} />) as ConversationPanelProps['renderSlot']
  const usePanes = ((select: (value: ReturnType<typeof state>) => unknown) => select(state())) as ConversationPanelProps['usePanes']
  const useWorkspaces = ((select: (value: Workspaces) => unknown) => select(workspaces)) as ConversationPanelProps['useWorkspaces']
  const t = makeTranslate(zh, commonZh) as ConversationPanelProps['t']
  const element = () => {
    const current = withMain(main, rows)
    const useSessions = ((select: (value: { byId: Rows }) => unknown) => select({ byId: current })) as ConversationPanelProps['useSessions']
    return (
      <ConversationPanel
        {...{
          renderSlot, SessionProvider, usePanes, useSessions, useWorkspaces,
          addPane, removePane, syncPanes, selectSession, createPane, mountPane, t,
        } as ConversationPanelProps}
      />
    )
  }
  const ui = render(element())
  const rerender = (): void => { ui.rerender(element()) }
  return {
    ui, addPane, removePane, syncPanes, selectSession, createPane, mountPane,
    root: ui.container.firstElementChild as HTMLElement,
    selectMain: (id: string | undefined) => { main = id; rerender() },
    setOrder: (ids: readonly string[]) => { order = ids; rerender() },
    setRows: (next: Rows) => { rows = next; rerender() },
    /** Session ids in on-screen order. */
    shown: () => [...ui.container.querySelectorAll('[data-pane-session]')].map(node => node.getAttribute('data-pane-session')),
  }
}

const drag = (id: string, types: string[] = ['text/plain']) => ({
  dataTransfer: { types, getData: () => id, dropEffect: '' },
})
const pickerTitles = () => screen.getAllByRole('button')
  .filter(b => b.textContent !== '' && !b.getAttribute('aria-label') && !b.hasAttribute('data-split-new'))
  .map(b => b.textContent)

describe('ConversationPanel open Sessions', () => {
  it('renders the selected Session alone with an add button and no close button', () => {
    const { ui, root, syncPanes } = setup({ main: 's1' })
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(1)
    expect(root.dataset.paneCount).toBe('1')
    expect(screen.getByLabelText(addLabel)).toBeTruthy()
    expect(screen.queryByLabelText(closeLabel)).toBeNull()
    expect(syncPanes).toHaveBeenCalledWith('s1')
  })

  it('renders the empty state when nothing is selected, ahead of any open Session', () => {
    const { shown, ui } = setup({ order: ['s2'] })
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(2)
    expect(ui.container.querySelector('[data-slot="main.conversation"]')!.closest('[data-pane-session]')).toBeNull()
    expect(shown()).toEqual(['s2'])
  })

  it('renders one Conversation per open Session, in order, and mounts each pane reference', () => {
    const { ui, mountPane, shown, root } = setup({ order: ['s2', 's1', 's3'], main: 's1' })
    expect(shown()).toEqual(['s2', 's1', 's3'])
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(3)
    expect(root.dataset.paneCount).toBe('3')
    expect(mountPane).toHaveBeenCalledTimes(2)
  })

  it('keeps the add button however many Sessions are open', () => {
    const rows: Rows = {}
    for (let index = 0; index < 8; index++) {
      rows[`m${index}`] = { id: `m${index}`, displayTitle: `Many ${index}`, blank: false, updatedAt: index, retainedBy: {} }
    }
    const { ui, root } = setup({ order: Object.keys(rows), main: 'm0', rows })
    expect(ui.container.querySelectorAll('[data-slot="main.conversation"]')).toHaveLength(8)
    expect(root.dataset.paneCount).toBe('8')
    expect(screen.getByLabelText(addLabel)).toBeTruthy()
  })

  it('shows a selection the list has not caught up with at the end already', () => {
    const { shown, syncPanes } = setup({ order: ['s2', 's3'], main: 's1' })
    expect(shown()).toEqual(['s2', 's3', 's1'])
    expect(syncPanes).toHaveBeenCalledWith('s1')
  })

  it('replaces a lone Session with a new selection, without scrolling or glowing', () => {
    const { ui, selectMain, shown } = setup({ order: ['s1'], main: 's1' })
    selectMain('s2')
    expect(shown()).toEqual(['s2'])
    expect(ui.container.querySelector('[data-pane-flash]')).toBeNull()
    expect(screen.queryByLabelText(closeLabel)).toBeNull()
  })

  it('skips an open Session whose pane record does not exist yet', () => {
    const { shown } = setup({ order: ['s1', 's2'], main: 's1' })
    expect(shown()).toEqual(['s1', 's2'])
  })

  it('closes another pane from its close button', () => {
    const { removePane, selectSession } = setup({ order: ['s1', 's2', 's3'], main: 's1' })
    fireEvent.click(screen.getAllByLabelText(closeLabel)[2]!)
    expect(removePane).toHaveBeenCalledWith('s3')
    expect(selectSession).not.toHaveBeenCalled()
  })

  describe('closing the selected Session', () => {
    it('selects the neighbor to its right, closes it, and stops showing it', () => {
      const { removePane, selectSession, shown } = setup({ order: ['s2', 's1', 's3'], main: 's1' })
      fireEvent.click(screen.getAllByLabelText(closeLabel)[1]!)
      expect(selectSession).toHaveBeenCalledWith('s3')
      expect(removePane).toHaveBeenCalledWith('s1')
      expect(shown()).toEqual(['s2', 's3'])
    })

    it('selects the neighbor to its left when it is last', () => {
      const { selectSession } = setup({ order: ['s2', 's1'], main: 's1' })
      fireEvent.click(screen.getAllByLabelText(closeLabel)[1]!)
      expect(selectSession).toHaveBeenCalledWith('s2')
    })

    it('shows the next selection once it arrives', () => {
      const { selectMain, setOrder, shown } = setup({ order: ['s1', 's2'], main: 's1' })
      fireEvent.click(screen.getAllByLabelText(closeLabel)[0]!)
      setOrder(['s2'])
      selectMain('s2')
      expect(shown()).toEqual(['s2'])
      expect(screen.queryByLabelText(closeLabel)).toBeNull()
    })
  })

  it('does not open the selected Session or an open one from the picker, and lists the rest newest first', () => {
    setup({ order: ['s3', 's1'], main: 's1' })
    fireEvent.click(screen.getByLabelText(addLabel))
    expect(pickerTitles()).toEqual(['Beta'])
  })

  it('lists recent Sessions without blanks or subagents', () => {
    setup({ main: 's3' })
    fireEvent.click(screen.getByLabelText(addLabel))
    expect(pickerTitles()).toEqual(['Beta', 'Alpha'])
  })

  it('adds the picked Session and closes the picker', () => {
    const { addPane } = setup({ main: 's1' })
    fireEvent.click(screen.getByLabelText(addLabel))
    fireEvent.click(screen.getByText('Gamma'))
    expect(addPane).toHaveBeenCalledWith('s3')
    expect(screen.queryByText(zh['split.hint'])).toBeNull()
  })

  it('says so when there is nothing left to add', () => {
    setup({ main: 's4', rows: { s4: ROWS.s4! } })
    fireEvent.click(screen.getByLabelText(addLabel))
    expect(screen.getByText(zh['split.empty'])).toBeTruthy()
  })

  it('closes the picker on an outside pointer press but not an inside one', () => {
    setup({ main: 's1' })
    fireEvent.click(screen.getByLabelText(addLabel))
    fireEvent.pointerDown(screen.getByText(zh['split.hint']))
    expect(screen.queryByText(zh['split.hint'])).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText(zh['split.hint'])).toBeNull()
  })

  it('toggles the picker from the add button', () => {
    setup({ main: 's1' })
    const button = screen.getByLabelText(addLabel)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  describe('dropping a Session row', () => {
    it('shows the drop hint while dragging over, then clears it', () => {
      vi.useFakeTimers()
      const { root } = setup({ main: 's1' })
      fireEvent.dragOver(root, drag('s2'))
      expect(screen.getByText(zh['split.drop'])).toBeTruthy()
      act(() => { vi.advanceTimersByTime(250) })
      expect(screen.queryByText(zh['split.drop'])).toBeNull()
    })

    it('keeps the hint while dragover keeps firing', () => {
      vi.useFakeTimers()
      const { root } = setup({ main: 's1' })
      fireEvent.dragOver(root, drag('s2'))
      act(() => { vi.advanceTimersByTime(150) })
      fireEvent.dragOver(root, drag('s2'))
      act(() => { vi.advanceTimersByTime(150) })
      expect(screen.getByText(zh['split.drop'])).toBeTruthy()
    })

    it('adds a dropped Session', () => {
      const { root, addPane } = setup({ main: 's1' })
      fireEvent.dragOver(root, drag('s2'))
      fireEvent.drop(root, drag('s2'))
      expect(addPane).toHaveBeenCalledWith('s2')
      expect(screen.queryByText(zh['split.drop'])).toBeNull()
    })

    it.each([
      ['a blank Session', 's4'],
      ['an unknown id', 'nope'],
      ['the selected Session', 's1'],
      ['an open Session', 's2'],
    ])('ignores a drop of %s', (_label, id) => {
      const { root, addPane } = setup({ order: ['s1', 's2'], main: 's1' })
      fireEvent.drop(root, drag(id))
      expect(addPane).not.toHaveBeenCalled()
    })

    it('ignores drags that are not text', () => {
      const { root, addPane } = setup({ main: 's1' })
      fireEvent.dragOver(root, drag('s2', ['Files']))
      fireEvent.drop(root, drag('s2', ['Files']))
      expect(addPane).not.toHaveBeenCalled()
      expect(screen.queryByText(zh['split.drop'])).toBeNull()
    })
  })

  describe('new session entry', () => {
    const newSession = () => screen.getByText(zh['split.new'])

    it("creates a Session in the selected Session's Workspace and closes the picker", async () => {
      const { createPane } = setup({ main: 's1' })
      fireEvent.click(screen.getByLabelText(addLabel))
      await act(async () => { fireEvent.click(newSession()) })
      expect(createPane).toHaveBeenCalledWith('w2')
      expect(screen.queryByText(zh['split.hint'])).toBeNull()
    })

    it('falls back to the first Workspace when the selected Session has none', async () => {
      const { createPane } = setup({ main: 's3' })
      fireEvent.click(screen.getByLabelText(addLabel))
      await act(async () => { fireEvent.click(newSession()) })
      expect(createPane).toHaveBeenCalledWith('w1')
    })

    it('offers no new Session without a Workspace', () => {
      setup({ main: 's1', workspaces: { items: [] } })
      fireEvent.click(screen.getByLabelText(addLabel))
      expect(screen.queryByText(zh['split.new'])).toBeNull()
    })

    it('reports a failure, keeps the picker open, and can retry', async () => {
      const { createPane } = setup({ main: 's1' })
      createPane.mockRejectedValueOnce(new Error('host refused'))
      fireEvent.click(screen.getByLabelText(addLabel))
      await act(async () => { fireEvent.click(newSession()) })
      expect(screen.getByRole('alert').textContent).toBe(zh['split.createFailed'])
      expect(screen.getByText(zh['split.hint'])).toBeTruthy()
      await act(async () => { fireEvent.click(newSession()) })
      expect(createPane).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('disables the entry while a Session is being created', async () => {
      const { createPane } = setup({ main: 's1' })
      const pending = Promise.withResolvers<SessionId>()
      createPane.mockReturnValueOnce(pending.promise)
      fireEvent.click(screen.getByLabelText(addLabel))
      fireEvent.click(newSession())
      expect(newSession().closest('button')!.disabled).toBe(true)
      await act(async () => { pending.resolve('created' as SessionId) })
    })
  })

  describe('revealing a pane', () => {
    const scrollTo = vi.fn()
    const useScroll = (): void => {
      scrollTo.mockReset()
      Object.defineProperty(Element.prototype, 'scrollTo', { value: scrollTo, configurable: true })
    }
    const stubLayout = (container: HTMLElement): void => {
      for (const pane of container.querySelectorAll<HTMLElement>('[data-pane-session]')) {
        Object.defineProperty(pane, 'offsetLeft', { value: 300, configurable: true })
        Object.defineProperty(pane, 'offsetWidth', { value: 400, configurable: true })
      }
      const scroller = container.querySelector('[data-pane-session]')!.parentElement!
      Object.defineProperty(scroller, 'clientWidth', { value: 1000, configurable: true })
    }
    const flashed = (container: HTMLElement): (string | null)[] =>
      [...container.querySelectorAll('[data-pane-flash]')].map(node => node.closest('[data-pane-session]')!.getAttribute('data-pane-session'))

    it('does not scroll or glow on the first render', () => {
      useScroll()
      const { ui } = setup({ order: ['s1', 's2'], main: 's1' })
      expect(scrollTo).not.toHaveBeenCalled()
      expect(flashed(ui.container)).toEqual([])
    })

    it('scrolls to and glows the Session the selection moved to, keeping the arrangement', () => {
      useScroll()
      const { ui, selectMain, shown } = setup({ order: ['s1', 's2', 's3'], main: 's1' })
      stubLayout(ui.container)
      selectMain('s3')
      expect(shown()).toEqual(['s1', 's2', 's3'])
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
      expect(flashed(ui.container)).toEqual(['s3'])
    })

    it('appends a newly selected Session on the right and glows it', () => {
      useScroll()
      const { ui, selectMain, shown } = setup({ order: ['s1', 's2'], main: 's1' })
      selectMain('s3')
      expect(shown()).toEqual(['s1', 's2', 's3'])
      expect(flashed(ui.container)).toEqual(['s3'])
    })

    it('stops glowing by itself', () => {
      vi.useFakeTimers()
      useScroll()
      const { ui, selectMain } = setup({ order: ['s1', 's2'], main: 's1' })
      selectMain('s2')
      expect(flashed(ui.container)).toEqual(['s2'])
      act(() => { vi.advanceTimersByTime(2000) })
      expect(flashed(ui.container)).toEqual([])
    })

    it('reveals a pane the user just added once it is on screen', () => {
      useScroll()
      const { ui, setOrder, addPane } = setup({ order: ['s1'], main: 's1' })
      fireEvent.click(screen.getByLabelText(addLabel))
      fireEvent.click(screen.getByText('Beta'))
      expect(addPane).toHaveBeenCalledWith('s2')
      expect(flashed(ui.container)).toEqual([])
      setOrder(['s1', 's2'])
      expect(flashed(ui.container)).toEqual(['s2'])
      expect(scrollTo).toHaveBeenCalled()
    })

    it('reveals a Session created from the picker', async () => {
      useScroll()
      const { ui, setOrder } = setup({ order: ['s1'], main: 's1' })
      fireEvent.click(screen.getByLabelText(addLabel))
      await act(async () => { fireEvent.click(screen.getByText(zh['split.new'])) })
      setOrder(['s1', 'created'])
      expect(flashed(ui.container)).toEqual(['created'])
    })

    describe('after a sidebar row click', () => {
      const row = (id: string) => {
        const node = document.createElement('div')
        node.dataset.rowKey = `session:${id}`
        const label = document.createElement('span')
        node.append(label)
        document.body.append(node)
        return label
      }
      const settle = (): void => { act(() => { vi.advanceTimersByTime(80) }) }
      afterEach(() => { document.body.replaceChildren() })

      it('centers the clicked Session pane and makes it glow, then stops', () => {
        vi.useFakeTimers()
        useScroll()
        const { ui } = setup({ order: ['s1', 's2', 's3'], main: 's1' })
        stubLayout(ui.container)
        fireEvent.click(row('s3'))
        settle()
        expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' })
        expect(flashed(ui.container)).toEqual(['s3'])
        act(() => { vi.advanceTimersByTime(2000) })
        expect(flashed(ui.container)).toEqual([])
      })

      it('glows the selected pane again when its row is clicked, and moves the glow to another row', () => {
        vi.useFakeTimers()
        useScroll()
        const { ui } = setup({ order: ['s1', 's2'], main: 's1' })
        stubLayout(ui.container)
        fireEvent.click(row('s1'))
        settle()
        expect(flashed(ui.container)).toEqual(['s1'])
        fireEvent.click(row('s2'))
        settle()
        expect(flashed(ui.container)).toEqual(['s2'])
      })

      it('does not restart a glow that is already showing', () => {
        vi.useFakeTimers()
        useScroll()
        const { ui, selectMain } = setup({ order: ['s1', 's2'], main: 's1' })
        selectMain('s2')
        const first = ui.container.querySelector('[data-pane-flash]')
        fireEvent.click(row('s2'))
        settle()
        expect(ui.container.querySelector('[data-pane-flash]')).toBe(first)
      })

      it('ignores clicks that are not on a Session row or that name a Session no pane shows', () => {
        vi.useFakeTimers()
        useScroll()
        const { ui } = setup({ order: ['s1', 's2'], main: 's1' })
        fireEvent.click(document.body)
        fireEvent.click(row('elsewhere'))
        settle()
        expect(scrollTo).not.toHaveBeenCalled()
        expect(flashed(ui.container)).toEqual([])
      })

      it('stops listening when the panel unmounts', () => {
        vi.useFakeTimers()
        useScroll()
        const { ui } = setup({ order: ['s1', 's2'], main: 's1' })
        ui.unmount()
        fireEvent.click(row('s2'))
        settle()
        expect(scrollTo).not.toHaveBeenCalled()
      })
    })
  })
})
