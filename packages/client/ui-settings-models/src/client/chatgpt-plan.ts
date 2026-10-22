/**
 * Browser half of Sign in with ChatGPT for the `openai` route: reads the Host's
 * sign-in state, starts and cancels an attempt, signs out, and adds the
 * `openai` route once a sign-in succeeds so its models reach the picker. The
 * Host route answers with the account email and model list, never a token.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsWriteOutcome } from './operations.ts'

/** Browser-relative path of the Host route `/api/llm-pi-ai.chatgpt`. */
export const CHATGPT_PLAN_ROUTE = 'api/llm-pi-ai.chatgpt'

/** The provider route and settings namespace a ChatGPT sign-in serves. */
export const CHATGPT_PLAN_PROVIDER = 'openai'
const PI_AI_NAMESPACE = 'llm-pi-ai'

/** Sign-in state as the Host reports it. */
export interface ChatGptPlanStatus {
  readonly signedIn: boolean
  readonly email?: string
  readonly planModels?: readonly string[]
  readonly pending: boolean
  readonly url?: string
  readonly error?: string
  readonly routeConfigured: boolean
  readonly apiKeyConfigured: boolean
  readonly revocation?: 'revoked' | 'unconfirmed'
  readonly usageUrl: string
}

/** Page state of the ChatGPT plan card. */
export interface ChatGptPlanState {
  /** `unavailable` when this deployment serves no Sign in with ChatGPT route. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  plan?: ChatGptPlanStatus
  /** A request failure, distinct from the Host-reported attempt failure in `plan.error`. */
  error?: string
  /** Whether a start, cancel, or sign-out request is in flight. */
  busy: boolean
  /** Set when an attempt from this page signed in, until the user dismisses the confirmation. */
  justSignedIn?: boolean
}

/** Host calls the card depends on; production binds the page's `fetch` and the Models operations. */
export interface ChatGptPlanDeps {
  readonly fetch: typeof fetch
  /** Write one settings namespace; used to add the `openai` route after a sign-in. */
  readonly writeSettings: (ns: string, ops: Array<{ op: 'set'; path: string[]; value: Record<string, never> }>) => Promise<SettingsWriteOutcome>
  /** Delay between polls while an attempt waits for the browser. */
  readonly pollMs?: number
}

function isStatus(value: unknown): value is ChatGptPlanStatus {
  return value !== null && typeof value === 'object'
    && typeof (value as ChatGptPlanStatus).signedIn === 'boolean'
    && typeof (value as ChatGptPlanStatus).pending === 'boolean'
}

/** Owner of the card state; one instance serves every card on the page. */
export class ChatGptPlanStore {
  /** Card state every rendered card reads. */
  readonly store: SnapshotStore<ChatGptPlanState> = createSnapshotStore<ChatGptPlanState>({ status: 'idle', busy: false })
  private polling: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Whether this page started an attempt; only that sign-in adds the route, never a page load. */
  private attempted = false

  constructor(private readonly deps: ChatGptPlanDeps) {}

  /** Read the Host state; a deployment without the route settles as `unavailable`. */
  async load(): Promise<void> {
    if (this.store.getSnapshot().status === 'idle') this.store.update((draft) => { draft.status = 'loading' })
    await this.request('GET')
  }

  /**
   * Start a sign-in and open OpenAI's authorization page.
   * @param open - opens the page; called with the URL once the Host reports it.
   */
  async start(open: (url: string) => void): Promise<void> {
    this.attempted = true
    const plan = await this.request('POST', 'start')
    if (plan?.url !== undefined) open(plan.url)
  }

  /** Dismiss the first-sign-in confirmation. */
  acknowledge(): void {
    this.store.update((draft) => { draft.justSignedIn = false })
  }

  /** Withdraw the waiting attempt. */
  async cancel(): Promise<void> {
    this.attempted = false
    await this.request('POST', 'cancel')
  }

  /** Revoke the session at OpenAI and remove the stored sign-in. */
  async signOut(): Promise<void> {
    await this.request('POST', 'sign-out')
  }

  /** Stop polling. */
  dispose(): void {
    this.disposed = true
    if (this.polling !== undefined) clearTimeout(this.polling)
    this.polling = undefined
  }

  private async request(method: 'GET' | 'POST', action?: string): Promise<ChatGptPlanStatus | undefined> {
    if (method === 'POST') this.store.update((draft) => { draft.busy = true })
    const before = this.store.getSnapshot().plan
    try {
      const url = action === undefined ? CHATGPT_PLAN_ROUTE : `${CHATGPT_PLAN_ROUTE}?action=${encodeURIComponent(action)}`
      const response = await this.deps.fetch(url, { method, headers: { accept: 'application/json' } })
      if (response.status === 404) {
        this.store.set({ status: 'unavailable', busy: false })
        return undefined
      }
      const body: unknown = await response.json()
      if (!response.ok || !isStatus(body)) {
        const message = body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `${String(response.status)} ${response.statusText}`.trim()
        this.store.update((draft) => {
          draft.status = draft.plan === undefined ? 'error' : 'ready'
          draft.error = message
          draft.busy = false
        })
        return undefined
      }
      this.store.update((draft) => {
        draft.status = 'ready'
        draft.plan = body
        draft.busy = false
        delete draft.error
      })
      if (this.attempted && body.signedIn && before?.signedIn !== true) {
        this.attempted = false
        this.store.update((draft) => { draft.justSignedIn = true })
        if (!body.routeConfigured) await this.addRoute()
      }
      this.schedulePoll(body)
      return body
    } catch (error: unknown) {
      this.store.update((draft) => {
        draft.status = draft.plan === undefined ? 'error' : 'ready'
        draft.error = error instanceof Error ? error.message : String(error)
        draft.busy = false
      })
      return undefined
    }
  }

  /** Add the `openai` route naming no API key, so the stored sign-in authenticates it. */
  private async addRoute(): Promise<void> {
    const written = await this.deps.writeSettings(PI_AI_NAMESPACE, [
      { op: 'set', path: ['providers', CHATGPT_PLAN_PROVIDER], value: {} },
    ])
    if (written.kind === 'written') {
      this.store.update((draft) => {
        if (draft.plan !== undefined) draft.plan = { ...draft.plan, routeConfigured: true }
      })
      return
    }
    this.store.update((draft) => { draft.error = written.message })
  }

  private schedulePoll(plan: ChatGptPlanStatus): void {
    if (this.polling !== undefined) clearTimeout(this.polling)
    this.polling = undefined
    if (!plan.pending || this.disposed) return
    this.polling = setTimeout(() => {
      this.polling = undefined
      void this.request('GET')
    }, this.deps.pollMs ?? 1_500)
  }
}
