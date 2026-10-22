/** Profile patch edits and credential updates reach the next real adapter request. */

import { generateKeyPairSync, sign as signData } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createMessage, createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** One text block, then a tool call truncated by the output-token ceiling. */
const truncatedToolCallEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"partial"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
  '[DONE]',
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Boot the dormant composition: a bare `llm-pi-ai` row with no config at all. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath: patchPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('offers OpenAI Sign in with ChatGPT, Claude sign-in by API key only, and no Codex sign-in', async () => {
    const { ctx } = await loadComposition()
    const methods = (provider: string): string[] | undefined => ctx.authorization.list()
      .find(entry => entry.key === LlmPiAi.recordKeyFor(provider))?.methods.map(method => method.id)

    // OpenAI's Sign in with ChatGPT for open-source apps runs under this app's
    // own registration, beside the key login.
    expect(methods('openai')).toEqual(['oauth', 'api-key'])
    // Claude Pro/Max and ChatGPT Codex sign-ins authorize the vendors' own
    // clients; a third-party application may not collect them.
    expect(methods('anthropic')).toEqual(['api-key'])
    expect(methods('openai-codex')).toBeUndefined()
  })

  it('signs in with ChatGPT through the real authorization flow and stores a grant pi-ai can use', async () => {
    const { ctx } = await loadComposition()
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    let nonce = ''
    const realFetch = globalThis.fetch
    const tokenForms: URLSearchParams[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.startsWith('http://127.0.0.1')) return await realFetch(input, init)
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        tokenForms.push(init?.body instanceof URLSearchParams ? init.body : new URLSearchParams())
        const claims = { iss: 'https://auth.openai.com', aud: 'oaiapp_flow', sub: 'subject-1', email: 'me@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 600 }
        const input = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode(claims)}`
        const idToken = `${input}.${signData('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
        return Response.json({
          access_token: 'flow-access', refresh_token: 'flow-refresh', id_token: idToken, token_type: 'Bearer', expires_in: 3600,
          scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
        })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] })
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] })
      throw new Error(`unexpected request ${url}`)
    })
    const callbacks: Promise<Response>[] = []
    const outcome = await ctx.authorization.begin({
      key: LlmPiAi.recordKeyFor('openai'),
      method: 'oauth',
      interaction: {
        notify: (notice) => {
          if (notice.url === undefined) return
          const authorize = new URL(notice.url)
          nonce = authorize.searchParams.get('nonce') ?? ''
          const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '')
          callback.searchParams.set('code', 'flow-code')
          callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
          callback.searchParams.set('client_id', 'oaiapp_flow')
          callbacks.push(realFetch(callback))
        },
        prompt: () => Promise.reject(new Error('the flow asked a question')),
      },
    })

    expect(outcome).toEqual({ status: 'authorized' })
    expect((await Promise.all(callbacks)).map(response => response.status)).toEqual([200])
    expect(tokenForms[0]?.get('client_id')).toBe('oaiapp_flow')
    const stored = await ctx.credentials.readRecord(LlmPiAi.recordKeyFor('openai'))
    expect(stored).toMatchObject({ kind: 'grant', payload: { type: 'oauth', access: 'flow-access', refresh: 'flow-refresh', clientId: 'oaiapp_flow' } })
    const registration = await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'openai-chatgpt-registration'))
    expect(registration).toMatchObject({
      kind: 'grant',
      payload: { clientId: 'oaiapp_flow', subject: 'subject-1', email: 'me@example.com', planModels: ['gpt-6.1-sol'] },
    })
  })

  it('serves the openai route from a stored Sign in with ChatGPT grant, narrowed to the plan models', async () => {
    const { ctx, settingsPath } = await loadComposition()
    // A completed sign-in leaves the grant and this host's registration behind.
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('openai'), () => Promise.resolve({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: 'chatgpt-access',
        refresh: 'chatgpt-refresh',
        expires: Date.now() + 3_600_000,
        clientId: 'oaiapp_test',
        scopes: ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
      },
    }))
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-chatgpt-registration'), () => Promise.resolve({
      kind: 'grant',
      payload: { hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555', clientId: 'oaiapp_test', planModels: ['gpt-6.1-sol', 'gpt-6-luna'] },
    }))
    const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      return request.json().then((body: Record<string, unknown>) => {
        requests.push({ url: request.url, authorization: request.headers.get('authorization'), body })
        const sse = completedResponseEvents('plan answer').map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      })
    })

    // Adding the route without an API key is what the Models page's ChatGPT card writes.
    await writeFile(settingsPath, ['- id: llm-pi-ai', '  config:', '    providers:', '      openai: {}', ''].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    }, { timeout: 5000 })

    expect((await ctx.llm.listModels('openai')).map(model => model.id)).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
    const result = await assemble(ctx, {
      provider: 'openai',
      model: 'gpt-6.1-sol',
      maxTokens: 1000,
      temperature: 0.5,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'plan answer' }])
    const [request] = requests
    expect(request?.url).toBe('https://api.openai.com/v1/responses')
    expect(request?.authorization).toBe('Bearer chatgpt-access')
    // The plan route rejects these fields, so a ChatGPT credential never sends them.
    expect(request?.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true })
    expect(request?.body).not.toHaveProperty('max_output_tokens')
    expect(request?.body).not.toHaveProperty('temperature')
  })

  it('uses settings-only route headers for model discovery', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'acme-private' }] }) }])
    const { ctx, settingsPath } = await loadComposition()

    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acme-gateway:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      '        api: openai-completions',
      `        baseURL: ${server.url}`,
      '        headers:',
      '          X-Company-Code: private-tenant',
      '          Accept: text/plain',
      '          User-Agent: deployment-owned',
      '        models:',
      '          - id: acme-bootstrap',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    }, { timeout: 5000 })

    await expect(ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: server.url,
      api: 'openai-completions',
    })).resolves.toEqual([{ id: 'acme-private', name: 'acme-private' }])
    expect(server.paths).toEqual(['/models'])
    expect(server.headers[0]?.['x-company-code']).toBe('private-tenant')
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
    expect(server.headers[0]?.accept).toBe('application/json')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('continues natively after max-token assembly drops a tool call, with pruned replay metadata', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([
      { events: truncatedToolCallEvents },
      { events: textEvents },
    ])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const truncated = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [],
    })
    expect(truncated.finish).toEqual({ kind: 'max-tokens' })
    expect(truncated.message.content).toEqual([{ type: 'text', text: 'partial' }])
    expect(truncated.message.source).toEqual({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-flash',
      replayState: {
        response: {
          kind: 'pi-ai',
          version: 2,
          api: 'openai-completions',
          provider: 'deepseek',
          model: 'deepseek-flash',
          stopReason: 'length',
        },
        blocks: [{ type: 'text' }],
      },
    })

    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        truncated.message,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
    const followup = server.requests[1] as { messages?: unknown[] }
    expect(followup.messages?.[0]).not.toHaveProperty('tool_calls')
  })

  it('continues a legacy session whose stored replay state no longer matches its content', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()
    await writeFile(settingsPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      deepseek:',
      '        apiKeyEnv: PI_COMPOSITION_KEY',
      `        baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    // A pre-envelope session log entry: max-token assembly dropped the tool
    // call from content while the flat v1 state still describes both blocks.
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: 'deepseek',
          model: 'deepseek-flash',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-flash',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const continued = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-flash',
      messages: [
        poisoned,
        createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
      ],
    })
    expect(continued.finish).toEqual({ kind: 'stop' })
    expect(continued.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue' },
      ],
    })
  })
})

/** The Responses stream of one completed text answer. */
function completedResponseEvents(text: string): Record<string, unknown>[] {
  const part = { type: 'output_text', annotations: [], logprobs: [], text }
  const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [part] }
  const response = {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [message],
    usage: {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7,
    },
  }
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text, logprobs: [] },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]
}
