/**
 * Model route backed by the user's own Claude plan. Each request runs one
 * turn of an unmodified Claude Code session through the official Agent SDK,
 * signed in with the login the user created in Claude Code; this plugin never
 * reads, stores, or forwards that login. Claude Code runs its own tools in the
 * session's working directory, its permission prompts go to the harness
 * approval service, and its Claude session id is stored as replay state so the
 * next turn resumes the same conversation.
 *
 * ```yaml
 * - id: llm-claude-plan
 *   name: '@deepseek-ai/dsh-subagent-claude-code/llm'
 * ```
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/llm
 */

import { tmpdir } from 'node:os'
import { query as officialQuery, type CanUseTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import { ClaudeStreamTranslator, SIGN_IN_HINT, planTurn, tokenUsage, type ClaudePlanReplay } from './llm-turn.ts'
import { CLAUDE_PLAN_ROUTE_PATH, bundledClaudeExecutable, execStatus, readClaudePlanStatus } from './plan-status.ts'

export const name = 'subagent-claude-code-llm'
export const inject = ['llm']

/** One model offered on the route. */
export interface ClaudePlanModel {
  /** Model name or alias Claude Code accepts, such as `opus` or `sonnet`. */
  id: string
  /** Label shown in the model picker. */
  name?: string
  /** Context window reported to the harness for context-pressure accounting. */
  contextWindow?: number
}

/** Claude permission behavior for tools Claude Code wants to run. */
export type ClaudePlanPermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** Route identity, offered models, permission behavior, and child environment. */
export interface Config {
  /** Provider route id the model picker selects (default `claude-plan`). */
  provider?: string
  /** Provider label shown in the model picker. */
  displayName?: string
  /** Models offered on the route. */
  models?: ClaudePlanModel[]
  /**
   * `ask` sends every permission prompt to the harness approval panel;
   * `acceptEdits` allows file edits and asks for the rest; `plan` lets Claude
   * plan without executing; `bypassPermissions` runs every tool without asking.
   */
  permissionMode?: ClaudePlanPermissionMode
  /** Explicit environment entries for Claude Code, layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /**
   * Allow Claude Code to authenticate with an API key instead of the Claude
   * plan login. Off by default so this route never bills an API account silently.
   */
  allowApiKey?: boolean
}

const DEFAULT_PROVIDER = 'claude-plan'
const DEFAULT_CONTEXT_WINDOW = 200_000

export const Config: z<Config> = z.object({
  provider: z.string().min(1).default(DEFAULT_PROVIDER),
  displayName: z.string().min(1).default('Claude (your Claude plan)'),
  models: z.array(z.object({
    id: z.string().min(1).required(),
    name: z.string().min(1),
    contextWindow: z.natural().min(1),
  })).default([
    { id: 'opus', name: 'Claude Opus' },
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'haiku', name: 'Claude Haiku' },
  ]),
  permissionMode: z.union(['ask', 'acceptEdits', 'plan', 'bypassPermissions']).default('ask'),
  env: z.dict(z.string()).default({}),
  allowApiKey: z.boolean().default(false),
})

/**
 * Environment set by a parent Claude Code process. Inherited by a nested
 * Claude Code, they make it identify as that parent's client and ignore its
 * own login, so they never reach the child.
 */
const PARENT_SESSION_ENV: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
])

/**
 * The environment Claude Code runs with: the parent environment without
 * credential-shaped names, DSH names, or parent Claude Code session markers,
 * then the explicit overlay.
 * @param overlay - explicit configured entries.
 * @returns the child environment.
 */
export function claudePlanEnv(overlay: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(scrubbedParentEnv()).filter(([key]) => !PARENT_SESSION_ENV.has(key))
  return { ...Object.fromEntries(inherited), ...overlay }
}

/** Starts one SDK query; the adapter only reads its message stream. */
export type QueryFunction = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

/** Services and settings one adapter instance reads per request. */
export interface ClaudePlanAdapterOptions {
  readonly config: () => Required<Omit<Config, 'models'>> & { readonly models: readonly ClaudePlanModel[] }
  readonly agentFor: (sessionId: SessionId) => Agent | undefined
  readonly cwdFor: (agent: Agent, signal: AbortSignal) => Promise<string>
  readonly askApproval: ((agent: Agent, toolName: string, reason: string, signal: AbortSignal) => Promise<boolean>) | undefined
  readonly query: QueryFunction
}

/** Retries would replay a turn whose tools Claude Code may already have run. */
const NO_RETRY: ResolvedRetryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'subagent-claude-code-llm retryPolicy')

/** `LlmAdapter` serving the Claude-plan route through Claude Code. */
export class ClaudePlanAdapter extends LlmAdapter {
  constructor(private readonly services: ClaudePlanAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.services.config().displayName }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return NO_RETRY
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.services.config().models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.services.config().models.find(candidate => candidate.id === model)
    if (entry === undefined) {
      return Promise.reject(new LlmError(`subagent-claude-code: route "${provider}" offers no model "${model}"`, 'UNKNOWN_MODEL'))
    }
    return Promise.resolve({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      inputModalities: ['text'],
      context: { contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('subagent-claude-code: stop sequences are not supported by Claude Code', 'UNSUPPORTED_OPTION')
    }
    const config = this.services.config()
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(options.signal?.reason) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    try {
      const agent = options.sessionId === undefined ? undefined : this.services.agentFor(options.sessionId)
      // Titles, compaction summaries, and calls outside an Agent are single
      // answers: no tools, no persisted Claude session.
      const conversational = agent !== undefined && options.purpose === undefined
      const plan = conversational
        ? planTurn(options.messages, options.provider)
        : { prompt: oneShotPrompt(options) }
      const cwd = agent === undefined ? tmpdir() : await this.services.cwdFor(agent, controller.signal)
      const sdkOptions: Options = {
        cwd,
        model: options.model,
        abortController: controller,
        includePartialMessages: true,
        env: claudePlanEnv(config.env),
        disallowedTools: ['AskUserQuestion'],
        ...plan.resume === undefined ? {} : { resume: plan.resume },
        ...conversational
          ? this.permissionOptions(config.permissionMode, agent)
          : { tools: [], maxTurns: 1, persistSession: false },
      }
      const translator = new ClaudeStreamTranslator()
      const run = this.services.query({ prompt: plan.prompt, options: sdkOptions })
      let completed: { readonly usage: StreamChunk; readonly replay: ClaudePlanReplay } | undefined
      // The stream is drained to normal completion before `finish` so Claude
      // Code has saved the session the next turn resumes.
      for await (const message of run) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.apiKeySource !== 'none' && !config.allowApiKey) {
            throw new LlmError(
              `subagent-claude-code: Claude Code would bill an API key (${message.apiKeySource}) instead of your Claude plan; `
              + 'remove that key from Claude Code\'s settings, or set allowApiKey on this route',
              'INVALID_CREDENTIAL',
            )
          }
          continue
        }
        yield * translator.push(message)
        if (message.type !== 'result' || completed !== undefined) continue
        if (message.subtype !== 'success' || message.is_error) {
          throw message.subtype === 'success' ? translator.failure('success') : translator.failure(message.subtype)
        }
        completed = {
          usage: { type: 'usage', usage: tokenUsage(message.usage) },
          replay: { claudeSessionId: message.session_id },
        }
      }
      if (completed === undefined) {
        throw new LlmError(`subagent-claude-code: Claude Code ended without a result. ${SIGN_IN_HINT}`, 'STREAM_CLOSED')
      }
      yield completed.usage
      yield { type: 'finish', reason: { kind: 'stop' }, ...conversational ? { replayState: { response: completed.replay } } : {} }
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new LlmError('subagent-claude-code: options cancelled', 'ABORTED', { cause: error })
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private permissionOptions(mode: ClaudePlanPermissionMode, agent: Agent): Partial<Options> {
    if (mode === 'bypassPermissions') return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
    const askApproval = this.services.askApproval
    const canUseTool: CanUseTool = async (toolName, input, { signal, title, decisionReason }) => {
      if (askApproval === undefined) {
        return { behavior: 'deny', message: 'No approval surface is available in this harness session.' }
      }
      const reason = title ?? decisionReason ?? `Claude wants to use ${toolName}`
      const allowed = await askApproval(agent, toolName, reason, signal)
      return allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The user declined this action.' }
    }
    return {
      permissionMode: mode === 'ask' ? 'default' : mode,
      canUseTool,
    }
  }
}

/** Flatten a request with no conversation to resume into one prompt. */
function oneShotPrompt(request: GenerateOptions): string {
  const parts: string[] = []
  if (request.system !== undefined && request.system.length > 0) parts.push(request.system)
  for (const message of request.messages) {
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text.length === 0) continue
    parts.push(message.role === 'user' ? text : `${message.role === 'assistant' ? 'Assistant' : 'Context'}: ${text}`)
  }
  if (parts.length === 0) throw new LlmError('subagent-claude-code: the request has no text to send to Claude', 'EMPTY_PROMPT')
  return parts.join('\n\n')
}

/**
 * Register the Claude-plan route.
 * @param ctx - context carrying `ctx.llm` and, optionally, Agents, working directories, and approvals.
 * @param config - route identity, models, permission behavior, and child environment.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = (): ReturnType<ClaudePlanAdapterOptions['config']> => ({
    provider: config.provider ?? DEFAULT_PROVIDER,
    displayName: config.displayName ?? 'Claude (your Claude plan)',
    models: config.models ?? [],
    permissionMode: config.permissionMode ?? 'ask',
    env: config.env ?? {},
    allowApiKey: config.allowApiKey ?? false,
  })
  const adapter = new ClaudePlanAdapter({
    config: resolved,
    agentFor: sessionId => ctx.get('agents')?.get(sessionId),
    cwdFor: async (agent, signal) => {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined) {
        throw new LlmError('subagent-claude-code: the working-directory service is required to run Claude in a session', 'NO_WORKING_DIRECTORY')
      }
      return await workingDirectory.ensure(agent, signal)
    },
    askApproval: async (agent, toolName, reason, signal) => {
      const approval = ctx.get('approval')
      if (approval === undefined) return false
      const outcome = await approval.request({ agent, toolName: `Claude: ${toolName}`, reason, signal })
      return outcome === 'allowed-once'
    },
    query: params => officialQuery(params),
  })
  ctx.effect(() => ctx.llm.registerAdapter([resolved().provider], adapter))
  // The Models settings page shows whether Claude Code is signed in with a
  // plan. The route only reports Claude Code's own status; sign-in stays in
  // Claude Code, which is the only place Anthropic permits it.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: CLAUDE_PLAN_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const current = resolved()
        const status = await readClaudePlanStatus({
          executable: bundledClaudeExecutable(),
          env: claudePlanEnv(current.env),
          route: {
            id: current.provider,
            name: current.displayName,
            models: current.models.map(model => ({ id: model.id, name: model.name ?? model.id })),
          },
          run: execStatus,
        })
        return new Response(JSON.stringify(status), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'subagent-claude-code-llm: Claude plan status route')
  })
}
