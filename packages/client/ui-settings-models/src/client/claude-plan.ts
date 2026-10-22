/**
 * Browser half of the Claude-plan card: reads what the Claude Code plugin
 * reports about Claude Code's own sign-in. Anthropic permits a user to sign in
 * to the unmodified Claude Code with their plan, not a third-party app to offer
 * that sign-in, so the card only reports state and shows the command the user
 * runs in Claude Code; it starts nothing and the Host route returns no secret.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Browser-relative path of the Host route `/api/subagent-claude-code.plan`. */
export const CLAUDE_PLAN_ROUTE = 'api/subagent-claude-code.plan'

/** Claude Code's sign-in state as the Host reports it. */
export interface ClaudePlanStatus {
  readonly installed: boolean
  readonly loggedIn: boolean
  readonly authMethod?: string
  readonly subscriptionType?: string
  readonly email?: string
  readonly usesPlan: boolean
  readonly route: { readonly id: string; readonly name: string; readonly models: readonly { id: string; name: string }[] }
  readonly signInCommand: string
  readonly usageUrl: string
  readonly error?: string
}

/** Page state of the Claude-plan card. */
export interface ClaudePlanState {
  /** `plugin-off` when no Claude Code plugin serves the route, so the Claude-plan route does not exist. */
  status: 'idle' | 'loading' | 'ready' | 'plugin-off' | 'error'
  plan?: ClaudePlanStatus
  /** A request failure. */
  error?: string
  /** Whether a status read is in flight. */
  busy: boolean
}

function isStatus(value: unknown): value is ClaudePlanStatus {
  return value !== null && typeof value === 'object'
    && typeof (value as ClaudePlanStatus).loggedIn === 'boolean'
    && typeof (value as ClaudePlanStatus).usesPlan === 'boolean'
}

/** Owner of the card state. */
export class ClaudePlanStore {
  /** Card state the rendered card reads. */
  readonly store: SnapshotStore<ClaudePlanState> = createSnapshotStore<ClaudePlanState>({ status: 'idle', busy: false })

  constructor(private readonly fetcher: typeof fetch) {}

  /** Read Claude Code's sign-in state again; also the card's "Check again" action. */
  async load(): Promise<void> {
    this.store.update((draft) => {
      if (draft.status === 'idle') draft.status = 'loading'
      draft.busy = true
    })
    try {
      const response = await this.fetcher(CLAUDE_PLAN_ROUTE, { headers: { accept: 'application/json' } })
      if (response.status === 404) {
        this.store.set({ status: 'plugin-off', busy: false })
        return
      }
      const body: unknown = await response.json()
      if (!response.ok || !isStatus(body)) {
        this.store.update((draft) => {
          draft.status = draft.plan === undefined ? 'error' : 'ready'
          draft.error = `${String(response.status)} ${response.statusText}`.trim()
          draft.busy = false
        })
        return
      }
      this.store.set({ status: 'ready', plan: body, busy: false })
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.status = draft.plan === undefined ? 'error' : 'ready'
        draft.error = error instanceof Error ? error.message : String(error)
        draft.busy = false
      })
    }
  }
}
