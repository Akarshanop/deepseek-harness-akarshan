/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-range quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf, type Deadline } from '@deepseek-ai/dsh-timeout'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Claude Code permission modes that cannot wait for a human response. */
export const CLAUDE_CODE_PERMISSION_MODES = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
] as const satisfies readonly NonNullable<Options['permissionMode']>[]

/** Profile-selectable non-interactive Claude Code permission mode. */
export type ClaudeCodePermissionMode = typeof CLAUDE_CODE_PERMISSION_MODES[number]

/** Safe default for unattended Claude Code runs. */
export const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode = 'dontAsk'

const SUPPORTED_UNATTENDED_DIALOG_KINDS = [
  'refusal_fallback_prompt',
] satisfies NonNullable<Options['supportedDialogKinds']>

type ClaudeCodeFailureStage =
  | 'query-start'
  | 'query-run'
  | 'process'
  | 'teardown'

type ClaudeCodeFailureCategory =
  | 'limit'
  | 'authentication'
  | 'timeout'
  | 'product-error'
  | 'invalid-result'
  | 'process'
  | 'unknown'

interface ClaudeCodeFailureFacts {
  readonly stage: ClaudeCodeFailureStage
  readonly category: ClaudeCodeFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

/** Timeout code stamped on the wall-clock deadline of one run. */
const CLAUDE_CODE_RUN_TIMEOUT = 'CLAUDE_CODE_RUN_TIMEOUT'

/** Fixed remedy appended to every `authentication` failure diagnostic. */
const AUTHENTICATION_HINT = 'Claude Code authentication failed: sign in by running "claude" and using /login in a terminal, or supply ANTHROPIC_API_KEY through this provider\'s env.'

/** Assistant-message errors meaning the credential or account cannot be used. */
const AUTHENTICATION_ASSISTANT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
])

/** Result HTTP statuses meaning the credential was rejected or forbidden. */
const AUTHENTICATION_API_STATUSES: ReadonlySet<number | null | undefined> = new Set([401, 403])

function failureDiagnostic(facts: ClaudeCodeFailureFacts): string {
  const fields = [
    'product: Claude Code',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const exitCode = facts.outcome?.exitCode
  if (exitCode !== null && exitCode !== undefined) {
    fields.push(`exit code: ${exitCode}`)
  }
  const signal = facts.outcome?.signal
  if (signal !== null && signal !== undefined) {
    fields.push(`signal: ${signal}`)
  }
  const summary = `Product subagent failure (${fields.join('; ')})`
  return facts.category === 'authentication'
    ? `${summary}. ${AUTHENTICATION_HINT}`
    : summary
}

class ClaudeCodeFailure extends Error {
  constructor(
    readonly facts: ClaudeCodeFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-claude-code: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ClaudeCodeFailure'
  }
}

function sdkFailureCategory(
  subtype: string,
): ClaudeCodeFailureCategory {
  switch (subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return 'limit'
    case 'error_during_execution':
      return 'product-error'
    default:
      return 'unknown'
  }
}

/**
 * Hide an unpublished product startup failure behind fixed safe facts.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export function claudeCodeStartupFailure(cause: unknown): Error {
  return new ClaudeCodeFailure({
    stage: 'query-start',
    category: 'unknown',
  }, cause)
}

function unattendedDiagnostic(
  mode: ClaudeCodePermissionMode,
  request: 'tool permission' | 'MCP elicitation' | 'user dialog',
  decision: 'denied' | 'declined' | 'cancelled',
  reason: string,
): string {
  return `Claude Code unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`
}

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Selected child working directory supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Profile-selected native model; omitted to preserve Claude settings. */
  readonly model?: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: ClaudeCodePermissionMode
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Wall-clock limit for one run in milliseconds; omitted for no limit. */
  readonly timeoutMs?: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Host diagnostic sink for a product failure kept outside model-visible text. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/** Read live request cancellation across awaited startup cleanup. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/* jscpd:ignore-end */

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @param authenticationFailed - whether an earlier assistant message reported an
 * authentication or account error; it classifies a failed result but never
 * overrides a genuine success or an SDK limit.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(
  message: SDKResultMessage,
  authenticationFailed: boolean,
): string {
  if (message.subtype !== 'success') {
    const sdkCategory = sdkFailureCategory(message.subtype)
    const category = authenticationFailed && sdkCategory !== 'limit'
      ? 'authentication'
      : sdkCategory
    const detail = sdkCategory === 'unknown'
      ? undefined
      : message.errors.join('; ')
    throw new ClaudeCodeFailure(
      { stage: 'query-run', category },
      detail === undefined || detail.length === 0
        ? undefined
        : new Error(detail),
    )
  }
  if (message.is_error || message.result.trim().length === 0) {
    const rejected = authenticationFailed
      || AUTHENTICATION_API_STATUSES.has(message.api_error_status)
    throw new ClaudeCodeFailure({
      stage: 'query-run',
      category: rejected ? 'authentication' : 'invalid-result',
    }, rejected && message.is_error ? new Error(message.result) : undefined)
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @param onPermissionDenied - records a safe fact when the SDK reports native denial.
 * @param onResult - records that the SDK supplied a terminal result message.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
  onPermissionDenied?: () => void,
  onResult?: () => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  let authenticationFailed = false
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      onPermissionDenied?.()
      continue
    }
    if (message.type === 'assistant') {
      authenticationFailed ||= message.error !== undefined
        && AUTHENTICATION_ASSISTANT_ERRORS.has(message.error)
      continue
    }
    if (message.type !== 'result') continue
    onResult?.()
    answer = successfulResult(message, authenticationFailed)
  }
  if (answer === undefined) {
    throw new ClaudeCodeFailure({
      stage: 'query-run',
      category: authenticationFailed ? 'authentication' : 'invalid-result',
    })
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI managed range, including
 * a published handle whose direct result later rejects.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (firstFailure !== undefined) {
    const facts = {
      stage: 'teardown',
      category: 'unknown',
      outcome,
    } as const
    const cause = failures.length === 1
      ? firstFailure
      : new AggregateError(failures, 'Claude Code teardown failures')
    throw new ClaudeCodeFailure(facts, cause)
  }
  await child.done.catch(() => {})
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the shared child and SDK-facing process synchronously.
 * @param captureDiagnostic - receives safe facts from unattended interaction callbacks.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (
    child: SubprocessHandle,
    process: ManagedClaudeCodeProcess,
  ) => void,
  captureDiagnostic: (diagnostic: string) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    ...spec.model === undefined ? {} : { model: spec.model },
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: spec.permissionMode === 'plan'
      ? ['AskUserQuestion', 'ExitPlanMode']
      : ['AskUserQuestion'],
    permissionMode: spec.permissionMode,
    ...spec.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {
        canUseTool: () => {
          captureDiagnostic(unattendedDiagnostic(
            spec.permissionMode,
            'tool permission',
            'denied',
            'the provider does not request human approval',
          ))
          return Promise.resolve({
            behavior: 'deny' as const,
            message: 'This unattended Claude Code subagent cannot request human approval.',
          })
        },
      },
    onElicitation: () => {
      captureDiagnostic(unattendedDiagnostic(
        spec.permissionMode,
        'MCP elicitation',
        'declined',
        'the provider does not collect interactive MCP input',
      ))
      return Promise.resolve({ action: 'decline' })
    },
    onUserDialog: () => {
      captureDiagnostic(unattendedDiagnostic(
        spec.permissionMode,
        'user dialog',
        'cancelled',
        'the provider does not render blocking dialogs',
      ))
      return Promise.resolve({ behavior: 'cancelled' as const })
    },
    supportedDialogKinds: SUPPORTED_UNATTENDED_DIALOG_KINDS,
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      const process = new ManagedClaudeCodeProcess(child)
      capture(child, process)
      return process
    },
  }
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * When `spec.timeoutMs` is set, the run is cancelled at expiry and settles as a
 * `timeout` error rather than `aborted`.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and the real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  let limit: Deadline | undefined
  const stopDeadline = (): void => {
    const armed = limit
    limit = undefined
    armed?.[Symbol.dispose]()
  }
  const requestCancel = (): void => {
    stopDeadline()
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const reportFailure = (error: Error): void => {
    try {
      spec.onError?.(error, 'error')
    } catch {
      // Host diagnostic logging cannot replace the product failure.
    }
  }

  let child: SubprocessHandle | undefined
  let childFailure: Error | undefined
  let childProcessFailure: Promise<never> | undefined
  let query: Query | undefined
  let managedProcess: ManagedClaudeCodeProcess | undefined
  let diagnostic: string | undefined
  const capturePermissionDiagnostic = (value: string): void => {
    diagnostic = value
  }
  const prependFailureDiagnostic = (facts: ClaudeCodeFailureFacts): void => {
    const failure = failureDiagnostic(facts)
    diagnostic = diagnostic === undefined
      ? failure
      : `${failure}\n${diagnostic}`
  }
  const captureChild = (
    captured: SubprocessHandle,
    process: ManagedClaudeCodeProcess,
  ): void => {
    child = captured
    managedProcess = process
    childProcessFailure = captured.done.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => {
        childFailure = thrown(error)
        throw childFailure
      },
    )
    void childProcessFailure.catch(() => {})
  }
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(
        spec,
        controller,
        captureChild,
        capturePermissionDiagnostic,
      ),
    })
    if (child === undefined || childProcessFailure === undefined) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (isAborted(controller.signal)) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    // Let child.done publish a concurrently observed exit before classification.
    await Promise.resolve()
    const startupOutcome = managedProcess?.outcome
    const startupFacts = {
      stage: 'query-start',
      category: 'unknown',
      outcome: startupOutcome,
    } as const
    const startupFailure = (cause: unknown = childFailure ?? error): ClaudeCodeFailure => new ClaudeCodeFailure(
      startupFacts,
      thrown(cause),
    )
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        const failure = startupFailure()
        const cleanupFailure = thrown(disposeError)
        const aggregate = new AggregateError(
          [failure, cleanupFailure],
          `${failure.message}; ${cleanupFailure.message}`,
        )
        reportFailure(aggregate)
        throw aggregate
      }
      if (cancelledBeforeCleanup || isAborted(request.signal)) {
        throw new Error('subagent-claude-code: request was aborted before SDK startup')
      }
      const failure = startupFailure()
      reportFailure(failure)
      throw failure
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        const failure = startupFailure()
        const cleanupFailure = new ClaudeCodeFailure({
          stage: 'teardown',
          category: 'unknown',
        }, thrown(disposeError))
        const aggregate = new AggregateError(
          [failure, cleanupFailure],
          `${failure.message}; ${cleanupFailure.message}`,
        )
        reportFailure(aggregate)
        throw aggregate
      }
    }
    if (cancelledBeforeCleanup || isAborted(request.signal)) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    const failure = startupFailure()
    reportFailure(failure)
    throw failure
  }

  const publishedQuery = query
  const publishedChild = child
  const publishedProcessFailure = childProcessFailure
  let receivedResult = false
  let timedOut = false
  const expiry = spec.timeoutMs === undefined
    ? undefined
    : deadline(request.signal, spec.timeoutMs, CLAUDE_CODE_RUN_TIMEOUT)
  limit = expiry
  // Rejects at expiry even when the SDK ignores cancellation; the first cause wins.
  const expired = new Promise<never>((_resolve, reject) => {
    expiry?.signal.addEventListener('abort', () => {
      if (timeoutOf(expiry.signal, CLAUDE_CODE_RUN_TIMEOUT) === undefined) return
      timedOut = true
      reject(new ClaudeCodeFailure({ stage: 'query-run', category: 'timeout' }))
      requestCancel()
    }, { once: true })
  })
  void expired.catch(() => {})
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await Promise.race([
          consumeClaudeQuery(publishedQuery, () => {
            capturePermissionDiagnostic(unattendedDiagnostic(
              spec.permissionMode,
              'tool permission',
              'denied',
              'Claude Code denied the request before an interactive prompt',
            ))
          }, () => {
            receivedResult = true
            stopDeadline()
          }),
          publishedProcessFailure,
          expired,
        ])
      } catch (error: unknown) {
        const processOutcome = managedProcess?.outcome
        let facts: ClaudeCodeFailureFacts
        if (error instanceof ClaudeCodeFailure) {
          facts = { ...error.facts, outcome: processOutcome }
        } else if (processOutcome !== undefined && !receivedResult) {
          facts = {
            stage: 'process',
            category: 'process',
            outcome: processOutcome,
          }
        } else {
          facts = {
            stage: 'query-run',
            category: 'unknown',
            outcome: processOutcome,
          }
        }
        prependFailureDiagnostic(facts)
        // Keep the SDK category and cause; the diagnostic adds later process facts.
        throw error instanceof ClaudeCodeFailure
          ? error
          : new ClaudeCodeFailure(facts, thrown(error))
      } finally {
        stopDeadline()
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted && !timedOut,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        await disposeClaudeCodeChild(publishedQuery, publishedChild)
      } catch (error: unknown) {
        const failure = thrown(error)
        reportFailure(failure)
        throw failure
      }
    },
  })
}
