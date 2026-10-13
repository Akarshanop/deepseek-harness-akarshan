// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAX_VISIBLE_PANES, SplitPanes } from '../src/client/split-panes.ts'

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
  const ids$ = (panes: SplitPanes): string[] => panes.source.getSnapshot().map(pane => pane.sessionId)
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

  it('ignores a duplicate and any pane beyond the visible limit', async () => {
    const { make, ids$ } = await bench()
    const panes = make()
    expect(panes.add('s1' as SessionId)).toBe(true)
    expect(panes.add('s1' as SessionId)).toBe(false)
    expect(panes.add('s2' as SessionId)).toBe(true)
    expect(ids$(panes)).toHaveLength(MAX_VISIBLE_PANES - 1)
    expect(panes.add('s3' as SessionId)).toBe(false)
    expect(ids$(panes)).toEqual(['s1', 's2'])
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
    const reference = panes.source.getSnapshot()[0]!.reference
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
    const unmount = panes.mount(panes.source.getSnapshot()[0]!.reference)
    unmount()
    expect(heldBy('s1')).toBe(1)
  })

  it('returns an inert cleanup when mounting a reference it no longer owns', async () => {
    const { make, ids$ } = await bench()
    const panes = make()
    panes.add('s1' as SessionId)
    const reference = panes.source.getSnapshot()[0]!.reference
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
    it('saves the open panes on every change', async () => {
      const { make } = await bench()
      const panes = make()
      panes.add('s1' as SessionId)
      panes.add('s2' as SessionId)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['s1', 's2'])
      panes.remove('s1' as SessionId)
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['s2'])
    })

    it('does not rewrite the saved panes on dispose', async () => {
      const { make } = await bench()
      const panes = make()
      panes.add('s1' as SessionId)
      panes.dispose()
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['s1'])
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
