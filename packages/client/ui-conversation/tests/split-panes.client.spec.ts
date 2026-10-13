// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SplitPanes } from '../src/client/split-panes.ts'

const STORAGE_KEY = 'dsh.conversation.splitPanes'
const disposers: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  localStorage.clear()
  vi.restoreAllMocks()
})

async function bench(ids: readonly string[] = ['s1', 's2', 's3', 's4']) {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  for (const id of ids) await runtime.sessions.add({ id, snapshot: {} })
  const make = (): SplitPanes => {
    const panes = new SplitPanes(runtime.sessions)
    disposers.push(() => { panes.dispose() })
    return panes
  }
  const heldBy = (id: string): number =>
    runtime.sessions.retainInfo(id as SessionId).getSnapshot().retainedBy.splitPane ?? 0
  const ids$ = (panes: SplitPanes): string[] => panes.source.getSnapshot().panes.map(pane => pane.sessionId)
  return { runtime, make, heldBy, ids$ }
}

describe('SplitPanes', () => {
  it('adds panes in order and retains each Session', async () => {
    const { make, heldBy, ids$ } = await bench()
    const panes = make()
    expect(panes.add('s1' as SessionId)).toBe(true)
    expect(panes.add('s2' as SessionId)).toBe(true)
    expect(ids$(panes)).toEqual(['s1', 's2'])
    expect(heldBy('s1')).toBe(1)
    expect(heldBy('s2')).toBe(1)
  })

  it('ignores a duplicate but accepts any number of distinct panes', async () => {
    const ids = Array.from({ length: 8 }, (_unused, index) => `many-${index}`)
    const { make, ids$ } = await bench(ids)
    const panes = make()
    expect(panes.add('many-0' as SessionId)).toBe(true)
    expect(panes.add('many-0' as SessionId)).toBe(false)
    for (const id of ids.slice(1)) expect(panes.add(id as SessionId)).toBe(true)
    expect(ids$(panes)).toEqual(ids)
  })

  it('releases a removed pane immediately when its root never mounted', async () => {
    const { make, heldBy, ids$ } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    panes.remove('s1' as SessionId)
    panes.remove('s1' as SessionId)
    expect(ids$(panes)).toEqual([])
    expect(heldBy('s1')).toBe(0)
  })

  it('keeps a removed pane retained until its mounted root unmounts', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    const reference = panes.source.getSnapshot().panes[0]!.reference
    const unmount = panes.mount(reference)
    panes.remove('s1' as SessionId)
    expect(heldBy('s1')).toBe(1)
    unmount()
    expect(heldBy('s1')).toBe(0)
  })

  it('keeps a live pane retained after its root unmounts', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    const unmount = panes.mount(panes.source.getSnapshot().panes[0]!.reference)
    unmount()
    expect(heldBy('s1')).toBe(1)
  })

  it('returns an inert cleanup when mounting a reference it no longer owns', async () => {
    const { make, ids$ } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    const reference = panes.source.getSnapshot().panes[0]!.reference
    panes.remove('s1' as SessionId)
    expect(() => { panes.mount(reference)() }).not.toThrow()
    expect(ids$(panes)).toEqual([])
  })

  it('releases every pane and refuses new ones after dispose', async () => {
    const { make, heldBy, ids$ } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.dispose()
    expect(ids$(panes)).toEqual([])
    expect(heldBy('s1')).toBe(0)
    expect(heldBy('s2')).toBe(0)
    expect(panes.add('s3' as SessionId)).toBe(false)
  })

  it('drops a Session the controller cannot retain', async () => {
    const { make, ids$ } = await bench()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const panes = make()
    expect(panes.add('missing' as SessionId)).toBe(false)
    expect(ids$(panes)).toEqual([])
  })

  it('keeps a tab whose reference was released on purpose, when its pending open then rejects', async () => {
    const { runtime, make, ids$ } = await bench()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const panes = make()
    const failure = Promise.withResolvers<undefined>()
    const retain = runtime.sessions.retain.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, 'retain').mockImplementation((target, options) => {
      const reference = retain(target, options)
      Object.defineProperty(reference, 'ready', { value: failure.promise })
      return reference
    })
    panes.add('s1' as SessionId)
    // The Session becomes the selected one: its pane reference is released, and its pending open then rejects.
    panes.sync('s1' as SessionId)
    failure.reject(new Error('released'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(panes.source.getSnapshot().order).toEqual(['s1'])
    expect(ids$(panes)).toEqual([])
  })

  it('drops a pane whose Session fails to open', async () => {
    const { runtime, make, ids$ } = await bench()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const panes = make()
    const retain = runtime.sessions.retain.bind(runtime.sessions)
    vi.spyOn(runtime.sessions, 'retain').mockImplementation((target, options) => {
      const reference = retain(target, options)
      Object.defineProperty(reference, 'ready', { value: Promise.reject(new Error('open failed')) })
      return reference
    })
    panes.add('s1' as SessionId)
    await vi.waitFor(() => { expect(ids$(panes)).toEqual([]) })
  })

  describe('persistence', () => {
    it('saves the open tabs on every change', async () => {
      const { make } = await bench()
      const panes = make()
      panes.add('s1' as SessionId)
      panes.add('s2' as SessionId)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ order: ['s1', 's2'] })
      panes.remove('s1' as SessionId)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ order: ['s2'] })
    })

    it('does not rewrite the saved panes on dispose', async () => {
      const { make } = await bench()
      const panes = make()
      panes.add('s1' as SessionId)
      panes.dispose()
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ order: ['s1'] })
    })

    it('restores saved panes when the Session list is already ready', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['s2', 's3']))
      const { make, ids$ } = await bench()
      expect(ids$(make())).toEqual(['s2', 's3'])
    })

    it('waits for the Session list before restoring', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['s2']))
      const { runtime, make, ids$ } = await bench()
      runtime.sessions.list.update((draft) => { draft.phase = 'pending' })
      const panes = make()
      expect(ids$(panes)).toEqual([])
      runtime.sessions.list.update((draft) => { draft.phase = 'ready' })
      expect(ids$(panes)).toEqual(['s2'])
    })

    it('stops waiting for the list when disposed first', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['s2']))
      const { runtime, make, ids$ } = await bench()
      runtime.sessions.list.update((draft) => { draft.phase = 'pending' })
      const panes = make()
      panes.dispose()
      runtime.sessions.list.update((draft) => { draft.phase = 'ready' })
      expect(ids$(panes)).toEqual([])
    })

    it('skips saved Sessions that no longer exist', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['gone', 's1']))
      const { make, ids$ } = await bench()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(ids$(make())).toEqual(['s1'])
    })

    it.each([
      ['malformed JSON', '{not json'],
      ['a non-array value', '{"a":1}'],
    ])('starts empty from %s', async (_label, raw) => {
      localStorage.setItem(STORAGE_KEY, raw)
      const { make, ids$ } = await bench()
      expect(ids$(make())).toEqual([])
    })

    it('ignores non-string entries in the saved list', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([1, null, 's1']))
      const { make, ids$ } = await bench()
      expect(ids$(make())).toEqual(['s1'])
    })

    it('keeps working when storage rejects writes', async () => {
      const { make, ids$ } = await bench()
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
      const panes = make()
      expect(panes.add('s1' as SessionId)).toBe(true)
      expect(ids$(panes)).toEqual(['s1'])
    })
  })
})

describe('SplitPanes selection and tabs', () => {
  const order = (panes: SplitPanes): string[] => [...panes.source.getSnapshot().order]
  const records = (panes: SplitPanes): string[] => panes.source.getSnapshot().panes.map(pane => pane.sessionId)

  it('appends the selected Session to the open list without a reference of its own', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual(['s1'])
    expect(records(panes)).toEqual([])
    expect(heldBy('s1')).toBe(0)
  })

  it('replaces a lone Session with the new selection, as without a split view', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.sync('s2' as SessionId)
    expect(order(panes)).toEqual(['s2'])
    expect(records(panes)).toEqual([])
    expect(heldBy('s1')).toBe(0)
  })

  it('releases the reference of a lone open Session the selection replaces', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.add('s2' as SessionId)
    expect(heldBy('s2')).toBe(1)
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual(['s1'])
    expect(heldBy('s2')).toBe(0)
  })

  it('with a split view keeps the Session it replaced open, with a reference, and appends the new one', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.sync('s3' as SessionId)
    expect(order(panes)).toEqual(['s1', 's2', 's3'])
    expect(records(panes).sort()).toEqual(['s1', 's2'])
    expect(heldBy('s1')).toBe(1)
    expect(heldBy('s3')).toBe(0)
  })

  it('selecting an open Session leaves the order alone and swaps which one holds a reference', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.add('s3' as SessionId)
    panes.sync('s2' as SessionId)
    expect(order(panes)).toEqual(['s1', 's2', 's3'])
    expect(records(panes).sort()).toEqual(['s1', 's3'])
    expect(heldBy('s2')).toBe(0)
    panes.sync('s3' as SessionId)
    expect(order(panes)).toEqual(['s1', 's2', 's3'])
    expect(records(panes).sort()).toEqual(['s1', 's2'])
  })

  it('does nothing while nothing is selected', async () => {
    const { make } = await bench()
    const panes = make()
    panes.add('s2' as SessionId)
    panes.sync(undefined)
    expect(order(panes)).toEqual(['s2'])
  })

  it('does not publish when the selection changes nothing', async () => {
    const { make } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    const before = panes.source.getSnapshot()
    panes.sync('s1' as SessionId)
    expect(panes.source.getSnapshot()).toBe(before)
  })

  it('can open the selected Session as a tab without taking a reference for it', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    expect(panes.add('s1' as SessionId)).toBe(false)
    panes.add('s2' as SessionId)
    expect(heldBy('s2')).toBe(1)
  })

  it('does not take a second reference for a Session that already has one', async () => {
    const { make, heldBy } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.sync('s3' as SessionId)
    expect(panes.add('s1' as SessionId)).toBe(false)
    expect(heldBy('s1')).toBe(1)
  })

  it('closing the selected Session removes it and keeps it from coming back until another is selected', async () => {
    const { make } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.remove('s1' as SessionId)
    expect(order(panes)).toEqual(['s2'])
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual(['s2'])
    panes.sync('s2' as SessionId)
    expect(order(panes)).toEqual(['s2'])
    // Back to a single open Session, the next selection replaces it.
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual(['s1'])
  })

  it('drops a tab it cannot retain when the selection moves on', async () => {
    const { make } = await bench()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const panes = make()
    panes.sync('gone' as SessionId)
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual(['s1'])
  })

  it('ignores selection changes after dispose', async () => {
    const { make } = await bench()
    const panes = make()
    panes.dispose()
    panes.sync('s1' as SessionId)
    expect(order(panes)).toEqual([])
  })

  it('saves the full order, including the selected Session', async () => {
    const { make } = await bench()
    const panes = make()
    panes.sync('s1' as SessionId)
    panes.add('s2' as SessionId)
    panes.sync('s3' as SessionId)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ order: ['s1', 's2', 's3'] })
  })

  it('restores every saved tab, then the selected Session keeps its place or joins the end', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: ['s1', 's2', 's3', 's4', 's1'] }))
    const first = await bench()
    const panes = first.make()
    expect(order(panes)).toEqual(['s1', 's2', 's3', 's4'])
    panes.sync('s3' as SessionId)
    expect(order(panes)).toEqual(['s1', 's2', 's3', 's4'])
    expect(records(panes).sort()).toEqual(['s1', 's2', 's4'])
  })

  it('keeps saved places when the selection arrives before the saved order does', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: ['s1', 's2', 's3'] }))
    const { runtime, make } = await bench()
    runtime.sessions.list.update((draft) => { draft.phase = 'pending' })
    const panes = make()
    panes.sync('s3' as SessionId)
    expect(order(panes)).toEqual(['s3'])
    runtime.sessions.list.update((draft) => { draft.phase = 'ready' })
    expect(order(panes)).toEqual(['s1', 's2', 's3'])
    expect(records(panes).sort()).toEqual(['s1', 's2'])
  })

  it('appends a selected Session missing from the saved order', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: ['s1', 's2'] }))
    const { make } = await bench()
    const panes = make()
    panes.sync('s4' as SessionId)
    expect(order(panes)).toEqual(['s1', 's2', 's4'])
  })

  it('reads the earlier saved formats', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ panes: ['s2', 's3'], mainSlot: 1 }))
    const { make } = await bench()
    expect(order(make())).toEqual(['s2', 's3'])
  })

  it('restores nothing from a saved null or an object without tabs', async () => {
    for (const raw of ['null', '{"mainSlot":2}']) {
      localStorage.setItem(STORAGE_KEY, raw)
      const { make } = await bench()
      expect(order(make())).toEqual([])
    }
  })
})
