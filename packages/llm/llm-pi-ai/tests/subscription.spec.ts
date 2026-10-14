import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import {
  assertNotSubscriptionCredential, ignoredSubscriptionMessage, isAnthropicSubscriptionToken, isSubscriptionCredential,
} from '../src/subscription.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

/** A syntactically valid stand-in for a Claude Pro/Max OAuth access token. */
const CLAUDE_OAUTH_TOKEN = 'sk-ant-oat01-FIXTURE-ACCESS-TOKEN'
/** A stand-in for a ChatGPT access token a user copied out of their Codex sign-in. */
const CHATGPT_TOKEN = 'e30.eyJmaXh0dXJlIjoxfQ.FIXTURE-CHATGPT-TOKEN'

const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A context whose credential records live in a throwaway `$DSH_HOME`. */
async function stored(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-subscription-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  return ctx
}

/** Capture every warning the context's logger emits. */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
  return warnings
}

describe('subscription credential detection', () => {
  it('recognises an Anthropic subscription token wherever pi-ai would, and nothing else', () => {
    expect(isAnthropicSubscriptionToken(CLAUDE_OAUTH_TOKEN)).toBe(true)
    // pi-ai tests with `includes`, so a prefixed value is treated the same way.
    expect(isAnthropicSubscriptionToken(`Bearer ${CLAUDE_OAUTH_TOKEN}`)).toBe(true)
    expect(isAnthropicSubscriptionToken('sk-ant-api03-ordinary-console-key')).toBe(false)
    expect(isAnthropicSubscriptionToken('sk-proj-openai-platform-key')).toBe(false)
  })

  it('treats a withheld provider\'s OAuth grant, and only that, as a subscription credential', () => {
    const grant = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 1 }
    expect(isSubscriptionCredential('anthropic', grant)).toBe(true)
    expect(isSubscriptionCredential('openai-codex', grant)).toBe(true)
    // An OAuth grant that is not a consumer-subscription login stays usable.
    expect(isSubscriptionCredential('openrouter', grant)).toBe(false)
    expect(isSubscriptionCredential('anthropic', { type: 'api_key', key: 'sk-ant-api03-ordinary' })).toBe(false)
    expect(isSubscriptionCredential('anthropic', { type: 'api_key', key: CLAUDE_OAUTH_TOKEN })).toBe(true)
    expect(isSubscriptionCredential('anthropic', { type: 'api_key' })).toBe(false)
  })
})

describe('explicit credential refusal', () => {
  it('accepts an ordinary API key on a Messages route', () => {
    expect(() => { assertNotSubscriptionCredential('anthropic', ['anthropic-messages'], 'ANTHROPIC_API_KEY', 'sk-ant-api03-ordinary') })
      .not.toThrow()
  })

  it('refuses a Claude subscription token with a stable code and without echoing it', () => {
    let failure: unknown
    try {
      assertNotSubscriptionCredential('anthropic', ['anthropic-messages'], 'MY_CLAUDE_TOKEN', CLAUDE_OAUTH_TOKEN)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('INVALID_CREDENTIAL')
    const message = (failure as LlmError).message
    expect(message).toContain('MY_CLAUDE_TOKEN')
    expect(message).toContain('Claude Code')
    expect(message).not.toContain(CLAUDE_OAUTH_TOKEN)
  })

  it('refuses any credential on a route that speaks the ChatGPT-backend protocol', () => {
    let failure: unknown
    try {
      assertNotSubscriptionCredential('openai-codex', ['openai-codex-responses'], 'CODEX_TOKEN', CHATGPT_TOKEN)
    } catch (error) {
      failure = error
    }
    expect((failure as LlmError).code).toBe('INVALID_CREDENTIAL')
    expect((failure as LlmError).message).toContain('Codex subagent')
    expect((failure as LlmError).message).not.toContain(CHATGPT_TOKEN)
  })
})

describe('stored credentials', () => {
  it('reports a stored subscription grant as absent, warns once, and leaves the record alone', async () => {
    const ctx = await stored()
    const warnings = captureWarnings(ctx)
    const store = credentialStoreFrom(ctx)
    const granted = { type: 'oauth' as const, access: CLAUDE_OAUTH_TOKEN, refresh: 'rt', expires: 1 }
    await store.modify('anthropic', () => Promise.resolve(granted))

    await expect(store.read('anthropic')).resolves.toBeUndefined()
    await expect(store.read('anthropic')).resolves.toBeUndefined()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('stored sign-in for "anthropic"')
    expect(warnings.join('\n')).not.toContain(CLAUDE_OAUTH_TOKEN)
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic'))).resolves.toMatchObject({ kind: 'grant' })
  })

  it('hides a subscription token stored as an API key but keeps an ordinary key', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    await store.modify('anthropic', () => Promise.resolve({ type: 'api_key', key: CLAUDE_OAUTH_TOKEN }))
    await expect(store.read('anthropic')).resolves.toBeUndefined()

    await store.modify('anthropic', () => Promise.resolve({ type: 'api_key', key: 'sk-ant-api03-ordinary' }))
    await expect(store.read('anthropic')).resolves.toEqual({ type: 'api_key', key: 'sk-ant-api03-ordinary' })
  })

  it('keeps serving an OAuth grant for a provider that is not a consumer subscription', async () => {
    const store = credentialStoreFrom(await stored())
    const granted = { type: 'oauth' as const, access: 'at', refresh: 'rt', expires: 1 }
    await store.modify('openrouter', () => Promise.resolve(granted))

    await expect(store.read('openrouter')).resolves.toEqual(granted)
  })

  it('omits withheld subscription grants from the listing', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('anthropic', () => Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))
    await store.modify('openai-codex', () => Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))
    await store.modify('openrouter', () => Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))

    await expect(store.list()).resolves.toEqual([{ providerId: 'openrouter', type: 'oauth' }])
  })
})

describe('ambient credentials', () => {
  it('answers a subscription token in any variable as not set, naming the variable but never the value', async () => {
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', CLAUDE_OAUTH_TOKEN)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-ordinary')
    const ctx = await stored()
    const warnings = captureWarnings(ctx)
    const context = authContextFrom(ctx)

    await expect(context.env('ANTHROPIC_OAUTH_TOKEN')).resolves.toBeUndefined()
    await expect(context.env('ANTHROPIC_OAUTH_TOKEN')).resolves.toBeUndefined()
    await expect(context.env('ANTHROPIC_API_KEY')).resolves.toBe('sk-ant-api03-ordinary')

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('environment variable ANTHROPIC_OAUTH_TOKEN')
    expect(warnings[0]).not.toContain(CLAUDE_OAUTH_TOKEN)
  })

  it('answers a subscription token held in the credential service as not set', async () => {
    const ctx = await stored()
    await ctx.credentials.set('CLAUDE_FROM_STORE' as never, CLAUDE_OAUTH_TOKEN)
    captureWarnings(ctx)

    await expect(authContextFrom(ctx).env('CLAUDE_FROM_STORE')).resolves.toBeUndefined()
  })

  it('names its source in the warning', () => {
    expect(ignoredSubscriptionMessage('environment variable X')).toContain('(environment variable X)')
  })
})

describe('a real llm-pi-ai composition', () => {
  async function compose(providers: NonNullable<LlmPiAi.Options['providers']>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers })
    return ctx
  }

  it('registers the API-key routes with clear names and lists their models for the model picker', async () => {
    vi.stubEnv('PI_ANTHROPIC_KEY', 'sk-ant-api03-ordinary')
    vi.stubEnv('PI_OPENAI_KEY', 'sk-proj-ordinary')
    const ctx = await compose({
      anthropic: { apiKeyEnv: 'PI_ANTHROPIC_KEY', displayName: 'Anthropic (API key)' },
      openai: { apiKeyEnv: 'PI_OPENAI_KEY', displayName: 'OpenAI (API key)' },
    })

    expect(ctx.llm.listProviders()).toEqual(expect.arrayContaining([
      { id: 'anthropic', name: 'Anthropic (API key)' },
      { id: 'openai', name: 'OpenAI (API key)' },
    ]))
    const claude = await ctx.llm.listModels('anthropic')
    expect(claude.map(model => model.id)).toContain('claude-opus-4-8')
    await expect(ctx.llm.resolveModelInfo('anthropic', 'claude-opus-4-8'))
      .resolves.toMatchObject({ provider: 'anthropic', id: 'claude-opus-4-8' })
    expect((await ctx.llm.listModels('openai')).length).toBeGreaterThan(0)
    // A subscription-only route is not registered by default, so it never reaches the picker.
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('openai-codex')
  })

  it('sends an ordinary Anthropic API key as an API key, without presenting itself as Claude Code', async () => {
    vi.stubEnv('PI_SUBSCRIPTION_KEY', 'sk-ant-api03-ordinary')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await compose({ anthropic: { apiKeyEnv: 'PI_SUBSCRIPTION_KEY', baseURL: server.url } })

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-opus-4-8', maxTokens: 16, messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.['x-api-key']).toBe('sk-ant-api03-ordinary')
    expect(String(server.headers[0]?.['user-agent'])).not.toContain('claude-cli')
    expect(server.headers[0]?.['x-app']).toBeUndefined()
    expect(JSON.stringify(server.requests[0])).not.toContain('You are Claude Code')
  })

  it('refuses a Claude subscription token named by apiKeyEnv before any request leaves', async () => {
    vi.stubEnv('PI_SUBSCRIPTION_KEY', CLAUDE_OAUTH_TOKEN)
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await compose({ anthropic: { apiKeyEnv: 'PI_SUBSCRIPTION_KEY', baseURL: server.url } })

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-opus-4-8', maxTokens: 16, messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    expect(JSON.stringify(result.finish)).not.toContain(CLAUDE_OAUTH_TOKEN)
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a ChatGPT token named by apiKeyEnv on the Codex route before any request leaves', async () => {
    vi.stubEnv('PI_SUBSCRIPTION_KEY', CHATGPT_TOKEN)
    const server = await mockServer([{ status: 500, body: '{}' }])
    const ctx = await compose({ 'openai-codex': { apiKeyEnv: 'PI_SUBSCRIPTION_KEY', baseURL: server.url, transport: 'sse' } })

    const result = await assemble(ctx, { provider: 'openai-codex', model: 'gpt-5.5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    expect(JSON.stringify(result.finish)).not.toContain(CHATGPT_TOKEN)
    expect(server.requests).toHaveLength(0)
  })

  it('does not fall back to an ambient subscription token when the profile names no credential', async () => {
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', CLAUDE_OAUTH_TOKEN)
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await compose({ anthropic: { baseURL: server.url } })

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-opus-4-8', maxTokens: 16, messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error' })
    expect(server.requests).toHaveLength(0)
  })
})
