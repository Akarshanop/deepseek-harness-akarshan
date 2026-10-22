/**
 * Authenticated `/api` route through which the Models settings page signs the
 * `openai` route in with ChatGPT, reads the sign-in state, and signs out. The
 * sign-in itself runs as the `openai` authorization flow, so one attempt runs
 * at a time and success means the credential record was committed. Responses
 * carry the account email and model list, never a token.
 *
 * @module dsh-llm-pi-ai/chatgpt-routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-client-connection'
import { recordKeyFor } from './auth.ts'
import {
  CHATGPT_PROVIDER,
  CHATGPT_USAGE_URL,
  isChatGptCredential,
  revokeChatGptSession,
  type ChatGptRegistrationStore,
  type ChatGptRevocation,
} from './chatgpt.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/** Path of the route below the shared `/api` channel. */
export const CHATGPT_ROUTE_PATH = '/api/llm-pi-ai.chatgpt'

/** Sign-in state the settings page renders. */
export interface ChatGptSignInStatus {
  /** Whether a Sign in with ChatGPT credential is stored for the `openai` route. */
  readonly signedIn: boolean
  /** Email of the signed-in or last registered account. */
  readonly email?: string
  /** Model ids the account's catalog lists for display. */
  readonly planModels?: readonly string[]
  /** Whether a sign-in attempt is waiting for the browser. */
  readonly pending: boolean
  /** The pending attempt's authorization page. */
  readonly url?: string
  /** Why the last attempt failed. */
  readonly error?: string
  /** Whether an `openai` route is configured. */
  readonly routeConfigured: boolean
  /** Whether that route names an API key, which takes precedence over the ChatGPT sign-in. */
  readonly apiKeyConfigured: boolean
  /** How the last sign-out ended at OpenAI. */
  readonly revocation?: ChatGptRevocation
  /** ChatGPT usage settings, where the user reviews and limits this app's plan usage. */
  readonly usageUrl: string
}

/** What the route reads and writes. */
export interface ChatGptRouteDeps {
  /** pi-ai's view of the credential records. */
  readonly credentials: CredentialStore
  /** This host's retained registration. */
  readonly registration: ChatGptRegistrationStore
  /** The currently resolved route profiles. */
  readonly profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
}

interface Attempt {
  readonly controller: AbortController
  url?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the route once both the connection and authorization services are present.
 * @param ctx - the plugin context.
 * @param deps - credential, registration, and profile readers.
 */
export function registerChatGptRoutes(ctx: Context, deps: ChatGptRouteDeps): void {
  ctx.inject(['connection', 'authorization'], (scope) => {
    let attempt: Attempt | undefined
    let lastError: string | undefined
    let lastRevocation: ChatGptRevocation | undefined

    const status = async (): Promise<ChatGptSignInStatus> => {
      const [stored, registration] = await Promise.all([
        deps.credentials.read(CHATGPT_PROVIDER),
        deps.registration.read(),
      ])
      const profile = deps.profiles().get(CHATGPT_PROVIDER)
      return {
        signedIn: isChatGptCredential(stored),
        ...registration?.email === undefined ? {} : { email: registration.email },
        ...registration?.planModels === undefined ? {} : { planModels: registration.planModels },
        pending: attempt !== undefined,
        ...attempt?.url === undefined ? {} : { url: attempt.url },
        ...lastError === undefined ? {} : { error: lastError },
        routeConfigured: profile !== undefined,
        apiKeyConfigured: profile?.apiKeyEnv !== undefined,
        ...lastRevocation === undefined ? {} : { revocation: lastRevocation },
        usageUrl: CHATGPT_USAGE_URL,
      }
    }

    const start = async (): Promise<void> => {
      if (attempt !== undefined) return
      const current: Attempt = { controller: new AbortController() }
      attempt = current
      lastError = undefined
      lastRevocation = undefined
      const ready = Promise.withResolvers<void>()
      void scope.authorization.begin({
        key: recordKeyFor(CHATGPT_PROVIDER),
        method: 'oauth',
        signal: current.controller.signal,
        interaction: {
          notify: (notice) => {
            if (notice.url === undefined) return
            current.url = notice.url
            ready.resolve()
          },
          // The flow completes through the browser callback and asks nothing.
          prompt: () => Promise.reject(new AuthorizationDeclinedError()),
        },
      }).then(
        (outcome) => {
          if (outcome.status === 'cancelled') scope.logger.info('llm-pi-ai: Sign in with ChatGPT was cancelled')
        },
        (error: unknown) => {
          lastError = message(error)
          // The flow's messages name the failed step and never carry a token.
          scope.logger.warn('llm-pi-ai: Sign in with ChatGPT did not finish: %s', lastError)
        },
      ).finally(() => {
        if (attempt === current) attempt = undefined
        ready.resolve()
      })
      await ready.promise
    }

    const signOut = async (signal: AbortSignal): Promise<void> => {
      attempt?.controller.abort()
      lastError = undefined
      const stored = await deps.credentials.read(CHATGPT_PROVIDER)
      if (!isChatGptCredential(stored)) return
      lastRevocation = await revokeChatGptSession(stored, {}, signal)
      await deps.credentials.delete(CHATGPT_PROVIDER)
    }

    scope.effect(() => scope.connection.fetch.register({
      path: CHATGPT_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'POST') {
            const action = new URL(request.url).searchParams.get('action')
            switch (action) {
              case 'start':
                await start()
                break
              case 'cancel':
                attempt?.controller.abort()
                break
              case 'sign-out':
                await signOut(request.signal)
                break
              default:
                return json({ error: `unknown action ${JSON.stringify(action)}` }, 400)
            }
          }
          return json(await status())
        } catch (error: unknown) {
          return json({ error: message(error) }, 500)
        }
      },
    }), 'llm-pi-ai: Sign in with ChatGPT route')
  })
}
