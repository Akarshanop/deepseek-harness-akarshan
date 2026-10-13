// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, type ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-1' as SessionId

async function bench(options: { declareConversation?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  const developerTools = createSnapshotStore(true)
  const openSession = vi.fn()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: unknown, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
    }),
    openSession,
  } as never)
  runtime.ctx.provide('configForms', { developerTools: { enabled: developerTools }, get: () => stubConfigForm().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  if (options.declareConversation !== false) {
    await runtime.root.declare({
      'main': { kind: 'keyed', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, (_props: { renderSlot?: unknown }) => null)
  }
  const feature = await runtime.mount({ inject: [...inject], apply })
  if (options.declareConversation !== false) runtime.renderRoot()
  return { runtime, feature, developerTools, openSession }
}

function entry(
  runtime: SlotTestRuntime,
  key: 'main.conversation' | 'conversation.session' | 'conversation.session.header',
) {
  return runtime.slots.entries(key)[0] as { store?: unknown } | undefined
}

describe('target-neutral Conversation apply wiring', () => {
  it('hides only the Trajectory View while developer tools are disabled and restores it when enabled', async () => {
    const b = await bench()
    const header = b.runtime.slots.entries('conversation.session.header')[0]!
    const source = (header.inject!() as { hooks: { conversationViews: ObservableSnapshot<readonly ViewTab[]> } }).hooks.conversationViews
    for (const id of ['chat', 'trajectory', 'probe']) {
      b.runtime.slots.register({ name: 'conversation.view', id, label: id }, (() => null) as never)
    }
    await vi.waitFor(() => { expect(source.getSnapshot().map(tab => tab.id)).toEqual(['chat', 'trajectory', 'probe']) })
    b.developerTools.set(false)
    expect(source.getSnapshot().map(tab => tab.id)).toEqual(['chat', 'probe'])
    b.developerTools.set(true)
    expect(source.getSnapshot().map(tab => tab.id)).toEqual(['chat', 'trajectory', 'probe'])
    await b.runtime.dispose()
  })
  it('injects working pane and Session color commands', async () => {
    localStorage.clear()
    const b = await bench()
    const sessions = b.runtime.sessions
    await sessions.add({ id: 'p1', snapshot: {} })
    await sessions.add({ id: 'p2', snapshot: {} })
    const main = b.runtime.slots.entries('main')[0]!
    const panel = main.inject!() as {
      hooks: {
        panes: ObservableSnapshot<{
          order: readonly string[]
          panes: readonly { sessionId: string; reference: SessionReference }[]
        }>
      }
      addPane: (id: string) => void
      removePane: (id: string) => void
      syncPanes: (selected: string | undefined) => void
      selectSession: (id: string) => void
      createPane: (workspaceId: string) => Promise<string>
      mountPane: (reference: SessionReference) => () => void
    }
    const state = () => panel.hooks.panes.getSnapshot()
    panel.syncPanes('p1')
    panel.addPane('p2')
    expect(state().order).toEqual(['p1', 'p2'])
    expect(state().panes.map(pane => pane.sessionId)).toEqual(['p2'])
    const unmount = panel.mountPane(state().panes[0]!.reference)
    panel.removePane('p2')
    unmount()
    expect(state().order).toEqual(['p1'])
    const created = vi.spyOn(sessions, 'create').mockResolvedValueOnce('p2' as never)
    await expect(panel.createPane('w1')).resolves.toBe('p2')
    expect(created).toHaveBeenCalledWith({ workspaceId: 'w1' })
    expect(state().order).toEqual(['p1', 'p2'])
    panel.selectSession('p2')
    expect(b.openSession).toHaveBeenCalledWith('p2')

    const header = b.runtime.slots.entries('conversation.session.header')[0]!
    const injected = header.inject!('p2' as never, {} as never) as {
      hooks: { sessionColors: ObservableSnapshot<Readonly<Record<string, string>>> }
      setSessionColor: (color: string) => void
    }
    expect(injected.hooks.sessionColors.getSnapshot().p2).toMatch(/^#[0-9a-f]{6}$/u)
    injected.setSessionColor('#123456')
    expect(injected.hooks.sessionColors.getSnapshot().p2).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--dsh-session-color-p2')).toBe('#123456')
    await b.runtime.dispose()
    expect(document.documentElement.style.getPropertyValue('--dsh-session-color-p2')).toBe('')
    localStorage.clear()
  })
  it('waits for the layout-owned conversation declaration before registering its subtree', async () => {
    const b = await bench({ declareConversation: false })
    expect(b.runtime.slots.entries('main')).toHaveLength(0)
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(0)

    await b.runtime.root.declare({
      'main': { kind: 'keyed', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, (_props: { renderSlot?: unknown }) => null)
    b.runtime.renderRoot()
    expect(b.runtime.slots.entries('main').map(row => row.options.key)).toEqual(['conversation'])
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(1)
    expect(b.runtime.slots.spec('main.conversation'))
      .toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(b.runtime.factoryOf('conversation.content').slots)
      .toMatchObject({ views: { scope: 'session' } })
    expect(b.runtime.slots.entries('conversation.session')).toHaveLength(1)
    expect(b.runtime.slots.entries('conversation.session.header')).toHaveLength(1)
    expect(b.runtime.slots.spec('conversation.header')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(b.runtime.slots.spec('conversation.header.leading')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.runtime.slots.entries('conversation.composer.bar')).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('provides both action and assembly services without installing Chat', async () => {
    const b = await bench()
    expect(b.runtime.ctx.get('conversation')).toBeDefined()
    expect(b.runtime.ctx.get('uiConversation')).toBeDefined()
    expect(b.runtime.slots.entries('conversation.view')).toHaveLength(0)
    await b.runtime.dispose()
  })

  it('owns shell slots and shares only the Conversation store', async () => {
    const b = await bench()
    const session = entry(b.runtime, 'conversation.session')
    const header = entry(b.runtime, 'conversation.session.header')
    expect(entry(b.runtime, 'main.conversation')?.store).toBeUndefined()
    expect(b.runtime.factoryOf('conversation.content').store).toBeUndefined()
    expect(session?.store).toBeDefined()
    expect(header?.store).toBe(session?.store)
    expect(b.runtime.slots.spec('conversation.composer'))
      .toEqual({ kind: 'chain', scope: 'session' })
    expect(b.runtime.slots.entries('settings.general.item').map(row => row.options.id))
      .toEqual(['composer-enter'])
    await b.runtime.dispose()
  })

  it('binds a cached locale-aware View roster only to its shell entries', async () => {
    const b = await bench()
    await b.runtime.sessions.add({ id: SID })
    using reference = b.runtime.sessions.retain(SID)
    expect(b.runtime.ctx.uiSession.adapter.bindingSource(reference).getSnapshot().hooks.conversationViews).toBeUndefined()
    const header = b.runtime.slots.entries('conversation.session.header')[0]
    const source = (header?.inject?.() as {
      hooks: { conversationViews: ObservableSnapshot<readonly ViewTab[]> }
    } | undefined)?.hooks.conversationViews
    expect(source).toBeDefined()
    expect(source?.getSnapshot()).toBe(source?.getSnapshot())

    const disposeView = b.runtime.slots.register({
      name: 'conversation.view',
      id: 'probe',
      label: () => b.runtime.ctx.locale.getSnapshot().active,
    }, (() => null) as never)
    await vi.waitFor(() => {
      expect(source?.getSnapshot()).toEqual([{ id: 'probe', label: 'zh' }])
    })
    const chinese = source?.getSnapshot()

    b.runtime.ctx.locale.setLocale('en')
    expect(source?.getSnapshot()).toEqual([{ id: 'probe', label: 'en' }])
    expect(source?.getSnapshot()).not.toBe(chinese)

    disposeView()
    await vi.waitFor(() => { expect(source?.getSnapshot()).toEqual([]) })
    await b.runtime.dispose()
  })

  it('removes services, entries, and declarations with the plugin fiber', async () => {
    const b = await bench()
    await b.feature.dispose()
    expect(b.runtime.ctx.get('conversation')).toBeUndefined()
    expect(b.runtime.ctx.get('uiConversation')).toBeUndefined()
    expect(b.runtime.slots.entries('main')).toHaveLength(0)
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(0)
    expect(b.runtime.slots.spec('main.conversation')).toBeUndefined()
    expect(b.runtime.slots.spec('conversation.view')).toBeUndefined()
    await b.runtime.dispose()
  })
})
