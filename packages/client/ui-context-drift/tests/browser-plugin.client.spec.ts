/**
 * ui-context-drift plugin halves: the browser entry's dictionary, header
 * utility, and input-dock registrations against the real SlotRegistry (with
 * fiber teardown proving removal — HMR safety), the session-bound actions
 * routed through the Commands Remote and workspace navigation, and the inert
 * node entry.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { DriftInjected } from '../src/client/slots.ts'
import { apply as applyNode } from '../src/index.ts'
import { sessionReferenceUri } from '../src/client/model.ts'
import { en, NS, zh } from '../src/client/locales.ts'

type CommandOutcome =
  | { ok: false; error: { message: string } }
  | { ok: true; value: undefined | { result: { kind: 'success'; text?: string } | { kind: 'error'; text: string } } }

/** Command lines the stubbed Commands Remote received, and its scripted outcome. */
const executed: [string, string][] = []
let commandOutcome: CommandOutcome = { ok: true, value: { result: { kind: 'success', text: 'Compacted' } } }
/** startSession calls the stubbed workspace navigation received. */
const started: unknown[] = []

const SLOTS = ['conversation.session.header.utilities', 'conversation.input.dock'] as const

function entryIds(ctx: Context, slot: typeof SLOTS[number]): (string | undefined)[] {
  return ctx.slots.entries(slot).map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree that declares both target lists. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  const commandsRemote = {
    execute: async (sessionId: string, line: string) => {
      executed.push([sessionId, line])
      return commandOutcome
    },
  }
  ctx.provide('remote', { $on: () => () => {}, commands: commandsRemote } as never)
  ctx.provide('remote.commands', commandsRemote as never)
  ctx.provide('uiWorkspace', {
    startSession: (workspaceId: unknown, options: unknown) => { started.push([workspaceId, options]) },
  } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('en')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

function face(ctx: Context): DriftInjected {
  const entry = ctx.slots
    .entries('conversation.session.header.utilities')
    .find(candidate => candidate.options.id === 'context-drift')
  const injectFace = entry?.inject as ((sessionId: SessionId) => DriftInjected) | undefined
  if (injectFace === undefined) throw new Error('context-drift entry registered no inject face')
  return injectFace(SessionId('session-1'))
}

describe('ui-context-drift browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace'])
  })

  it('registers the header meter and the composer nudge, and fiber teardown removes both (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    for (const slot of SLOTS) expect(entryIds(ctx, slot)).toContain('context-drift')
    await fiber.dispose()
    for (const slot of SLOTS) expect(entryIds(ctx, slot)).not.toContain('context-drift')
  })

  it('runs /compact in the bound session and maps each outcome to a failure line or null', async () => {
    const { ctx } = await bench()
    const actions = face(ctx)
    executed.length = 0

    commandOutcome = { ok: true, value: { result: { kind: 'success', text: 'Compacted 4 history items.' } } }
    await expect(actions.compact()).resolves.toBeNull()
    commandOutcome = { ok: true, value: { result: { kind: 'error', text: 'Compaction is unavailable.' } } }
    await expect(actions.compact()).resolves.toBe('Compaction is unavailable.')
    commandOutcome = { ok: true, value: undefined }
    await expect(actions.compact()).resolves.toBe(en['error.unavailable'])
    commandOutcome = { ok: false, error: { message: 'disconnected' } }
    await expect(actions.compact()).resolves.toBe('disconnected')
    expect(executed).toEqual(Array.from({ length: 4 }, () => ['session-1', '/compact']))
  })

  it('starts a new chat whose draft summarizes the bound session', async () => {
    const { ctx } = await bench()
    started.length = 0
    face(ctx).newChat('previous chat')
    expect(started).toEqual([[undefined, {
      prompt: `#[previous chat](${sessionReferenceUri('session-1')}) `,
      clearPreviousDraft: true,
    }]])
  })

  it('treats unavailable storage as no dismissal', async () => {
    const { ctx } = await bench()
    const actions = face(ctx)
    expect(() => { actions.writeDismissal({ baselineSeq: 3 }) }).not.toThrow()
    expect(actions.readDismissal() === null || actions.readDismissal()?.baselineSeq === 3).toBe(true)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('card.title')).toBe(en['card.title'])
    ctx.locale.setLocale('zh')
    expect(translate('card.title')).toBe(zh['card.title'])
    await fiber.dispose()
    expect(translate('card.title')).not.toBe(zh['card.title'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-context-drift node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})
