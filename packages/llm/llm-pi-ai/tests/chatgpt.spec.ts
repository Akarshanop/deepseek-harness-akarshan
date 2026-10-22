import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthEvent, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import {
  CHATGPT_APP_NAME,
  isChatGptCredential,
  listPlanModels,
  revokeChatGptSession,
  signInWithChatGpt,
  validateIdToken,
  type ChatGptRegistration,
  type ChatGptRegistrationStore,
} from '../src/chatgpt.ts'

const NOW = Date.UTC(2026, 9, 18, 2, 0, 0)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-key'
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] }

/** A compact RS256 JWT over the given claims. */
function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = KID): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(claims)}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
}

function idClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://auth.openai.com',
    aud: 'oaiapp_issued',
    sub: 'user-subject',
    email: 'user@example.com',
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  }
}

function memoryRegistration(initial?: ChatGptRegistration): ChatGptRegistrationStore & { writes: ChatGptRegistration[] } {
  let current = initial
  const writes: ChatGptRegistration[] = []
  return {
    writes,
    read: () => Promise.resolve(current),
    write: (next) => {
      current = next
      writes.push(next)
      return Promise.resolve()
    },
  }
}

interface FakeOpenAI {
  readonly fetch: typeof fetch
  readonly tokenForms: URLSearchParams[]
  readonly revokeForms: URLSearchParams[]
  readonly modelAuth: (string | null)[]
}

/**
 * OpenAI's token, key, model, and revocation endpoints. `nonce` is read from
 * the authorization URL the flow reports, so the ID token answers that attempt.
 */
function fakeOpenAI(options: {
  readonly nonce: () => string
  readonly scope?: string
  readonly idToken?: (nonce: string) => string
  readonly tokenStatus?: number
  readonly tokenBody?: object
  readonly revokeStatuses?: number[]
  readonly models?: object
}): FakeOpenAI {
  const tokenForms: URLSearchParams[] = []
  const revokeForms: URLSearchParams[] = []
  const modelAuth: (string | null)[] = []
  const revokeStatuses = [...options.revokeStatuses ?? [200]]
  const form = (init?: RequestInit): URLSearchParams => init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()
  const fake: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      tokenForms.push(form(init))
      const body = options.tokenBody ?? {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        id_token: (options.idToken ?? (nonce => jwt(idClaims({ nonce }))))(options.nonce()),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: options.scope ?? 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      }
      return new Response(JSON.stringify(body), { status: options.tokenStatus ?? 200 })
    }
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json(JWKS)
    if (url === 'https://api.openai.com/v1/models') {
      modelAuth.push(new Headers(init?.headers).get('authorization'))
      return Response.json(options.models ?? {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
        ],
      })
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      revokeForms.push(form(init))
      return new Response('', { status: revokeStatuses.shift() ?? 200 })
    }
    throw new Error(`unexpected request ${url}`)
  }
  return { fetch: fake, tokenForms, revokeForms, modelAuth }
}

/**
 * A login interaction that plays the browser: once the flow reports its
 * authorization URL, it requests the loopback callback with `answer`.
 */
function browser(answer: (authorize: URL) => Record<string, string> | undefined, signal = new AbortController().signal): {
  readonly interaction: ProviderAuthInteraction
  readonly authorize: () => URL
  readonly callbackPage: () => Promise<Response | undefined>
} {
  let authorizeUrl: URL | undefined
  let page: Promise<Response | undefined> = Promise.resolve(undefined)
  return {
    authorize: () => authorizeUrl as URL,
    callbackPage: () => page,
    interaction: {
      signal,
      prompt: () => Promise.reject(new Error('the flow asked a question')),
      notify: (event: AuthEvent) => {
        if (event.type !== 'auth_url') return
        authorizeUrl = new URL(event.url)
        const params = answer(authorizeUrl)
        if (params === undefined) return
        const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri') as string)
        for (const [name, value] of Object.entries(params)) redirect.searchParams.set(name, value)
        page = fetch(redirect)
      },
    },
  }
}

/** The browser's answer to an approved consent; `null` omits the client id, as a returning sign-in may. */
const approve = (clientId: string | null = 'oaiapp_issued') => (authorize: URL): Record<string, string> => ({
  code: 'auth-code',
  state: authorize.searchParams.get('state') as string,
  scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
  ...clientId === null ? {} : { client_id: clientId },
})

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => { server.close(resolve) })))
})

describe('Sign in with ChatGPT', () => {
  it('registers a new host under this app\'s own name and returns a plan credential', async () => {
    const registration = memoryRegistration()
    const page = browser(approve())
    const openai = fakeOpenAI({ nonce: () => page.authorize().searchParams.get('nonce') as string })

    const credential = await signInWithChatGpt(page.interaction, { registration, fetch: openai.fetch, now: () => NOW, preferredPort: 0 })

    const authorize = page.authorize()
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize')
    const query = Object.fromEntries(authorize.searchParams)
    expect(query).toMatchObject({
      client_id: 'dynamic_agent_client',
      agent_name_hint: CHATGPT_APP_NAME,
      response_type: 'code',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
    })
    expect(CHATGPT_APP_NAME).toBe('DeepSeek Harness')
    expect(query.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(query.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(query).not.toHaveProperty('login_hint')
    // The host id is stored before the browser opens, then the registration after validation.
    expect(registration.writes[0]).toEqual({ hostId: query.ext_agent_host_id })

    const [form] = openai.tokenForms
    expect(Object.fromEntries(form as URLSearchParams)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'oaiapp_issued',
      code: 'auth-code',
      redirect_uri: query.redirect_uri,
      resource: 'https://api.openai.com/v1',
    })
    const verifier = form?.get('code_verifier') as string
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(query.code_challenge)

    expect(credential).toEqual({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: NOW + 3600_000 - 180_000,
      clientId: 'oaiapp_issued',
      scopes: ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
    })
    expect(isChatGptCredential(credential)).toBe(true)
    expect(openai.modelAuth).toEqual(['Bearer access-1'])
    expect(await registration.read()).toEqual({
      hostId: query.ext_agent_host_id,
      clientId: 'oaiapp_issued',
      subject: 'user-subject',
      email: 'user@example.com',
      planModels: ['gpt-6.1-sol', 'gpt-6-luna'],
    })
    const done = await page.callbackPage()
    expect(done?.status).toBe(200)
    expect(await done?.text()).toContain('Signed in with ChatGPT')
  })

  it('signs a registered host in again with its issued client id and the same host id', async () => {
    const registration = memoryRegistration({
      hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555',
      clientId: 'oaiapp_issued',
      subject: 'user-subject',
      email: 'user@example.com',
    })
    // A returning sign-in may omit the client id from the callback.
    const page = browser(approve(null))
    const openai = fakeOpenAI({ nonce: () => page.authorize().searchParams.get('nonce') as string })

    await signInWithChatGpt(page.interaction, { registration, fetch: openai.fetch, now: () => NOW, preferredPort: 0 })

    const query = Object.fromEntries(page.authorize().searchParams)
    expect(query.client_id).toBe('oaiapp_issued')
    expect(query.ext_agent_host_id).toBe('urn:uuid:11111111-2222-4333-8444-555555555555')
    expect(query.login_hint).toBe('user@example.com')
    expect(query).not.toHaveProperty('agent_name_hint')
    expect(openai.tokenForms[0]?.get('client_id')).toBe('oaiapp_issued')
  })

  it('refuses a callback that answers another attempt', async () => {
    const page = browser(authorize => ({ ...approve()(authorize), state: 'someone-else' }))
    const openai = fakeOpenAI({ nonce: () => 'unused' })

    await expect(signInWithChatGpt(page.interaction, { registration: memoryRegistration(), fetch: openai.fetch, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_STATE' })
    expect(openai.tokenForms).toEqual([])
  })

  it('reports a declined plan permission without exchanging a code', async () => {
    const page = browser(authorize => ({ error: 'access_denied', state: authorize.searchParams.get('state') as string }))
    const openai = fakeOpenAI({ nonce: () => 'unused' })

    await expect(signInWithChatGpt(page.interaction, { registration: memoryRegistration(), fetch: openai.fetch, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_PLAN_NOT_ENABLED' })
    expect(openai.tokenForms).toEqual([])
    expect((await page.callbackPage())?.status).toBe(400)
  })

  it('keeps the registration but refuses a grant without ChatGPT plan permission', async () => {
    const registration = memoryRegistration()
    const page = browser(approve())
    const openai = fakeOpenAI({
      nonce: () => page.authorize().searchParams.get('nonce') as string,
      scope: 'email offline_access openid profile',
    })

    await expect(signInWithChatGpt(page.interaction, { registration, fetch: openai.fetch, now: () => NOW, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_PLAN_NOT_ENABLED' })
    expect(await registration.read()).toMatchObject({ clientId: 'oaiapp_issued', subject: 'user-subject' })
  })

  it('refuses a new registration whose callback names no issued client id', async () => {
    const page = browser(approve(null))
    const openai = fakeOpenAI({ nonce: () => 'unused' })

    await expect(signInWithChatGpt(page.interaction, { registration: memoryRegistration(), fetch: openai.fetch, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_REGISTRATION' })
  })

  it('refuses an ID token minted for another attempt', async () => {
    const page = browser(approve())
    const openai = fakeOpenAI({ nonce: () => 'a-different-nonce' })

    const deps = { registration: memoryRegistration(), fetch: openai.fetch, now: () => NOW, preferredPort: 0 }
    await expect(signInWithChatGpt(page.interaction, deps)).rejects.toThrow(/nonce/)
  })

  it('refuses a returning sign-in to a different account', async () => {
    const registration = memoryRegistration({ hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555', clientId: 'oaiapp_issued', subject: 'someone-else' })
    const page = browser(approve())
    const openai = fakeOpenAI({ nonce: () => page.authorize().searchParams.get('nonce') as string })

    await expect(signInWithChatGpt(page.interaction, { registration, fetch: openai.fetch, now: () => NOW, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_ACCOUNT_MISMATCH' })
    expect(registration.writes).toEqual([])
  })

  it('forgets an issued client OpenAI no longer accepts so the next sign-in registers anew', async () => {
    const registration = memoryRegistration({ hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555', clientId: 'oaiapp_gone' })
    const page = browser(approve(null))
    const openai = fakeOpenAI({ nonce: () => 'unused', tokenStatus: 401, tokenBody: { error: 'invalid_client' } })

    await expect(signInWithChatGpt(page.interaction, { registration, fetch: openai.fetch, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'CHATGPT_CLIENT_GONE' })
    expect(await registration.read()).toEqual({ hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555' })
  })

  it('reports a failed token exchange by status and OAuth error code only', async () => {
    const page = browser(approve())
    const openai = fakeOpenAI({ nonce: () => 'unused', tokenStatus: 400, tokenBody: { error: 'invalid_grant', error_description: 'secret-looking detail' } })

    const failure = signInWithChatGpt(page.interaction, { registration: memoryRegistration(), fetch: openai.fetch, preferredPort: 0 })
    await expect(failure).rejects.toMatchObject({ code: 'CHATGPT_TOKEN' })
    await expect(failure).rejects.toThrow('HTTP 400, invalid_grant')
  })

  it('stops waiting and releases the callback port when cancelled', async () => {
    const controller = new AbortController()
    const page = browser(() => {
      queueMicrotask(() => { controller.abort() })
      return undefined
    }, controller.signal)

    await expect(signInWithChatGpt(page.interaction, { registration: memoryRegistration(), fetch: fakeOpenAI({ nonce: () => '' }).fetch, preferredPort: 0 }))
      .rejects.toMatchObject({ code: 'ABORTED' })
    const redirect = page.authorize().searchParams.get('redirect_uri') as string
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('falls back to another loopback port when the preferred one is taken', async () => {
    const busy = createServer()
    servers.push(busy)
    const port = await new Promise<number>((resolve) => {
      busy.listen(0, '127.0.0.1', () => { resolve((busy.address() as { port: number }).port) })
    })
    const page = browser(approve())
    const openai = fakeOpenAI({ nonce: () => page.authorize().searchParams.get('nonce') as string })

    const deps = { registration: memoryRegistration(), fetch: openai.fetch, now: () => NOW, preferredPort: port }
    await signInWithChatGpt(page.interaction, deps)

    const redirect = new URL(page.authorize().searchParams.get('redirect_uri') as string)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/auth/callback')
    expect(Number(redirect.port)).not.toBe(port)
  })
})

describe('ID token validation', () => {
  const fetchKeys: typeof fetch = () => Promise.resolve(Response.json(JWKS))
  const signal = new AbortController().signal

  it('accepts a token signed by a published key for this client and attempt', async () => {
    await expect(validateIdToken(jwt(idClaims({ nonce: 'n' })), { clientId: 'oaiapp_issued', nonce: 'n' }, { fetch: fetchKeys, now: () => NOW }, signal))
      .resolves.toEqual({ subject: 'user-subject', email: 'user@example.com' })
  })

  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'oaiapp_other' }],
    ['expiry', { exp: Math.floor(NOW / 1000) - 3600 }],
    ['subject', { sub: '' }],
  ])('rejects a token with a wrong %s', async (problem, claims) => {
    await expect(validateIdToken(jwt(idClaims({ nonce: 'n', ...claims })), { clientId: 'oaiapp_issued', nonce: 'n' }, { fetch: fetchKeys, now: () => NOW }, signal))
      .rejects.toThrow(problem)
  })

  it('rejects a token signed by an unpublished key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    await expect(validateIdToken(jwt(idClaims({ nonce: 'n' }), other), { clientId: 'oaiapp_issued', nonce: 'n' }, { fetch: fetchKeys, now: () => NOW }, signal))
      .rejects.toThrow('signature is invalid')
    await expect(validateIdToken(jwt(idClaims({ nonce: 'n' }), privateKey, 'unknown-kid'), { clientId: 'oaiapp_issued', nonce: 'n' }, { fetch: fetchKeys, now: () => NOW }, signal))
      .rejects.toThrow('key OpenAI does not publish')
  })
})

describe('plan models and sign-out', () => {
  const signal = new AbortController().signal

  it('lists the displayable models of the account', async () => {
    const openai = fakeOpenAI({ nonce: () => '' })
    await expect(listPlanModels('access-1', { fetch: openai.fetch }, signal)).resolves.toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
  })

  it('revokes the refresh token with the issued client id', async () => {
    const openai = fakeOpenAI({ nonce: () => '' })
    await expect(revokeChatGptSession({ refresh: 'refresh-1', clientId: 'oaiapp_issued' }, { fetch: openai.fetch }, signal))
      .resolves.toBe('revoked')
    expect(Object.fromEntries(openai.revokeForms[0] as URLSearchParams)).toEqual({
      token: 'refresh-1',
      token_type_hint: 'refresh_token',
      client_id: 'oaiapp_issued',
    })
  })

  it('retries a server error and reports a refusal as unconfirmed', async () => {
    const retried = fakeOpenAI({ nonce: () => '', revokeStatuses: [503, 200] })
    await expect(revokeChatGptSession({ refresh: 'r', clientId: 'c' }, { fetch: retried.fetch, backoffMs: [0] }, signal)).resolves.toBe('revoked')
    expect(retried.revokeForms).toHaveLength(2)
    const refused = fakeOpenAI({ nonce: () => '', revokeStatuses: [400] })
    await expect(revokeChatGptSession({ refresh: 'r', clientId: 'c' }, { fetch: refused.fetch, backoffMs: [0] }, signal)).resolves.toBe('unconfirmed')
    await expect(revokeChatGptSession({ refresh: 'r' }, { fetch: refused.fetch }, signal)).resolves.toBe('unconfirmed')
  })
})
