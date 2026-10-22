/**
 * Context-drift plugin, browser half: the drift meter in the session header
 * utilities and the high-drift nudge in the composer input dock. Both read
 * the host's `contextDrift` projection; compacting runs the `/compact`
 * command through the Commands Remote, and a new chat opens with a `#`
 * reference that makes the host summarize this session into it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the header-utilities and input-dock slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the workspace navigation service (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DriftChip } from './DriftChip.tsx'
import { DriftNudge } from './DriftNudge.tsx'
import { en, NS, zh, type ContextDriftKey } from './locales.ts'
import { summarizedSessionMention } from './model.ts'
import type { NudgeDismissal } from './model.ts'
import type { DriftInjected } from './slots.ts'

export type { DriftInjected } from './slots.ts'
export type { NudgeDismissal } from './model.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Context-drift meter and nudge copy. */
    'contextDrift': ContextDriftKey
  }
}

/** Per-viewer storage key prefix of nudge dismissals. */
const DISMISSAL_KEY_PREFIX = 'dsh.contextDrift.nudge.'

/** Required services: slots, dictionaries, the Commands Remote, and workspace navigation. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace']

function readDismissal(sessionId: SessionId): NudgeDismissal | null {
  try {
    // Throws where storage is absent or blocked; the catch treats that as no dismissal.
    const raw = globalThis.localStorage.getItem(`${DISMISSAL_KEY_PREFIX}${sessionId}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('baselineSeq' in parsed)) return null
    return typeof parsed.baselineSeq === 'number' ? { baselineSeq: parsed.baselineSeq } : null
  } catch (error) {
    // Storage can be blocked or hold foreign data; a missing dismissal only re-shows the nudge.
    void error
    return null
  }
}

function writeDismissal(sessionId: SessionId, value: NudgeDismissal | null): void {
  try {
    const key = `${DISMISSAL_KEY_PREFIX}${sessionId}`
    if (value === null) globalThis.localStorage.removeItem(key)
    else globalThis.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    // Storage can be blocked; the dismissal then lasts for this page view only.
    void error
  }
}

/**
 * Client plugin body: register the dictionaries, the header meter, and the composer nudge.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-context-drift: dictionaries')
  const translate = ctx.locale.bind(NS)

  const actionsFor = (sessionId: SessionId): DriftInjected => ({
    compact: async () => {
      const result = await ctx.remote.commands.execute(sessionId, '/compact', [])
      if (!result.ok) return result.error.message
      if (result.value === undefined) return translate('error.unavailable')
      return result.value.result.kind === 'error' ? result.value.result.text : null
    },
    newChat: (label) => {
      ctx.uiWorkspace.startSession(undefined, {
        prompt: `${summarizedSessionMention(sessionId, label)} `,
        clearPreviousDraft: true,
      })
    },
    readDismissal: () => readDismissal(sessionId),
    writeDismissal: (value) => { writeDismissal(sessionId, value) },
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'context-drift',
    // Sits before the open-in-app (-10) and schedule (-5) utilities, nearest the title.
    order: -20,
    locale: NS,
    inject: actionsFor,
  }, DriftChip))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'context-drift',
    // Below todo (0), goal (10), and queue (20): the card nearest the composer.
    order: 30,
    locale: NS,
    inject: actionsFor,
  }, DriftNudge))
}
