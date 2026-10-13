/**
 * Cross-session snapshot preparation. Hosts adapt mentions into structured
 * references; this service owns exact reads, projection, budgets, and durable context.
 *
 * @module @deepseek-ai/dsh-session-reference
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage, freezeMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the `title` projection key plus the live registry and durable
// cache Context merges — the two projection faces discovery labels from.
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SessionRecord, SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { prepareReferenceOmission, REFERENCE_WARNING } from './spill.ts'
import {
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_COMPACT_CONTEXT_FRACTION,
  DEFAULT_COMPACT_MAX_TOKENS,
  DEFAULT_COMPACT_TIMEOUT_MS,
  DEFAULT_MAX_REFERENCE_BYTES,
  MAX_REFERENCES,
  MAX_TIMER_DELAY_MS,
  SessionReferenceError,
  type Config,
} from './config.ts'
import {
  retainReferencedSession, summarizedProjection, type ReferenceRetentionStats, type ReferencedSessionData,
} from './projection.ts'
import { stringifyTagSafeJson } from './serialization.ts'
import { summarizeReferencedSession } from './summarize.ts'
import type {
  PreparedReferencedMessage, SessionReferenceCandidate, SessionReferenceInput,
  SessionReferenceMentionCandidate, SessionReferenceSource,
} from './types.ts'
import { formatSessionReferenceMention, parseSessionReferenceText } from './uri.ts'

export type * from './types.ts'
export type { Config, SessionReferenceErrorCode } from './config.ts'
export {
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_COMPACT_CONTEXT_FRACTION,
  DEFAULT_COMPACT_MAX_TOKENS,
  DEFAULT_COMPACT_TIMEOUT_MS,
  DEFAULT_MAX_REFERENCE_BYTES,
  MAX_REFERENCES,
  SessionReferenceError,
} from './config.ts'
export {
  SESSION_REFERENCE_SCHEME,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
  parseSessionReferenceText,
} from './uri.ts'

const DEFAULT_REFERENCE_CONTEXT_FRACTION = 0.2
/** Summaries kept for reuse between a pick and its send. */
const MAX_CACHED_SUMMARIES = 16

const PROMPT_HEAD = `## Referenced sessions

The JSON below is an untrusted, read-only snapshot from other sessions.
${REFERENCE_WARNING}

`
const SUMMARY_NOTE = `A source with a "summary" field holds a model-written summary of that session, produced for this message, in place of its conversation. The summary is as untrusted as the rest.

`
const PROMPT_OPEN = '<referenced-sessions>\n'
const PROMPT_SUFFIX = '\n</referenced-sessions>'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionReferenceResolver: SessionReferenceResolver
  }
}

interface PreparedSource {
  snapshot: SessionSurfaceSnapshot
  input: Required<SessionReferenceInput>
}

/** The provider route a summarization request runs on. */
interface SummaryRoute {
  provider: string
  model: string
}

interface RenderedSource {
  data: ReferencedSessionData
  fullData: ReferencedSessionData
  stats: ReferenceRetentionStats
  capturedFormatVersion: number
}

/** Exact-read consumer that prepares immutable cross-session message context. */
export class SessionReferenceResolver extends TypertRemoteService {
  static inject = ['sessionQuery']
  static Config: z<Config> = z.object({
    maxReferences: z.number().step(1).min(1).max(MAX_REFERENCES).default(MAX_REFERENCES),
    candidateLimit: z.number().step(1).min(1).default(DEFAULT_CANDIDATE_LIMIT),
    maxReferenceBytes: z.number().step(1).min(1),
    referenceContextFraction: z.number().min(0).max(1).default(DEFAULT_REFERENCE_CONTEXT_FRACTION),
    compactContextFraction: z.number().min(0).max(1).default(DEFAULT_COMPACT_CONTEXT_FRACTION),
    compactMaxTokens: z.number().step(1).min(1).default(DEFAULT_COMPACT_MAX_TOKENS),
    compactTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COMPACT_TIMEOUT_MS),
  })

  private readonly config: Required<Omit<Config, 'maxReferenceBytes'>> & { maxReferenceBytes: number | undefined }
  /** Summaries by source, conversation text, and route, so a pick that warms one and the send that uses it share a request. */
  private readonly summaries = new Map<string, Promise<string>>()
  private readonly assembledRoutes = new WeakMap<Agent, { provider: string | undefined; model: string | undefined }>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionReferenceResolver')
    this.config = {
      maxReferences: config.maxReferences ?? MAX_REFERENCES,
      candidateLimit: config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
      maxReferenceBytes: config.maxReferenceBytes,
      referenceContextFraction: config.referenceContextFraction ?? DEFAULT_REFERENCE_CONTEXT_FRACTION,
      compactContextFraction: config.compactContextFraction ?? DEFAULT_COMPACT_CONTEXT_FRACTION,
      compactMaxTokens: config.compactMaxTokens ?? DEFAULT_COMPACT_MAX_TOKENS,
      compactTimeoutMs: config.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS,
    }
    for (const name of ['maxReferences', 'candidateLimit', 'maxReferenceBytes', 'compactMaxTokens', 'compactTimeoutMs'] as const) {
      const value = this.config[name]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new SessionReferenceError(
          `session-reference: ${name} must be a positive safe integer`,
          'SESSION_REFERENCE_INVALID_CONFIG',
        )
      }
    }
    if (this.config.maxReferences > MAX_REFERENCES) {
      throw new SessionReferenceError(
        `session-reference: maxReferences must not exceed ${MAX_REFERENCES}`,
        'SESSION_REFERENCE_INVALID_CONFIG',
      )
    }
    if (this.config.compactTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new SessionReferenceError(
        `session-reference: compactTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`,
        'SESSION_REFERENCE_INVALID_CONFIG',
      )
    }
    for (const name of ['referenceContextFraction', 'compactContextFraction'] as const) {
      if (!(this.config[name] >= 0 && this.config[name] <= 1)) {
        throw new SessionReferenceError(
          `session-reference: ${name} must be between zero and one`,
          'SESSION_REFERENCE_INVALID_CONFIG',
        )
      }
    }
    // Prepend observes model-selection overrides after downstream assembly completes.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      if (context.agent !== undefined) {
        const { provider, model } = assembly.variables
        this.assembledRoutes.set(context.agent, { provider, model })
      }
      return assembly
    }, { prepend: true })
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: await this.prepareDirectMessages(agent, decision.messages, signal),
      }
    }, { prepend: true })
  }

  /**
   * Replace canonical mentions in direct user messages and place each prepared
   * snapshot immediately after the message that cited it.
   * @param agent - agent entering the model step.
   * @param messages - messages accepted by downstream pre-step listeners.
   * @param signal - active turn cancellation.
   * @returns direct messages followed by their session-reference context in citation order.
   */
  private async prepareDirectMessages(
    agent: Agent,
    messages: readonly UserMessage[],
    signal: AbortSignal,
  ): Promise<UserMessage[]> {
    const prepared = await Promise.all(messages.map(async (message): Promise<UserMessage[]> => {
      if (message.source.kind !== 'user') return [message]
      const references: SessionReferenceInput[] = []
      const content = message.content.map((block): ContentBlock => {
        if (block.type !== 'text') return block
        const parsed = parseSessionReferenceText(block.text)
        references.push(...parsed.references)
        return { type: 'text', text: parsed.text }
      })
      if (references.length === 0) return [message]
      const resolved = await this.prepare(agent, content, references, signal)
      const direct = freezeMessage({ ...message, content: resolved.content })
      /* v8 ignore if -- a parsed canonical mention always leaves one normalized reference */
      if (resolved.additionalContext === undefined) {
        throw new Error('session-reference preparation omitted context for a canonical mention')
      }
      return [direct, resolved.additionalContext]
    }))
    return prepared.flat()
  }

  /**
   * List reference candidates, ranked by working-directory affinity.
   *
   * Discovery runs at keystroke rate, so titles and subagent labels only ever
   * come from projection reads; sessions without either fall back to their id.
   * @param agent - target agent; self is excluded and its cwd drives ranking.
   * @param query - optional case-insensitive session-id/cwd/title/display-title substring.
   * @param limit - optional positive result cap.
   * @param signal - optional cancellation boundary for host autocomplete teardown.
   * @returns candidates with canonical mention labels and presentation titles.
   */
  async listCandidates(
    agent: Agent,
    query: string = '',
    limit: number = this.config.candidateLimit,
    signal?: AbortSignal,
  ): Promise<SessionReferenceCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new SessionReferenceError('candidate limit must be a positive safe integer', 'SESSION_REFERENCE_INVALID_REFERENCE')
    }
    const needle = query.toLocaleLowerCase()
    const targetCwd = agent.session.header.cwd
    assertNotCancelled(signal)
    const records = (await settleWithCancellation(this.ctx.sessionQuery.listSessions(signal), signal))
      .filter(record => record.header.id !== agent.id)
      .map((record, index) => ({ record, index }))
    const labelled = records.map(({ record, index }) => ({ record, index, ...this.projectedLabels(record) }))
    return labelled.filter(({ record, label, displayTitle }) => {
      if (needle === '') return true
      return record.header.id.toLocaleLowerCase().includes(needle)
        || record.header.cwd?.toLocaleLowerCase().includes(needle) === true
        || label.toLocaleLowerCase().includes(needle)
        || displayTitle.toLocaleLowerCase().includes(needle)
    }).sort((a, b) => candidateRank(a.record.header.cwd, targetCwd) - candidateRank(b.record.header.cwd, targetCwd)
      || a.index - b.index)
      .slice(0, limit)
      .map(({ record, label, displayTitle }) => ({
        sessionId: record.header.id,
        label,
        displayTitle,
        ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
        sameWorkspace: record.header.cwd !== undefined && record.header.cwd === targetCwd,
        createdAt: record.header.createdAt,
      }))
  }

  /**
   * The mention label and display title a Session's projections can answer without reading its log.
   *
   * Attachment is decided by the store at read time, not by the listing:
   * a session that attached in between would otherwise be answered from a
   * checkpoint its live log has already moved past.
   *
   * An attached session answers from its live registry cut, which advances
   * with every committed event, so a rename or a just-generated title is
   * visible immediately; its events are already in memory, so the lazy fold
   * costs no I/O. A cold session answers from the durable checkpoint the
   * projection cache wrote when it went cold.
   *
   * Nothing else is attempted. Folding a title from a log costs the whole
   * log, and this call sits under every keystroke of `@` completion. A
   * session that no projection can answer for — one persisted before the
   * cache was composed — is labeled by its id and cannot be found by its
   * title until it is opened once, which checkpoints it.
   * @param record - the listed session, live or cold.
   * @returns the title-backed mention label and the subagent-label-first display title.
   */
  private projectedLabels(record: SessionRecord): { label: string; displayTitle: string } {
    const attached = this.ctx.get('sessions')?.get(record.header.id)
    const projections = this.ctx.get('sessionProjections')
    const snapshot = attached !== undefined && projections !== undefined
      ? projections.snapshot(attached, ['title', 'subagent'])
      : this.ctx.get('sessionProjectionCache')?.cachedSnapshot(record.header, ['title', 'subagent'])
    const label = titleOf(snapshot) ?? record.header.id
    const subagent = snapshot?.values.subagent
    return {
      label,
      displayTitle: subagent === undefined || subagent === null
        ? label
        : subagent.label ?? label,
    }
  }

  /**
   * Remote face of {@link listCandidates}: the configured candidate limit
   * applies, and every candidate carries the canonical mention a host inserts
   * into the prompt draft.
   * @param agent - target agent; self is excluded and its cwd drives ranking.
   * @param query - optional case-insensitive session-id/cwd/title substring.
   * @param signal - caller cancellation.
   * @returns mention-carrying candidates in rank order.
   */
  @Remote('candidates')
  async remoteExportCandidates(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<SessionReferenceMentionCandidate[]> {
    const candidates = await this.listCandidates(agent, query, this.config.candidateLimit, signal)
    return candidates.map(candidate => ({
      ...candidate,
      mention: formatSessionReferenceMention({
        sessionId: candidate.sessionId,
        label: candidate.displayTitle ?? candidate.label,
      }),
      compactMention: formatSessionReferenceMention({
        sessionId: candidate.sessionId,
        label: candidate.displayTitle ?? candidate.label,
        compact: true,
      }),
    }))
  }

  /**
   * Snapshot all references for one accepted direct message and return one aggregated durable context.
   * Automatic budgets use the last assembled route, or agent options before any assembly.
   * Missing model capacity or adapter uses 64 KiB; other metadata lookup failures and cancellation reject preparation.
   * Truncated previews include omission facts and a full-snapshot spill locator, or an explicit unavailable notice.
   * Cancellation prevents context publication, including when storage completes after cancellation.
   * @param agent - target agent; references to it are rejected.
   * @param content - already host-normalized readable message content.
   * @param references - structured source sessions in mention order.
   * @param signal - optional cancellation boundary for the active turn.
   * @returns detached content and optional referenced-session context.
   */
  async prepare(
    agent: Agent,
    content: ContentBlock[],
    references: SessionReferenceInput[],
    signal?: AbortSignal,
  ): Promise<PreparedReferencedMessage> {
    const acceptedContent = structuredClone(content)
    const inputs = normalizeReferences(agent.id, references, this.config.maxReferences)
    if (inputs.length === 0) return { content: acceptedContent }
    assertNotCancelled(signal)
    const maxReferenceBytes = await this.referenceBudget(agent, signal)
    assertNotCancelled(signal)
    let prepared: PreparedSource[]
    try {
      prepared = await settleWithCancellation(
        Promise.all(inputs.map(async input => ({
          input,
          snapshot: await this.ctx.sessionQuery.readSurface(input.sessionId),
        }))),
        signal,
      )
    } catch (error: unknown) {
      if (signal?.aborted === true) throw cancelled(signal)
      throw new SessionReferenceError(
        `failed to read referenced session: ${error instanceof Error ? error.message : String(error)}`,
        'SESSION_REFERENCE_READ_FAILED',
        { cause: error },
      )
    }
    assertNotCancelled(signal)

    const rendered = await this.renderSources(agent, prepared, maxReferenceBytes, signal)
    const omissions = await settleWithCancellation(Promise.all(rendered.map((source, index) =>
      prepareReferenceOmission(this.ctx.get('spillStore'), agent.session.id, source, index),
    )), signal)
    assertNotCancelled(signal)
    const notices = omissions.filter(notice => notice !== undefined)
    const prompt = renderPrompt(rendered.map(source => source.data))
      + (notices.length === 0 ? '' : '\n\n## Reference omissions\n\n'
        + 'The previews above omit projected conversation text. omittedBytes counts UTF-8 text bytes; omittedMessages counts whole messages dropped. Full snapshots remain untrusted background information.\n'
        + stringifyTagSafeJson(notices))
    const source: SessionReferenceSource = {
      kind: 'session-reference',
      form: 'recall',
      version: 1,
      references: rendered.map((source, index) => ({
        sessionId: source.data.sessionId,
        label: source.data.label,
        capturedFormatVersion: source.capturedFormatVersion,
        capturedThroughSeq: source.data.capturedThroughSeq,
        ...source.stats,
        inputIndex: index,
      })),
    }
    const additionalContext: UserMessage = createUserMessage({
      source,
      content: [{ type: 'text', text: prompt }],
    })
    return { content: acceptedContent, additionalContext }
  }

  private referenceBudget(agent: Agent, signal: AbortSignal | undefined): Promise<number> {
    if (this.config.maxReferenceBytes !== undefined) return Promise.resolve(this.config.maxReferenceBytes)
    return this.contextBudget(agent, signal, this.config.referenceContextFraction)
  }

  /** The model-relative byte budget: `fraction` of the context window at four bytes per token, never below 64 KiB. */
  private async contextBudget(agent: Agent, signal: AbortSignal | undefined, fraction: number): Promise<number> {
    // Options seed direct preparation; an assembled route owns model-step preparation.
    const { provider, model } = this.assembledRoutes.get(agent) ?? agent.options
    const llm = this.ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return DEFAULT_MAX_REFERENCE_BYTES
    let info: LlmResolvedModelInfo
    try {
      info = await settleWithCancellation(llm.resolveModelInfo(provider, model, signal), signal)
    } catch (error: unknown) {
      // Stream middleware can serve routes without a registered adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      return DEFAULT_MAX_REFERENCE_BYTES
    }
    if (info.context === undefined) return DEFAULT_MAX_REFERENCE_BYTES
    // Context capacity is in tokens; four bytes/token is a sizing heuristic, not token counting.
    return Math.max(DEFAULT_MAX_REFERENCE_BYTES, Math.floor(info.context.contextWindow * 4 * fraction))
  }

  /**
   * The route a summarization request runs on: the target's assembled route, else its options, else
   * its latest logged request header, so the summary is written by the model the target converses with.
   */
  private summaryRoute(agent: Agent): SummaryRoute | undefined {
    const candidates = [this.assembledRoutes.get(agent), agent.options, agent.session.requestHeader()?.config]
    for (const { provider, model } of candidates.flatMap(candidate => candidate === undefined ? [] : [candidate])) {
      if (provider !== undefined && provider !== '' && model !== undefined && model !== '') return { provider, model }
    }
    return undefined
  }

  /** Summarize one `#` source with a separate request; the source session is only read. */
  private async renderSummarized(
    agent: Agent,
    source: PreparedSource,
    signal: AbortSignal | undefined,
  ): Promise<RenderedSource> {
    const capturedFormatVersion = source.snapshot.session.version
    const inputBytes = await this.contextBudget(agent, signal, this.config.compactContextFraction)
    const retained = retainReferencedSession(source.snapshot, source.input.label, inputBytes)
    if (retained === undefined) {
      throw new SessionReferenceError(
        'referenced session snapshot cannot fit the summarization input budget',
        'SESSION_REFERENCE_BUDGET_EXCEEDED',
      )
    }
    // A session with no conversation has nothing to summarize.
    if (retained.fullData.conversation.length === 0) return { ...retained, capturedFormatVersion }
    const summary = await settleWithCancellation(this.summaryOf(agent, retained.data), signal)
    return { ...summarizedProjection(retained, summary), capturedFormatVersion }
  }

  /**
   * The summary of one captured projection, written once per source, conversation text, and route.
   * A failed request is forgotten so the next call asks again.
   */
  private summaryOf(agent: Agent, data: ReferencedSessionData): Promise<string> {
    const llm = this.ctx.get('llm')
    const route = this.summaryRoute(agent)
    if (llm === undefined || route === undefined) {
      return Promise.reject(new SessionReferenceError(
        'session summarization needs a model service and a provider route for the target session',
        'SESSION_REFERENCE_COMPACT_FAILED',
      ))
    }
    // Keyed by what the summary is written from: events that add no conversation text (a title) must not miss.
    const text = createHash('sha256').update(JSON.stringify(data.conversation)).digest('hex')
    const key = `${data.sessionId}\0${text}\0${route.provider}\0${route.model}`
    let pending = this.summaries.get(key)
    if (pending === undefined) {
      pending = summarizeReferencedSession(llm, {
        ...route, maxTokens: this.config.compactMaxTokens, timeoutMs: this.config.compactTimeoutMs,
      }, agent.session.id, data)
      this.summaries.set(key, pending)
      pending.catch(() => { this.summaries.delete(key) })
      // Bounded to the few summaries a composer can have in flight.
      if (this.summaries.size > MAX_CACHED_SUMMARIES) this.summaries.delete(this.summaries.keys().next().value as string)
    }
    return pending
  }

  /**
   * Remote face that writes a `#` source's summary ahead of the send, so picking the session starts the
   * work and sending reuses its result. The source is read, never written.
   * @param agent - the composer's session; references to it are rejected.
   * @param sessionId - the source session to summarize.
   * @param signal - caller cancellation; the shared request keeps running for the send that follows.
   * @returns once the summary is ready.
   */
  @Remote('summarize')
  async remoteSummarize(agent: Agent, sessionId: SessionId, signal: AbortSignal): Promise<void> {
    // One reference never empties: self-reference throws, and there is nothing to deduplicate.
    const inputs = normalizeReferences(agent.id, [{ sessionId, compact: true }], this.config.maxReferences)
    const [input] = inputs as [Required<SessionReferenceInput>]
    const snapshot = await settleWithCancellation(this.ctx.sessionQuery.readSurface(input.sessionId), signal)
    await this.renderSummarized(agent, { snapshot, input }, signal)
  }

  private renderSources(
    agent: Agent,
    sources: readonly PreparedSource[],
    maxReferenceBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<RenderedSource[]> {
    return Promise.all(sources.map(async (source): Promise<RenderedSource> => {
      if (source.input.compact) return this.renderSummarized(agent, source, signal)
      const retained = retainReferencedSession(source.snapshot, source.input.label, maxReferenceBytes)
      if (retained === undefined) {
        throw new SessionReferenceError(
          'referenced session snapshot cannot fit the configured byte budget',
          'SESSION_REFERENCE_BUDGET_EXCEEDED',
        )
      }
      return { ...retained, capturedFormatVersion: source.snapshot.session.version }
    }))
  }
}

function normalizeReferences(
  targetId: SessionId,
  references: readonly SessionReferenceInput[],
  maxReferences: number,
): Required<SessionReferenceInput>[] {
  const seen = new Set<SessionId>()
  const normalized: Required<SessionReferenceInput>[] = []
  for (const candidate of references as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new SessionReferenceError('session reference must be an object', 'SESSION_REFERENCE_INVALID_REFERENCE')
    }
    const reference = candidate as SessionReferenceInput
    if (
      typeof reference.sessionId !== 'string' || (reference.label !== undefined && typeof reference.label !== 'string')
      || (reference.compact !== undefined && typeof reference.compact !== 'boolean')
    ) {
      throw new SessionReferenceError(
        'session reference must contain a string sessionId, an optional string label, and an optional boolean compact',
        'SESSION_REFERENCE_INVALID_REFERENCE',
      )
    }
    if (reference.sessionId === targetId) {
      throw new SessionReferenceError(`session ${JSON.stringify(targetId)} cannot reference itself`, 'SESSION_REFERENCE_SELF_REFERENCE')
    }
    if (seen.has(reference.sessionId)) continue
    seen.add(reference.sessionId)
    normalized.push({ sessionId: reference.sessionId, label: reference.label ?? reference.sessionId, compact: reference.compact === true })
  }
  if (normalized.length > maxReferences) {
    throw new SessionReferenceError(
      `a message may reference at most ${maxReferences} sessions`,
      'SESSION_REFERENCE_TOO_MANY',
    )
  }
  return normalized
}

function renderPrompt(data: readonly ReferencedSessionData[]): string {
  const note = data.some(source => source.summary !== undefined) ? SUMMARY_NOTE : ''
  return `${PROMPT_HEAD}${note}${PROMPT_OPEN}${stringifyTagSafeJson(data)}${PROMPT_SUFFIX}`
}

/** The title in one projection snapshot; undefined when the unit is absent or still untitled. */
function titleOf(snapshot: ProjectionSnapshot | undefined): string | undefined {
  const title = snapshot?.values.title
  return title === undefined || title === null ? undefined : title
}

function candidateRank(candidateCwd: string | undefined, targetCwd: string | undefined): number {
  if (candidateCwd !== undefined && targetCwd !== undefined && candidateCwd === targetCwd) return 0
  if (candidateCwd === undefined) return 1
  return 2
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled(signal)
}

function settleWithCancellation<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(cancelled(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
    if (signal.aborted) onAbort()
  })
}

function cancelled(signal: AbortSignal): SessionReferenceError {
  return new SessionReferenceError('session reference preparation was cancelled', 'SESSION_REFERENCE_CANCELLED', { cause: signal.reason })
}

export default SessionReferenceResolver
