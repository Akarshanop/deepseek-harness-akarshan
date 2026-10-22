import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message, RequestMessage, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as claudePlan from '../src/llm.ts'
import { ClaudePlanAdapter, claudePlanEnv, type ClaudePlanAdapterOptions, type QueryFunction } from '../src/llm.ts'
import { ClaudeStreamTranslator, classifyFailure, planTurn, readReplay, tokenUsage } from '../src/llm-turn.ts'

const sdkQuery = vi.hoisted(() => vi.fn())

// The plugin entry starts the real SDK; tests that mount it see this scripted query instead.
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: sdkQuery,
}))

const ROUTE = 'claude-plan'
const SESSION = brandString<SessionId>('session-1')
const agent = {} as Agent

/** Build one SDK message from the fields a test cares about. */
function sdk(value: object): SDKMessage {
  return value as SDKMessage
}

const init = (apiKeySource = 'none'): SDKMessage => sdk({ type: 'system', subtype: 'init', apiKeySource, session_id: 'claude-1' })
const event = (value: object, parent: string | null = null): SDKMessage =>
  sdk({ type: 'stream_event', event: value, parent_tool_use_id: parent, session_id: 'claude-1' })
const success = (sessionId = 'claude-1'): SDKMessage => sdk({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: sessionId,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
})

/** One Claude turn that thinks, runs a tool, and answers. */
function answerTurn(text: string): SDKMessage[] {
  return [
    event({ type: 'message_start' }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'look.' } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Bash', id: 't1', input: {} } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' -la"}' } }),
    event({ type: 'content_block_stop', index: 1 }),
    event({ type: 'message_start' }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } }),
    event({ type: 'content_block_stop', index: 0 }),
    // A subagent's stream belongs to Claude Code's own bookkeeping, not this answer.
    event({ type: 'content_block_start', index: 5, content_block: { type: 'text', text: '' } }, 'sub-1'),
  ]
}

async function * stream(messages: readonly SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) yield message
}

interface Harness {
  readonly ctx: Context
  readonly calls: { prompt: string; options: Options }[]
  readonly approvals: string[]
}

async function harness(
  script: (call: number, options: Options) => AsyncIterable<SDKMessage>,
  overrides: Partial<ClaudePlanAdapterOptions> = {},
  config: Partial<ReturnType<ClaudePlanAdapterOptions['config']>> = {},
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const calls: Harness['calls'] = []
  const approvals: string[] = []
  const query: QueryFunction = (params) => {
    calls.push(params)
    return script(calls.length, params.options)
  }
  const adapter = new ClaudePlanAdapter({
    config: () => ({
      provider: ROUTE,
      displayName: 'Claude (your Claude plan)',
      models: [{ id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet', contextWindow: 1_000_000 }],
      permissionMode: 'ask',
      env: {},
      allowApiKey: false,
      ...config,
    }),
    agentFor: id => id === SESSION ? agent : undefined,
    cwdFor: () => Promise.resolve('/workspace/project'),
    askApproval: (_agent, toolName) => {
      approvals.push(toolName)
      return Promise.resolve(toolName !== 'Write')
    },
    query,
    ...overrides,
  })
  ctx.llm.registerAdapter([ROUTE], adapter)
  return { ctx, calls, approvals }
}

interface Assembled {
  readonly message: Message
  readonly finish: FinishReason
  readonly usage?: TokenUsage
}

async function run(ctx: Context, request: Partial<GenerateOptions> & { messages: RequestMessage[] }): Promise<Assembled> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: ROUTE, model: 'opus', sessionId: SESSION, ...request })) assembler.push(chunk)
  return {
    message: assembler.message({
      provider: ROUTE,
      model: 'opus',
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }),
    finish: assembler.finish,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })

afterEach(() => { vi.restoreAllMocks() })

describe('model picker', () => {
  it('registers the route with its label, models, and context windows, and never retries', async () => {
    const { ctx } = await harness(() => stream([]))

    expect(ctx.llm.listProviders()).toContainEqual({ id: ROUTE, name: 'Claude (your Claude plan)' })
    await expect(ctx.llm.listModels(ROUTE)).resolves.toEqual([
      { provider: ROUTE, id: 'opus', name: 'Claude Opus', inputModalities: ['text'] },
      { provider: ROUTE, id: 'sonnet', name: 'Claude Sonnet', inputModalities: ['text'] },
    ])
    await expect(ctx.llm.resolveModelInfo(ROUTE, 'opus')).resolves.toMatchObject({ context: { contextWindow: 200_000 } })
    await expect(ctx.llm.resolveModelInfo(ROUTE, 'sonnet')).resolves.toMatchObject({ context: { contextWindow: 1_000_000 } })
    await expect(ctx.llm.resolveModelInfo(ROUTE, 'gpt-5')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })
})

describe('retries', () => {
  it('never retries, because a retried turn could repeat actions Claude Code already took', () => {
    const adapter = new ClaudePlanAdapter({
      config: () => ({ provider: ROUTE, displayName: 'x', models: [], permissionMode: 'ask', env: {}, allowApiKey: false }),
      agentFor: () => undefined,
      cwdFor: () => Promise.resolve('/'),
      askApproval: undefined,
      query: () => stream([]),
    })

    expect(adapter.providerRetryPolicy()).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })
})

describe('streaming a turn', () => {
  it('streams reasoning, a tool summary, and text, then usage and a resumable finish', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('Hello there'), success()]))

    const result = await run(ctx, { messages: [user('list the files')] })

    expect(result.message.content).toEqual([
      { type: 'reasoning', text: 'Let me look.' },
      { type: 'reasoning', text: 'Claude used Bash: ls -la\n' },
      { type: 'text', text: 'Hello there' },
    ])
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 100 })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.role === 'assistant' && result.message.source.replayState)
      .toEqual({ response: { claudeSessionId: 'claude-1' } })
    expect(calls[0]!.prompt).toBe('list the files')
    expect(calls[0]!.options).toMatchObject({
      cwd: '/workspace/project',
      model: 'opus',
      includePartialMessages: true,
      permissionMode: 'default',
      disallowedTools: ['AskUserQuestion'],
    })
    expect(calls[0]!.options.resume).toBeUndefined()
  })

  it('resumes the Claude session on the next turn and sends only the new user text', async () => {
    const { ctx, calls } = await harness(call => stream([init(), ...answerTurn(`answer ${call}`), success(`claude-${call}`)]))
    const first = await run(ctx, { messages: [user('first question')] })

    await run(ctx, { messages: [user('first question'), first.message, user('follow-up')] })

    expect(calls[1]!.options.resume).toBe('claude-1')
    expect(calls[1]!.prompt).toBe('follow-up')
  })

  it('carries a conversation started on another model over as a transcript', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('ok'), success()]))
    const earlier = new BlockAssembler()
    earlier.push({ type: 'block-start', index: 0, blockType: 'text' })
    earlier.push({ type: 'text-delta', index: 0, text: 'DeepSeek answer' })
    earlier.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'DeepSeek answer' } })

    await run(ctx, {
      messages: [user('hi'), earlier.message({ provider: 'deepseek-official', model: 'deepseek-flash' }), user('now you')],
    })

    expect(calls[0]!.options.resume).toBeUndefined()
    expect(calls[0]!.prompt).toBe('Earlier conversation in this session:\n\nUser: hi\n\nAssistant: DeepSeek answer\n\nCurrent request:\n\nnow you')
  })

  it('answers titles and summaries in one tool-free, unsaved turn', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('A title'), success()]))

    const result = await run(ctx, { purpose: 'session-title', system: 'Write a title.', messages: [user('fix the bug')] })

    expect(calls[0]!.prompt).toBe('Write a title.\n\nfix the bug')
    expect(calls[0]!.options).toMatchObject({ tools: [], maxTurns: 1, persistSession: false })
    expect(calls[0]!.options.canUseTool).toBeUndefined()
    expect(result.message.role === 'assistant' && result.message.source.replayState).toBeUndefined()
  })
})

describe('your Claude plan, not an API key', () => {
  it('refuses a run that would bill an API key, before any answer is used', async () => {
    const { ctx } = await harness(() => stream([init('ANTHROPIC_API_KEY'), ...answerTurn('x'), success()]))

    const result = await run(ctx, { messages: [user('hi')] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    expect(result.message.content).toEqual([])
  })

  it('accepts an API key only when the route allows it', async () => {
    const { ctx } = await harness(() => stream([init('ANTHROPIC_API_KEY'), ...answerTurn('fine'), success()]), {}, { allowApiKey: true })

    await expect(run(ctx, { messages: [user('hi')] })).resolves.toMatchObject({ finish: { kind: 'stop' } })
  })

  it('reports a signed-out Claude Code as AUTH with the sign-in instruction', async () => {
    const { ctx } = await harness(() => stream([
      init(),
      sdk({ type: 'assistant', error: 'authentication_failed', message: { content: [] }, parent_tool_use_id: null }),
      sdk({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', session_id: 'claude-1', usage: {} }),
    ]))

    const result = await run(ctx, { messages: [user('hi')] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(JSON.stringify(result.finish)).toContain('/login')
  })

  it('keeps the parent Claude session and credentials out of the child environment', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-vscode')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-host')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'host-token')
    vi.stubEnv('LANG', 'en_US.UTF-8')
    try {
      const env = claudePlanEnv({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
      expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
      expect(env).not.toHaveProperty('CLAUDECODE')
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(env).toMatchObject({ LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('approvals', () => {
  it('asks the harness approval service and maps its answer', async () => {
    let canUseTool: Options['canUseTool']
    const { ctx, approvals } = await harness((_call, options) => {
      canUseTool = options.canUseTool
      return stream([init(), ...answerTurn('ok'), success()])
    })
    await run(ctx, { messages: [user('edit it')] })
    const signal = new AbortController().signal

    await expect(canUseTool!('Bash', { command: 'ls' }, { signal, toolUseID: 'u1', requestId: 'r1' }))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    await expect(canUseTool!('Write', { file_path: 'a' }, { signal, toolUseID: 'u2', requestId: 'r2' }))
      .resolves.toMatchObject({ behavior: 'deny' })
    expect(approvals).toEqual(['Bash', 'Write'])
  })

  it('denies when no approval surface exists', async () => {
    let canUseTool: Options['canUseTool']
    const { ctx } = await harness((_call, options) => {
      canUseTool = options.canUseTool
      return stream([init(), ...answerTurn('ok'), success()])
    }, { askApproval: undefined })
    await run(ctx, { messages: [user('edit it')] })

    await expect(canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 'u1', requestId: 'r1' }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })

  it('runs every tool without asking only when bypass is configured', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('ok'), success()]), {}, { permissionMode: 'bypassPermissions' })
    await run(ctx, { messages: [user('go')] })

    expect(calls[0]!.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    expect(calls[0]!.options.canUseTool).toBeUndefined()
  })

  it('passes acceptEdits through and still asks for the rest', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('ok'), success()]), {}, { permissionMode: 'acceptEdits' })
    await run(ctx, { messages: [user('go')] })

    expect(calls[0]!.options.permissionMode).toBe('acceptEdits')
    expect(calls[0]!.options.canUseTool).toBeTypeOf('function')
  })
})

describe('cancellation and failures', () => {
  it('aborts Claude Code when the request is cancelled and settles as aborted', async () => {
    const controller = new AbortController()
    let sdkAbort: AbortController | undefined
    const { ctx } = await harness((_call, options) => {
      sdkAbort = options.abortController
      return (async function * () {
        yield init()
        controller.abort(new Error('user pressed stop'))
        await new Promise<never>((_resolve, reject) => {
          const signal = options.abortController!.signal
          if (signal.aborted) reject(new Error('AbortError'))
          signal.addEventListener('abort', () => { reject(new Error('AbortError')) }, { once: true })
        })
      })()
    })

    const result = await run(ctx, { messages: [user('long task')], signal: controller.signal })

    expect(sdkAbort?.signal.aborted).toBe(true)
    expect(result.finish).toMatchObject({ kind: 'aborted' })
  })

  it('fails loudly when Claude Code ends without a result', async () => {
    const { ctx } = await harness(() => stream([init(), ...answerTurn('partial')]))

    await expect(run(ctx, { messages: [user('hi')] })).resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'STREAM_CLOSED' } } })
  })

  it('maps SDK result failures to stable codes', () => {
    expect(classifyFailure('success', 'rate_limit', false).code).toBe('QUOTA')
    expect(classifyFailure('success', 'billing_error', false).code).toBe('QUOTA')
    expect(classifyFailure('success', 'overloaded', false).code).toBe('SERVER')
    expect(classifyFailure('success', 'server_error', false).code).toBe('SERVER')
    expect(classifyFailure('success', 'max_output_tokens', false).code).toBe('MAX_OUTPUT_TOKENS')
    expect(classifyFailure('error_max_turns', undefined, false)).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('error_max_turns') as string })
    expect(classifyFailure('error_during_execution', 'unknown', false).message).toContain('(unknown)')
    expect(classifyFailure('success', 'oauth_org_not_allowed', true).code).toBe('AUTH')
  })

  it('reports an error result with its subtype', async () => {
    const { ctx } = await harness(() => stream([init(), sdk({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'c', usage: {}, errors: [] })]))

    await expect(run(ctx, { messages: [user('hi')] })).resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'PROVIDER_ERROR' } } })
  })

  it('refuses stop sequences and requests with nothing to say', async () => {
    const { ctx } = await harness(() => stream([init(), success()]))

    await expect(run(ctx, { messages: [user('hi')], stop: ['END'] })).resolves.toMatchObject({ finish: { failure: { code: 'UNSUPPORTED_OPTION' } } })
    await expect(run(ctx, { messages: [user('   ')] })).resolves.toMatchObject({ finish: { failure: { code: 'EMPTY_PROMPT' } } })
    await expect(run(ctx, { purpose: 'compaction', messages: [] })).resolves.toMatchObject({ finish: { failure: { code: 'EMPTY_PROMPT' } } })
  })

  it('runs outside an Agent in a scratch directory as a one-shot', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('ok'), success()]))

    await run(ctx, { sessionId: brandString<SessionId>('unknown-session'), messages: [user('hi')] })

    expect(calls[0]!.options).toMatchObject({ maxTurns: 1, tools: [] })
    expect(calls[0]!.options.cwd).not.toBe('/workspace/project')
  })
})

describe('turn planning', () => {
  it('leaves no block behind for a thinking block with no visible text', () => {
    const translator = new ClaudeStreamTranslator()
    translator.push(event({ type: 'message_start' }))
    expect(translator.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))).toEqual([])
    expect(translator.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }))).toEqual([])
    expect(translator.push(event({ type: 'content_block_stop', index: 0 }))).toEqual([])
    expect(translator.push(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })))
      .toEqual([{ type: 'block-start', index: 1, blockType: 'text' }])
  })

  it('reads only this route\'s replay state', () => {
    expect(readReplay({ response: { claudeSessionId: 'abc' } })).toEqual({ claudeSessionId: 'abc' })
    for (const value of [undefined, null, 'x', {}, { response: null }, { response: { claudeSessionId: '' } }, { response: { claudeSessionId: 1 } }]) {
      expect(readReplay(value)).toBeUndefined()
    }
  })

  it('marks attachments it cannot forward and ignores other blocks', () => {
    const plan = planTurn([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'reasoning', text: 'hidden' },
        { type: 'file', attachmentId: 'a' as never, name: 'x.pdf', mediaType: 'application/pdf' } as never,
      ],
    }], ROUTE)
    expect(plan.prompt).toBe('look\n[file attachment not forwarded to Claude]')
  })

  it('needs user text after the last Claude answer', () => {
    expect(() => planTurn([], ROUTE)).toThrow(LlmError)
  })

  it('sends the human\'s request and leaves out the harness\'s own context messages', () => {
    const fromHarness = (kind: string, text: string): RequestMessage => ({
      id: `${kind}-1`, role: 'user', content: [{ type: 'text', text }], source: { kind },
    } as never)
    const human = (text: string): RequestMessage => ({ id: 'u-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as never)

    // The loop places runtime context after the human message; neither order may make it the request.
    expect(planTurn([
      fromHarness('agent-instructions', '# AGENTS.md rules'),
      human('Reply with exactly the word: pong'),
      fromHarness('runtime-context', 'Current runtime context: approval policy ask'),
      fromHarness('time-context', 'Today is Sunday'),
    ], ROUTE)).toEqual({ prompt: 'Reply with exactly the word: pong' })
    expect(planTurn([
      fromHarness('runtime-context', 'Current runtime context: approval policy ask'),
      human('fix the bug'),
    ], ROUTE)).toEqual({ prompt: 'fix the bug' })
  })

  it('forwards attached session references before the request, and answers a turn no human started', () => {
    const reference: RequestMessage = {
      id: 'r-1', role: 'user', content: [{ type: 'text', text: 'Referenced session: the login work' }], source: { kind: 'session-reference' },
    } as never
    const human: RequestMessage = { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'continue that' }], source: { kind: 'user' } } as never
    expect(planTurn([reference, human], ROUTE)).toEqual({ prompt: 'Referenced session: the login work\n\ncontinue that' })

    const scheduled: RequestMessage = { id: 's-1', role: 'user', content: [{ type: 'text', text: 'Run the nightly check' }], source: { kind: 'schedule' } } as never
    expect(planTurn([scheduled], ROUTE)).toEqual({ prompt: 'Run the nightly check' })
  })

  it('resumes with only the human text that arrived after the last Claude answer', () => {
    const answered = new BlockAssembler()
    answered.push({ type: 'block-start', index: 0, blockType: 'text' })
    answered.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'done' } })
    answered.push({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { claudeSessionId: 'claude-7' } } })
    const runtime: RequestMessage = {
      id: 'c-2', role: 'user', content: [{ type: 'text', text: 'Current runtime context: none' }], source: { kind: 'runtime-context' },
    } as never
    const plan = planTurn([
      user('first'),
      answered.message({ provider: ROUTE, model: 'opus', replayState: answered.replayState }),
      user('second'),
      runtime,
    ], ROUTE)
    expect(plan).toEqual({ resume: 'claude-7', prompt: 'second' })
  })

  it('converts usage without inventing cache counts', () => {
    expect(tokenUsage({ input_tokens: 1, output_tokens: 2 })).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(tokenUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 }))
      .toEqual({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3 })
  })
})

describe('the mounted plugin', () => {
  async function mount(services: { workingDirectory?: boolean; approval?: boolean } = {}) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('agents', { get: (id: SessionId) => id === SESSION ? agent : undefined } as Context['agents'])
    const asked: { toolName: string; reason?: string }[] = []
    if (services.workingDirectory !== false) {
      const workingDirectory: Pick<Context['workingDirectory'], 'ensure'> = { ensure: () => Promise.resolve('/mounted/workspace') }
      ctx.provide('workingDirectory', workingDirectory as Context['workingDirectory'])
    }
    if (services.approval !== false) {
      const approval: Pick<Context['approval'], 'request'> = {
        request: (request) => {
          asked.push({ toolName: request.toolName, ...request.reason === undefined ? {} : { reason: request.reason } })
          return Promise.resolve('allowed-once')
        },
      }
      ctx.provide('approval', approval as Context['approval'])
    }
    await ctx.plugin(claudePlan, {})
    return { ctx, asked }
  }

  it('registers the default route and models, runs in the session directory, and relays approvals', async () => {
    let options: Options | undefined
    sdkQuery.mockImplementation((params: { options: Options }) => {
      options = params.options
      return stream([init(), ...answerTurn('hi'), success()])
    })
    const { ctx, asked } = await mount()

    expect(ctx.llm.listProviders()).toContainEqual({ id: 'claude-plan', name: 'Claude (your Claude plan)' })
    expect((await ctx.llm.listModels('claude-plan')).map(model => model.id)).toEqual(['opus', 'sonnet', 'haiku'])
    await expect(run(ctx, { messages: [user('hi')] })).resolves.toMatchObject({ finish: { kind: 'stop' } })
    expect(options?.cwd).toBe('/mounted/workspace')
    await expect(options!.canUseTool!('Bash', { command: 'make' }, { signal: new AbortController().signal, toolUseID: 'u', requestId: 'r', title: 'Claude wants to run make' }))
      .resolves.toMatchObject({ behavior: 'allow' })
    expect(asked).toMatchObject([{ toolName: 'Claude: Bash', reason: 'Claude wants to run make' }])
  })

  it('fails a session turn without a working directory, and denies tools without an approval service', async () => {
    let options: Options | undefined
    sdkQuery.mockImplementation((params: { options: Options }) => {
      options = params.options
      return stream([init(), ...answerTurn('hi'), success()])
    })
    const missingDirectory = await mount({ workingDirectory: false })
    await expect(run(missingDirectory.ctx, { messages: [user('hi')] }))
      .resolves.toMatchObject({ finish: { failure: { code: 'NO_WORKING_DIRECTORY' } } })

    const noApproval = await mount({ approval: false })
    await run(noApproval.ctx, { messages: [user('hi')] })
    await expect(options!.canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 'u', requestId: 'r', decisionReason: 'outside workspace' }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })
})

describe('stream translation edges', () => {
  it('ignores events it cannot place and summarizes every tool-input form', () => {
    const translator = new ClaudeStreamTranslator()
    const pushed = (message: SDKMessage) => translator.push(message)
    const long = 'x'.repeat(250)

    expect(pushed(init())).toEqual([])
    expect(pushed(event({ type: 'message_start' }))).toEqual([])
    expect(pushed(event({ type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'lost' } }))).toEqual([])
    expect(pushed(event({ type: 'content_block_stop', index: 9 }))).toEqual([])
    expect(pushed(event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } }))).toEqual([])
    expect(pushed(event({ type: 'message_delta', delta: {} }))).toEqual([])
    pushed(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    expect(pushed(event({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'wrong kind' } }))).toEqual([])

    const tool = (index: number, json: string): string => {
      pushed(event({ type: 'content_block_start', index, content_block: { type: 'tool_use', name: 'Tool', id: `t${index}`, input: {} } }))
      if (json.length > 0) pushed(event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }))
      const chunks = pushed(event({ type: 'content_block_stop', index }))
      return chunks[1]?.type === 'reasoning-delta' ? chunks[1].text : ''
    }
    expect(tool(2, '')).toBe('Claude used Tool\n')
    expect(tool(3, '[1,2]')).toBe('Claude used Tool\n')
    expect(tool(4, '{"command":')).toBe('Claude used Tool\n')
    expect(tool(5, `{"file_path":"${long}"}`)).toBe(`Claude used Tool: ${'x'.repeat(200)}…\n`)
    expect(tool(6, '{"other":1}')).toBe('Claude used Tool\n')

    pushed(sdk({ type: 'assistant', error: 'rate_limit', message: { content: [] }, parent_tool_use_id: null }))
    expect(translator.failure('success').code).toBe('QUOTA')
  })

  it('names unnamed models by id and flattens one-shot history', async () => {
    const { ctx, calls } = await harness(() => stream([init(), ...answerTurn('t'), success()]), {}, { models: [{ id: 'claude-opus-4-8' }] })

    await expect(ctx.llm.listModels(ROUTE)).resolves.toEqual([{ provider: ROUTE, id: 'claude-opus-4-8', name: 'claude-opus-4-8', inputModalities: ['text'] }])
    await expect(ctx.llm.resolveModelInfo(ROUTE, 'claude-opus-4-8')).resolves.toMatchObject({ name: 'claude-opus-4-8' })
    const earlier = new BlockAssembler()
    earlier.push({ type: 'block-start', index: 0, blockType: 'text' })
    earlier.push({ type: 'text-delta', index: 0, text: 'previous answer' })
    earlier.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'previous answer' } })
    await run(ctx, {
      model: 'claude-opus-4-8',
      purpose: 'compaction',
      messages: [user('q'), earlier.message({ provider: ROUTE, model: 'claude-opus-4-8' }), user('  ')],
    })
    expect(calls[0]!.prompt).toBe('q\n\nAssistant: previous answer')
  })

  it('settles a request that was cancelled before it started as aborted', async () => {
    const { ctx, calls } = await harness((_call, options) => (async function * () {
      if (options.abortController?.signal.aborted === true) throw new Error('AbortError')
      yield init()
    })())
    const controller = new AbortController()
    controller.abort()

    await expect(run(ctx, { messages: [user('hi')], signal: controller.signal })).resolves.toMatchObject({ finish: { kind: 'aborted' } })
    expect(calls.length).toBeLessThanOrEqual(1)
  })
})

describe('remaining request forms', () => {
  it('skips answers from this route that carry no session, and forwards no images', () => {
    const answered = new BlockAssembler()
    answered.push({ type: 'block-start', index: 0, blockType: 'text' })
    answered.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'no replay' } })
    const plan = planTurn([
      user('first'),
      answered.message({ provider: ROUTE, model: 'opus' }),
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', attachmentId: 'a' } as never] },
    ], ROUTE)

    expect(plan.resume).toBeUndefined()
    expect(plan.prompt).toContain('[image attachment not forwarded to Claude]')
    expect(plan.prompt).toContain('Assistant: no replay')
  })

  it('treats a request without a session as a one-shot and labels non-chat context', async () => {
    const { ctx, calls } = await harness(() => stream([
      init(),
      sdk({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search', id: 's' } }),
      ...answerTurn('ok'),
      success(),
    ]))
    const assembler = new BlockAssembler()
    const context = { role: 'system', content: [{ type: 'text', text: 'house rules' }, { type: 'reasoning', text: 'not forwarded' }] } as never

    for await (const chunk of ctx.llm.stream({ provider: ROUTE, model: 'opus', messages: [context, user('hi')] })) assembler.push(chunk)

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(calls[0]!.prompt).toBe('Context: house rules\n\nhi')
    expect(calls[0]!.options).toMatchObject({ maxTurns: 1 })
  })

  it('applies its defaults when mounted without a validated config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.plugin({ name: 'direct', inject: ['llm'], apply: (child: Context) => { claudePlan.apply(child, {}) } })

    await vi.waitFor(() => { expect(ctx.llm.listProviders()).toContainEqual({ id: 'claude-plan', name: 'Claude (your Claude plan)' }) })
    await expect(ctx.llm.listModels('claude-plan')).resolves.toEqual([])
  })
})
