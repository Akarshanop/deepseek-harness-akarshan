/**
 * Pure translation between the harness model-call vocabulary and one Claude
 * Agent SDK query: which Claude session a request continues, what prompt it
 * sends, how SDK messages become `StreamChunk`s, and how SDK failures become
 * stable `LlmError` codes. The plugin in `llm.ts` owns process and service wiring.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/llm-turn
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Replay state stored on each assistant message this route produces. */
export interface ClaudePlanReplay {
  /** The Claude Code session that produced the message and that the next turn resumes. */
  readonly claudeSessionId: string
}

/** What one request sends to Claude Code. */
export interface ClaudeTurnPlan {
  /** Claude Code session to resume; absent starts a new session. */
  readonly resume?: string
  /** Text prompt for this turn. */
  readonly prompt: string
}

/**
 * Read this route's replay state from an assistant message source.
 * @param value - the message's `source.replayState`.
 * @returns the stored Claude session id, or undefined when the value is not this route's state.
 */
export function readReplay(value: unknown): ClaudePlanReplay | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const response = (value as { response?: unknown }).response
  if (response === null || typeof response !== 'object') return undefined
  const id = (response as { claudeSessionId?: unknown }).claudeSessionId
  return typeof id === 'string' && id.length > 0 ? { claudeSessionId: id } : undefined
}

function blockText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
      case 'file':
        parts.push(`[${block.type} attachment not forwarded to Claude]`)
        break
      default:
        // Reasoning, tool calls, and tool declarations belong to other routes'
        // turns and carry nothing Claude Code can act on.
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * User-role producers whose content is forwarded to Claude besides the human's
 * own messages: `#` references to other sessions, which the user attached to
 * the request. Every other user-role producer describes the harness itself —
 * its runtime context, clock, instruction files, tool and skill catalogs, plan
 * mode — for the harness's own tools, which Claude Code does not have, so that
 * text would only mislead it.
 */
const FORWARDED_CONTEXT: ReadonlySet<string> = new Set(['session-reference'])

/**
 * Whether a user-role message is the human's own text. A request-only input
 * from a one-shot caller carries no source and counts as the human's.
 */
function isHuman(message: RequestMessage): boolean {
  return message.role === 'user' && (message.source === undefined || message.source.kind === 'user')
}

/**
 * Decide which Claude session a request continues and what it sends.
 *
 * The newest assistant message produced by this route names the Claude
 * session; only what follows it is sent, because Claude Code already holds
 * everything before it. The request is what arrived after the newest answer:
 * the human's own messages, preceded by any attached session references, with
 * harness context messages left out. A turn with no human message (a scheduled
 * or delegated trigger) sends the newest user-role message instead. Without a
 * resumable answer, earlier human and assistant text is sent as a transcript so
 * a conversation started on another model carries over.
 * @param messages - the request's durable history and request-only inputs.
 * @param route - this adapter's provider route.
 * @returns the session to resume and the prompt text.
 * @throws {LlmError} code `EMPTY_PROMPT` when there is no user text to send.
 */
export function planTurn(messages: readonly RequestMessage[], route: string): ClaudeTurnPlan {
  let resumeAt = -1
  let resume: string | undefined
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.source.provider !== route) return
    const replay = readReplay(message.source.replayState)
    if (replay === undefined) return
    resumeAt = index
    resume = replay.claudeSessionId
  })
  const after = messages.slice(resumeAt + 1)
  // The current request is what arrived since the newest answer from any
  // route; anything earlier is conversation history.
  const lastAnswer = after.findLastIndex(message => message.role === 'assistant')
  const userEntries = after
    .flatMap((message, index) => message.role === 'user' && index > lastAnswer ? [{ index, message, text: blockText(message.content) }] : [])
    .filter(entry => entry.text.length > 0)
  const human = userEntries.filter(entry => isHuman(entry.message))
  const requests = human.length > 0 ? human : userEntries.slice(-1)
  const first = requests[0]
  if (first === undefined) {
    throw new LlmError('subagent-claude-code: the request has no user text to send to Claude', 'EMPTY_PROMPT')
  }
  const references = userEntries
    .filter(entry => !isHuman(entry.message) && entry.message.source !== undefined && FORWARDED_CONTEXT.has(entry.message.source.kind))
    .map(entry => entry.text)
  const request = [...references, ...requests.map(entry => entry.text)].join('\n\n')
  if (resume !== undefined) return { resume, prompt: request }

  const transcript = after.slice(0, first.index)
    .filter(message => isHuman(message) || message.role === 'assistant')
    .map(message => ({ role: message.role, text: blockText(message.content) }))
    .filter(entry => entry.text.length > 0)
    .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
  if (transcript.length === 0) return { prompt: request }
  return {
    prompt: `Earlier conversation in this session:\n\n${transcript.join('\n\n')}\n\nCurrent request:\n\n${request}`,
  }
}

/** Summarize one Claude Code tool call for the reasoning stream. */
function describeToolUse(name: string, rawInput: string): string {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(rawInput.length === 0 ? '{}' : rawInput)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
  } catch {
    // Partial or malformed tool input: the tool name alone still tells the user what ran.
  }
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) {
      const short = value.length > 200 ? `${value.slice(0, 200)}…` : value
      return `Claude used ${name}: ${short}\n`
    }
  }
  return `Claude used ${name}\n`
}

interface OpenBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool'
  text: string
  /** Whether `block-start` was emitted; reasoning starts at its first non-empty delta. */
  started: boolean
  /** Claude Code tool name for a `tool` block; empty for text and reasoning. */
  readonly toolName: string
}

/**
 * Translates the SDK message stream of one query into harness chunks.
 *
 * Claude Code runs several model turns inside one query; their content blocks
 * get harness indexes in first-seen order across turns. Claude's own tool calls
 * become reasoning text naming the tool, never harness tool-call blocks, because
 * Claude Code has already executed them.
 */
export class ClaudeStreamTranslator {
  private nextIndex = 0
  private turn = 0
  private readonly open = new Map<string, OpenBlock>()
  private authenticationError = false
  private sdkError: string | undefined

  /**
   * Translate one SDK message.
   * @param message - the next SDK message.
   * @returns the chunks it produces, in order.
   */
  push(message: SDKMessage): StreamChunk[] {
    if (message.type === 'assistant') {
      if (message.error !== undefined) {
        this.sdkError = message.error
        if (AUTHENTICATION_ERRORS.has(message.error)) this.authenticationError = true
      }
      return []
    }
    if (message.type !== 'stream_event' || message.parent_tool_use_id !== null) return []
    const event = message.event
    switch (event.type) {
      case 'message_start':
        this.turn += 1
        return []
      case 'content_block_start': {
        const key = `${this.turn}:${event.index}`
        const block = event.content_block
        if (block.type === 'text') return this.start(key, 'text')
        if (block.type === 'thinking') return this.start(key, 'reasoning')
        if (block.type === 'tool_use') {
          this.open.set(key, { index: -1, kind: 'tool', text: '', toolName: block.name, started: false })
        }
        return []
      }
      case 'content_block_delta': {
        const open = this.open.get(`${this.turn}:${event.index}`)
        if (open === undefined) return []
        const delta = event.delta
        if (delta.type === 'text_delta' && open.kind === 'text') {
          open.text += delta.text
          return [{ type: 'text-delta', index: open.index, text: delta.text }]
        }
        if (delta.type === 'thinking_delta' && open.kind === 'reasoning' && delta.thinking.length > 0) {
          open.text += delta.thinking
          const chunk: StreamChunk = { type: 'reasoning-delta', index: open.index, text: delta.thinking }
          if (open.started) return [chunk]
          open.started = true
          return [{ type: 'block-start', index: open.index, blockType: 'reasoning' }, chunk]
        }
        if (delta.type === 'input_json_delta' && open.kind === 'tool') open.text += delta.partial_json
        return []
      }
      case 'content_block_stop': {
        const key = `${this.turn}:${event.index}`
        const open = this.open.get(key)
        if (open === undefined) return []
        this.open.delete(key)
        if (open.kind === 'tool') {
          const index = this.nextIndex++
          const text = describeToolUse(open.toolName, open.text)
          return [
            { type: 'block-start', index, blockType: 'reasoning' },
            { type: 'reasoning-delta', index, text },
            { type: 'block-end', index, block: { type: 'reasoning', text } },
          ]
        }
        // Claude can return a thinking block with no visible text; it leaves no block behind.
        if (!open.started) return []
        return [{
          type: 'block-end',
          index: open.index,
          block: open.kind === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
        }]
      }
      default:
        return []
    }
  }

  /**
   * The failure a non-successful result represents.
   * @param subtype - the SDK result subtype.
   * @returns an `LlmError` with a stable code and an actionable message.
   */
  failure(subtype: string): LlmError {
    return classifyFailure(subtype, this.sdkError, this.authenticationError)
  }

  private start(key: string, kind: 'text' | 'reasoning'): StreamChunk[] {
    const index = this.nextIndex++
    const started = kind === 'text'
    this.open.set(key, { index, kind, text: '', toolName: '', started })
    return started ? [{ type: 'block-start', index, blockType: kind }] : []
  }
}

/** Assistant-message errors meaning the Claude login or account cannot be used. */
const AUTHENTICATION_ERRORS: ReadonlySet<string> = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold'])

/** Fixed recovery instruction for a sign-in problem. */
export const SIGN_IN_HINT = 'Sign in to your Claude plan by running "claude" in a terminal and using /login, then retry.'

/**
 * Map an SDK failure to a stable harness error code.
 * @param subtype - the SDK result subtype, or `success` for an `is_error` success result.
 * @param sdkError - the last assistant-message error the SDK reported, if any.
 * @param authentication - whether an authentication or account error was reported.
 * @returns the error to throw from the adapter.
 */
export function classifyFailure(subtype: string, sdkError: string | undefined, authentication: boolean): LlmError {
  if (authentication) {
    return new LlmError(`subagent-claude-code: Claude rejected the sign-in (${sdkError}). ${SIGN_IN_HINT}`, 'AUTH')
  }
  if (sdkError === 'rate_limit') {
    return new LlmError('subagent-claude-code: your Claude plan usage limit was reached; wait for it to reset', 'QUOTA')
  }
  if (sdkError === 'billing_error') {
    return new LlmError('subagent-claude-code: Claude reported a billing problem with this account', 'QUOTA')
  }
  if (sdkError === 'overloaded' || sdkError === 'server_error') {
    return new LlmError(`subagent-claude-code: Claude is temporarily unavailable (${sdkError})`, 'SERVER')
  }
  if (sdkError === 'max_output_tokens') {
    return new LlmError('subagent-claude-code: Claude hit its output limit', 'MAX_OUTPUT_TOKENS')
  }
  return new LlmError(
    `subagent-claude-code: Claude Code ended the turn with ${subtype}${sdkError === undefined ? '' : ` (${sdkError})`}`,
    'PROVIDER_ERROR',
  )
}

/**
 * Convert SDK usage to the harness's disjoint token counts.
 * @param usage - the result message's usage.
 * @param usage.input_tokens - uncached input tokens.
 * @param usage.output_tokens - output tokens.
 * @param usage.cache_read_input_tokens - cached input read.
 * @param usage.cache_creation_input_tokens - cached input written.
 * @returns harness token usage.
 */
export function tokenUsage(usage: {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
  }
}
