/**
 * Sign in with ChatGPT for the `openai` route: OpenAI's dynamic-registration
 * OAuth flow for open-source, locally run apps
 * (https://developers.openai.com/siwc/token-sharing-open-source). The user
 * signs in in their own browser and approves "Use your ChatGPT plan"; the
 * resulting access token authenticates Responses API requests on
 * `api.openai.com/v1`, which count against the user's ChatGPT plan.
 *
 * The app registers under its own name ({@link CHATGPT_APP_NAME}), never as
 * another application, as OpenAI's Sign in with ChatGPT Terms require. Each
 * host keeps one opaque `urn:uuid:` host id, and a returning sign-in reuses the
 * client id OpenAI issued at registration. Tokens are stored only in the local
 * credential store; the retained registration (host id, issued client id,
 * account identity, plan models) holds no secret.
 *
 * Refresh and request authentication stay with pi-ai's `openai` provider: its
 * refresh exchanges the stored refresh token with the stored issued client id,
 * and its Responses implementation omits the request fields this route rejects.
 *
 * @module dsh-llm-pi-ai/chatgpt
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The catalog provider, and harness route, whose OAuth login this module serves. */
export const CHATGPT_PROVIDER = 'openai'

/** The application name OpenAI shows on the consent screen and in ChatGPT settings. */
export const CHATGPT_APP_NAME = 'DeepSeek Harness'

/** Where a user reviews and limits this app's use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const RESOURCE = 'https://api.openai.com/v1'
const MODELS_URL = `${RESOURCE}/models`
/** First-time registration entry point; never stored or used for a token exchange. */
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
/** Preferred loopback port; another free port is used when it is taken, since only the port may vary. */
const PREFERRED_CALLBACK_PORT = 1455
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/auth/callback'
/**
 * Subtracted from the token lifetime so a request never starts with a token
 * about to expire; the same margin pi-ai's own refresh applies, so a stored
 * expiry means the same thing whichever side wrote it.
 */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000
/** Clock skew tolerated when checking the ID token's expiry. */
const CLOCK_SKEW_S = 300

/**
 * Non-secret facts this host keeps across sign-ins and sign-outs: the opaque
 * host id sent as `ext_agent_host_id`, and after a registration the client id
 * OpenAI issued and the account it is bound to.
 */
export interface ChatGptRegistration {
  /** `urn:uuid:` host id, created once before the first sign-in. */
  readonly hostId: string
  /** Client id OpenAI issued at registration (`oaiapp_…`); reused by later sign-ins. */
  readonly clientId?: string
  /** Validated ID-token subject of the registered account. */
  readonly subject?: string
  /** Account email from the validated ID token, shown in settings and sent as `login_hint`. */
  readonly email?: string
  /** Model slugs the account's catalog lists for display, in server order. */
  readonly planModels?: readonly string[]
}

/** Persistence for the {@link ChatGptRegistration} of this host. */
export interface ChatGptRegistrationStore {
  /**
   * Read the retained registration.
   * @returns the registration, or undefined before the first sign-in.
   */
  read(): Promise<ChatGptRegistration | undefined>
  /**
   * Replace the retained registration.
   * @param registration - the registration to keep.
   */
  write(registration: ChatGptRegistration): Promise<void>
}

/** Network and clock seams; production uses the global `fetch` and wall clock. */
export interface ChatGptSignInDeps {
  readonly registration: ChatGptRegistrationStore
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** Loopback port to try first; tests pass 0 for an ephemeral port. */
  readonly preferredPort?: number
}

/** A sign-in failure the user can act on; the message names the next step and never a secret. */
export class ChatGptSignInError extends LlmError {
  constructor(message: string, code = 'CHATGPT_SIGN_IN', options?: ErrorOptions) {
    super(`Sign in with ChatGPT: ${message}`, code, options)
    this.name = 'ChatGptSignInError'
  }
}

function randomValue(): string {
  return randomBytes(32).toString('base64url')
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomValue()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * A fresh `urn:uuid:` host id (UUIDv4).
 * @returns the host id.
 */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`
}

interface CallbackResult {
  readonly params: URLSearchParams
}

interface CallbackListener {
  readonly redirectUri: string
  readonly result: Promise<CallbackResult>
  close(): void
}

function sendPage(response: ServerResponse, status: number, title: string, body: string): void {
  const escape = (text: string): string => text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`)
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">'
    + `<h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(body)}</p></body></html>`)
}

async function listen(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, CALLBACK_HOST, () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

/**
 * Start the loopback listener before the browser opens. The first request to
 * the callback path settles the attempt; other paths answer 404.
 */
async function startCallback(preferredPort: number): Promise<CallbackListener> {
  const settled = Promise.withResolvers<CallbackResult>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://${CALLBACK_HOST}`)
    if (url.pathname !== CALLBACK_PATH) {
      sendPage(response, 404, 'Not found', 'This address only completes a DeepSeek Harness sign-in.')
      return
    }
    const failed = url.searchParams.get('error') !== null
    sendPage(
      response,
      failed ? 400 : 200,
      failed ? 'ChatGPT was not connected' : 'Signed in with ChatGPT',
      failed
        ? 'DeepSeek Harness did not get permission to use your ChatGPT plan. You can close this tab and try again from Settings.'
        : 'You can close this tab and return to DeepSeek Harness.',
    )
    settled.resolve({ params: url.searchParams })
  })
  let port: number
  try {
    port = await listen(server, preferredPort)
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') || preferredPort === 0) throw error
    // Another sign-in (often the Codex CLI's) holds the preferred port; the
    // loopback redirect may use any port as long as scheme, host, and path match.
    port = await listen(server, 0)
  }
  return {
    redirectUri: `http://${CALLBACK_HOST}:${String(port)}${CALLBACK_PATH}`,
    result: settled.promise,
    close: () => {
      server.close()
      // A browser keeps spare connections open; without this a later attempt's
      // callback could be answered by this closed attempt.
      server.closeAllConnections()
    },
  }
}

interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly id_token?: unknown
  readonly expires_in?: unknown
  readonly scope?: unknown
  readonly error?: unknown
  readonly error_description?: unknown
}

/** Token-endpoint errors meaning the issued client can no longer be used for this account. */
const CLIENT_GONE_ERRORS: ReadonlySet<string> = new Set(['invalid_client', 'unauthorized_client'])

async function postForm(
  fetcher: typeof fetch,
  url: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<{ status: number; json: TokenResponse | undefined; text: string }> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal,
  })
  const text = await response.text()
  let json: TokenResponse | undefined
  try {
    const parsed: unknown = text.length === 0 ? undefined : JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed
  } catch {
    // A non-JSON body (an HTML error page) is reported by status alone below.
  }
  return { status: response.status, json, text }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function oauthErrorCode(json: TokenResponse | undefined): string | undefined {
  return stringField(json?.error)
}

function decodeSegment(segment: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Reported below with the segment name.
  }
  throw new ChatGptSignInError(`OpenAI returned an ID token with an unreadable ${label}`, 'CHATGPT_INVALID_ID_TOKEN')
}

/** Validated ID-token identity. */
export interface ChatGptIdentity {
  readonly subject: string
  readonly email?: string
}

/**
 * Verify an ID token's RS256 signature against OpenAI's published keys and
 * check issuer, audience, expiry, and nonce.
 * @param idToken - the compact JWT from the token response.
 * @param expected - the issued client id and the nonce sent with this attempt.
 * @param expected.clientId - the audience the token must name.
 * @param expected.nonce - the nonce this attempt sent.
 * @param deps - network and clock seams.
 * @param signal - cancels the key download.
 * @returns the account identity.
 * @throws {ChatGptSignInError} when any check fails.
 */
export async function validateIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  deps: Pick<ChatGptSignInDeps, 'fetch' | 'now'>,
  signal: AbortSignal,
): Promise<ChatGptIdentity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new ChatGptSignInError('OpenAI returned a malformed ID token', 'CHATGPT_INVALID_ID_TOKEN')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = decodeSegment(headerPart, 'header')
  const claims = decodeSegment(payloadPart, 'payload')
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new ChatGptSignInError('OpenAI returned an ID token with an unsupported signature', 'CHATGPT_INVALID_ID_TOKEN')
  }
  const fetcher = deps.fetch ?? fetch
  const response = await fetcher(JWKS_URL, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) {
    throw new ChatGptSignInError(`could not download OpenAI's signing keys (HTTP ${String(response.status)})`, 'CHATGPT_JWKS')
  }
  const jwks = await response.json() as { keys?: unknown }
  const key = Array.isArray(jwks.keys)
    ? (jwks.keys as Array<Record<string, unknown>>).find(entry => entry.kid === header.kid && entry.kty === 'RSA')
    : undefined
  if (key === undefined) {
    throw new ChatGptSignInError('the ID token is signed with a key OpenAI does not publish', 'CHATGPT_INVALID_ID_TOKEN')
  }
  const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' })
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    publicKey,
    Buffer.from(signaturePart, 'base64url'),
  )
  if (!valid) throw new ChatGptSignInError('the ID token signature is invalid', 'CHATGPT_INVALID_ID_TOKEN')
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000)
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const problems: string[] = []
  if (claims.iss !== ISSUER) problems.push('issuer')
  if (!audience.includes(expected.clientId)) problems.push('audience')
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) problems.push('expiry')
  if (claims.nonce !== expected.nonce) problems.push('nonce')
  const subject = stringField(claims.sub)
  if (subject === undefined) problems.push('subject')
  if (problems.length > 0 || subject === undefined) {
    throw new ChatGptSignInError(`the ID token failed validation (${problems.join(', ')})`, 'CHATGPT_INVALID_ID_TOKEN')
  }
  const email = stringField(claims.email)
  return { subject, ...email === undefined ? {} : { email } }
}

/**
 * The account's displayable model slugs, in server order.
 * @param accessToken - an access token authorized for ChatGPT plan usage.
 * @param deps - network seam.
 * @param signal - cancels the request.
 * @returns the slugs whose `visibility` is `list`.
 * @throws {ChatGptSignInError} when the catalog cannot be read.
 */
export async function listPlanModels(
  accessToken: string,
  deps: Pick<ChatGptSignInDeps, 'fetch'>,
  signal: AbortSignal,
): Promise<string[]> {
  const response = await (deps.fetch ?? fetch)(MODELS_URL, {
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    signal,
  })
  if (!response.ok) {
    throw new ChatGptSignInError(`could not read the models your ChatGPT plan offers (HTTP ${String(response.status)})`, 'CHATGPT_MODELS')
  }
  const body = await response.json() as { models?: unknown }
  if (!Array.isArray(body.models)) return []
  return (body.models as Array<Record<string, unknown>>)
    .filter(model => model.visibility === 'list' && typeof model.slug === 'string')
    .map(model => model.slug as string)
}

/**
 * Run one Sign in with ChatGPT attempt and return the credential to store for
 * the `openai` route. A new host registers with `dynamic_agent_client` and this
 * app's name; a host with an issued client id signs in again with it. The
 * retained registration is written before the browser opens (host id) and
 * after a validated sign-in (client id, identity, plan models).
 * @param interaction - pi-ai's login interaction: the authorization URL is reported through `notify`.
 * @param deps - registration store and network seams.
 * @returns the OAuth credential pi-ai stores and refreshes.
 * @throws {ChatGptSignInError} when the user declines plan usage, the callback or tokens fail validation, or the exchange fails.
 */
export async function signInWithChatGpt(
  interaction: ProviderAuthInteraction,
  deps: ChatGptSignInDeps,
): Promise<OAuthCredential> {
  const signal = interaction.signal
  const fetcher = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  let registration = await deps.registration.read()
  if (registration === undefined) {
    // The host id is persisted before the first sign-in so every later attempt
    // from this host presents the same one.
    registration = { hostId: newHostId() }
    await deps.registration.write(registration)
  }
  const issuedClientId = registration.clientId
  const { verifier, challenge } = pkce()
  const state = randomValue()
  const nonce = randomValue()
  const callback = await startCallback(deps.preferredPort ?? PREFERRED_CALLBACK_PORT)
  try {
    const query: Record<string, string> = {
      client_id: issuedClientId ?? DYNAMIC_CLIENT_ID,
      ...issuedClientId === undefined ? { agent_name_hint: CHATGPT_APP_NAME } : {},
      ext_agent_host_id: registration.hostId,
      ...issuedClientId !== undefined && registration.email !== undefined ? { login_hint: registration.email } : {},
      response_type: 'code',
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }
    interaction.notify({
      type: 'auth_url',
      url: `${AUTHORIZE_URL}?${new URLSearchParams(query).toString()}`,
      instructions: 'Continue in your browser: sign in to ChatGPT and allow DeepSeek Harness to use your ChatGPT plan.',
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => { reject(new ChatGptSignInError('sign-in cancelled', 'ABORTED')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    void aborted.catch(() => {})
    const { params } = await Promise.race([callback.result, aborted])
    if (params.get('state') !== state) {
      throw new ChatGptSignInError('the browser returned a response for a different sign-in attempt; try again', 'CHATGPT_STATE')
    }
    const oauthError = params.get('error')
    if (oauthError !== null) {
      if (oauthError === 'access_denied') {
        throw new ChatGptSignInError(
          'permission to use your ChatGPT plan was not granted; sign in again and allow "Use your ChatGPT plan", or use an OpenAI API key instead',
          'CHATGPT_PLAN_NOT_ENABLED',
        )
      }
      if (issuedClientId !== undefined && CLIENT_GONE_ERRORS.has(oauthError)) {
        await deps.registration.write({ hostId: registration.hostId })
        throw new ChatGptSignInError('this app\'s ChatGPT registration is no longer valid; sign in again to register it anew', 'CHATGPT_CLIENT_GONE')
      }
      throw new ChatGptSignInError(`OpenAI refused the sign-in (${oauthError})`, 'CHATGPT_AUTHORIZE')
    }
    const code = params.get('code')
    if (code === null || code.length === 0) throw new ChatGptSignInError('the browser returned no authorization code', 'CHATGPT_AUTHORIZE')
    const returnedClientId = params.get('client_id')?.trim()
    let clientId: string
    if (issuedClientId === undefined) {
      if (returnedClientId === undefined || returnedClientId.length === 0 || returnedClientId === DYNAMIC_CLIENT_ID) {
        throw new ChatGptSignInError('OpenAI did not finish registering this app; try again', 'CHATGPT_REGISTRATION')
      }
      clientId = returnedClientId
    } else {
      if (returnedClientId !== undefined && returnedClientId.length > 0 && returnedClientId !== issuedClientId) {
        throw new ChatGptSignInError('the browser returned a different app registration than the one signing in', 'CHATGPT_REGISTRATION')
      }
      clientId = issuedClientId
    }

    const exchanged = await postForm(fetcher, TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
      resource: RESOURCE,
    }, signal)
    if (exchanged.status !== 200 || exchanged.json === undefined) {
      const errorCode = oauthErrorCode(exchanged.json)
      if (issuedClientId !== undefined && errorCode !== undefined && CLIENT_GONE_ERRORS.has(errorCode)) {
        await deps.registration.write({ hostId: registration.hostId })
        throw new ChatGptSignInError('this app\'s ChatGPT registration is no longer valid; sign in again to register it anew', 'CHATGPT_CLIENT_GONE')
      }
      throw new ChatGptSignInError(
        `the token exchange failed (HTTP ${String(exchanged.status)}${errorCode === undefined ? '' : `, ${errorCode}`}); try again`,
        'CHATGPT_TOKEN',
      )
    }
    const token = exchanged.json
    const access = stringField(token.access_token)
    const refresh = stringField(token.refresh_token)
    const idToken = stringField(token.id_token)
    const scope = stringField(token.scope)
    const expiresIn = token.expires_in
    if (access === undefined || refresh === undefined || idToken === undefined || scope === undefined
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ChatGptSignInError('OpenAI returned an incomplete token response', 'CHATGPT_TOKEN')
    }
    const identity = await validateIdToken(idToken, { clientId, nonce }, { fetch: fetcher, now }, signal)
    if (issuedClientId !== undefined && registration.subject !== undefined && registration.subject !== identity.subject) {
      throw new ChatGptSignInError('you signed in to a different ChatGPT account than the one this app is registered with', 'CHATGPT_ACCOUNT_MISMATCH')
    }
    const scopes = scope.split(/\s+/).filter(entry => entry.length > 0)
    // The registration exists even when plan usage was not granted, so it is
    // kept before the scope check and a later sign-in reuses the client.
    const kept: ChatGptRegistration = {
      hostId: registration.hostId,
      clientId,
      subject: identity.subject,
      ...identity.email === undefined ? {} : { email: identity.email },
      ...registration.planModels === undefined ? {} : { planModels: registration.planModels },
    }
    await deps.registration.write(kept)
    if (!scopes.includes(DIRECT_SCOPE)) {
      throw new ChatGptSignInError(
        'permission to use your ChatGPT plan was not granted; sign in again and allow "Use your ChatGPT plan", or use an OpenAI API key instead',
        'CHATGPT_PLAN_NOT_ENABLED',
      )
    }
    try {
      const planModels = await listPlanModels(access, { fetch: fetcher }, signal)
      await deps.registration.write({ ...kept, planModels })
    } catch (error: unknown) {
      // The model list only narrows the picker; the sign-in itself succeeded.
      if (signal.aborted) throw error
    }
    return {
      type: 'oauth',
      access,
      refresh,
      expires: now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
      clientId,
      scopes,
    }
  } finally {
    callback.close()
  }
}

/** How a sign-out ended at OpenAI. */
export type ChatGptRevocation = 'revoked' | 'unconfirmed'

/**
 * End the renewable session at OpenAI. Network failures and server errors are
 * retried with a short backoff; the caller clears the local tokens either way.
 * @param credential - the stored credential whose refresh token is revoked.
 * @param deps - network seam and the backoff schedule in milliseconds.
 * @param deps.fetch - the fetch implementation.
 * @param deps.backoffMs - waits before each retry.
 * @param signal - cancels the attempt.
 * @returns `revoked` on HTTP 200, otherwise `unconfirmed`.
 */
export async function revokeChatGptSession(
  credential: { readonly refresh: string; readonly clientId?: unknown },
  deps: { readonly fetch?: typeof fetch; readonly backoffMs?: readonly number[] },
  signal: AbortSignal,
): Promise<ChatGptRevocation> {
  const clientId = typeof credential.clientId === 'string' ? credential.clientId : undefined
  if (clientId === undefined) return 'unconfirmed'
  const waits = deps.backoffMs ?? [500, 2_000]
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    try {
      const response = await postForm(deps.fetch ?? fetch, REVOKE_URL, {
        token: credential.refresh,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }, signal)
      if (response.status === 200) return 'revoked'
      if (response.status < 500) return 'unconfirmed'
    } catch {
      if (signal.aborted) return 'unconfirmed'
      // A network failure is retried like a server error.
    }
    const wait = waits[attempt]
    if (wait === undefined) break
    await new Promise<void>((resolve) => { setTimeout(resolve, wait) })
  }
  return 'unconfirmed'
}

/**
 * Whether a stored pi-ai credential is a Sign in with ChatGPT grant this module produced.
 * @param credential - the stored credential, if any.
 * @returns true for an OAuth credential carrying an issued client id.
 */
export function isChatGptCredential(credential: unknown): credential is OAuthCredential & { clientId: string } {
  if (credential === null || typeof credential !== 'object') return false
  const value = credential as Record<string, unknown>
  return value.type === 'oauth' && typeof value.clientId === 'string' && typeof value.refresh === 'string'
}
