/**
 * The `contextDrift` projection unit: a pure fold of the durable log into a
 * ledger of the retained model-visible surface (tokens, role, topic, and
 * mistake marks per node) plus route and usage anchors, scored by
 * {@link scoreDrift} in the wire view.
 *
 * Replacements splice the ledger exactly as the surface does, so compaction
 * and tool-result pruning remove the shadowed nodes' turns, mistakes, and
 * tokens. The fold never throws: an unresolvable replacement range marks the
 * state `degraded` and appends instead, because a throwing unit would stop
 * every projection of the session.
 *
 * @module @deepseek-ai/dsh-context-drift/projection
 */

import { z } from 'zod'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ResolvedContextDriftConfig, ResolvedFoldConfig } from './config.ts'
import { scoreDrift } from './score.ts'
import type { DriftInputs } from './score.ts'
import { extractKeywords, isCorrection, keywordOverlap, mergeKeywords } from './text.ts'
import type { ContextDriftProjection } from './types.ts'

/** Bumped whenever the fold semantics or state fields change. */
const FOLD_VERSION = 1

/** Tool-call argument characters scanned for paths; keeps one large write from dominating fold time. */
const TOOL_ARGUMENT_SCAN_CHARS = 8_192

const NODE_KINDS = ['system', 'human', 'injected', 'assistant', 'tool', 'tool-error', 'checkpoint', 'loop'] as const
type NodeKind = typeof NODE_KINDS[number]

const count = z.number().int().nonnegative()

const nodeSchema = z.object({
  seq: count,
  tokens: count,
  kind: z.enum(NODE_KINDS),
  topic: count,
  correction: z.literal(true).optional(),
  interrupted: z.literal(true).optional(),
}).strict()
type DriftNode = z.infer<typeof nodeSchema>

const baselineSchema = z.object({
  kind: z.enum(['session-start', 'compaction']),
  seq: count,
  time: z.number().nonnegative(),
}).strict()

const contextDriftStateSchema = z.object({
  nodes: z.array(nodeSchema),
  surfaceTokens: count,
  toolsTokens: count,
  topic: count,
  topicKeywords: z.array(z.string()),
  awaitingHuman: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: count.optional(),
  sampledSurfaceTokens: count.optional(),
  compactions: count,
  baseline: baselineSchema,
  degraded: z.literal(true).optional(),
}).strict()
type ContextDriftState = z.infer<typeof contextDriftStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextDrift: ContextDriftState
  }
}

const signalRecord = z.object({
  length: count,
  turns: count,
  mistakes: count,
  stale: count,
  noise: count,
  layers: count,
}).strict()

const signalEnum = z.enum(['length', 'turns', 'mistakes', 'stale', 'noise', 'layers'])

/** Wire validation of {@link ContextDriftProjection}. */
const viewSchema: z.ZodType<ContextDriftProjection> = z.object({
  score: z.number().int().min(0).max(100),
  level: z.enum(['fresh', 'drifting', 'high']),
  cause: signalEnum.optional(),
  action: z.enum(['none', 'compact', 'new-chat']),
  actionReason: z.enum(['layers', 'stale', 'recent-compaction', 'cause']).optional(),
  shares: signalRecord,
  readings: z.object({
    liveTokens: count,
    effectiveTokens: z.number().int().positive(),
    contextWindow: z.number().int().positive().optional(),
    turns: count,
    toolErrors: count,
    corrections: count,
    loopWarnings: count,
    interrupts: count,
    stalePercent: z.number().int().min(0).max(100),
    toolOutputPercent: z.number().int().min(0).max(100),
    compactions: count,
  }).strict(),
  baseline: baselineSchema,
  thresholds: z.object({
    drifting: z.number().min(0).max(100),
    high: z.number().min(0).max(100),
    rearm: z.number().min(0).max(100),
  }).strict(),
  degraded: z.literal(true).optional(),
}).strict().transform(({ cause, actionReason, degraded, readings, ...rest }) => ({
  ...rest,
  ...cause === undefined ? {} : { cause },
  ...actionReason === undefined ? {} : { actionReason },
  readings: {
    liveTokens: readings.liveTokens,
    effectiveTokens: readings.effectiveTokens,
    ...readings.contextWindow === undefined ? {} : { contextWindow: readings.contextWindow },
    turns: readings.turns,
    toolErrors: readings.toolErrors,
    corrections: readings.corrections,
    loopWarnings: readings.loopWarnings,
    interrupts: readings.interrupts,
    stalePercent: readings.stalePercent,
    toolOutputPercent: readings.toolOutputPercent,
    compactions: readings.compactions,
  },
  ...degraded === undefined ? {} : { degraded },
}))

/**
 * 32-bit FNV-1a hash, used to key the state version to the fold configuration.
 * @param text - text to hash.
 * @returns unsigned 32-bit hash.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * State version for one fold configuration: a fold-semantics change or a
 * fold-configuration change both invalidate persisted checkpoints.
 * @param fold - resolved fold configuration.
 * @returns non-negative safe-integer state version.
 */
export function contextDriftStateVersion(fold: ResolvedFoldConfig): number {
  return FOLD_VERSION * 1_000_000 + fnv1a(JSON.stringify(fold)) % 1_000_000
}

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

function kindOf(event: SurfaceEvent): NodeKind {
  switch (event.type) {
    case 'system/message':
      return 'system'
    case 'developer/message':
      return 'injected'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return event.data.message.isError === true ? 'tool-error' : 'tool'
    case 'user/message': {
      // The source map is merge-extensible; producer kinds are matched by name.
      const kind: string = event.data.source.kind
      if (kind === 'user') return 'human'
      if (kind === 'compact-checkpoint') return 'checkpoint'
      if (kind === 'repeat-tool-reminder') return 'loop'
      return 'injected'
    }
    default:
      // SurfaceEventType is closed today; a future surface type prices as injected context.
      return 'injected'
  }
}

/** Topic bookkeeping for one human message. */
function foldHumanTopic(
  state: ContextDriftState,
  text: string,
  fold: ResolvedFoldConfig,
): Pick<ContextDriftState, 'topic' | 'topicKeywords'> {
  const keywords = extractKeywords(text)
  const shifts = state.topicKeywords.length > 0
    && keywords.length >= fold.topic.minKeywords
    && keywordOverlap(keywords, state.topicKeywords) < fold.topic.minOverlap
  if (shifts) {
    return { topic: state.topic + 1, topicKeywords: [...mergeKeywords([], keywords, fold.topic.maxKeywords)] }
  }
  return {
    topic: state.topic,
    topicKeywords: [...mergeKeywords(state.topicKeywords, keywords, fold.topic.maxKeywords)],
  }
}

/** Path keywords of one tool call's arguments, merged into the current topic. */
function foldToolCall(state: ContextDriftState, args: string, fold: ResolvedFoldConfig): ContextDriftState {
  const paths = extractKeywords(args.slice(0, TOOL_ARGUMENT_SCAN_CHARS)).filter(keyword => keyword.includes('/'))
  if (paths.length === 0) return state
  const basenames = paths.map(path => path.slice(path.lastIndexOf('/') + 1)).filter(name => name.length > 0)
  const topicKeywords = mergeKeywords(state.topicKeywords, [...paths, ...basenames], fold.topic.maxKeywords)
  return topicKeywords === state.topicKeywords ? state : { ...state, topicKeywords: [...topicKeywords] }
}

function foldSurface(state: ContextDriftState, event: SurfaceEvent, config: ResolvedContextDriftConfig): ContextDriftState {
  let next = state
  // A usage sample is stamped before its own event joins the surface, so it anchors the surface its request saw.
  const usage = usageOf(event)
  if (usage !== undefined) {
    next = {
      ...next,
      pressureTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      sampledSurfaceTokens: next.surfaceTokens,
    }
  }

  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  const kind = kindOf(event)
  const node: DriftNode = { seq: event.seq, tokens, kind, topic: next.topic }

  if (kind === 'human' && event.type === 'user/message') {
    const text = textOf(event.data.content)
    if (next.awaitingHuman && isCorrection(text, config.corrections)) node.correction = true
    const topic = foldHumanTopic(next, text, config.fold)
    next = { ...next, ...topic, awaitingHuman: false }
    node.topic = topic.topic
  } else if (kind === 'assistant' && event.type === 'assistant/message') {
    if (event.data.interrupted === true) node.interrupted = true
    next = { ...next, awaitingHuman: true }
  } else if (kind === 'checkpoint') {
    next = {
      ...next,
      compactions: next.compactions + 1,
      baseline: { kind: 'compaction', seq: event.seq, time: event.time },
      awaitingHuman: false,
    }
  }

  const nodes = [...next.nodes]
  const op = event.surfaceOp
  if (op === 'append') {
    nodes.push(node)
    return { ...next, nodes, surfaceTokens: next.surfaceTokens + tokens }
  }
  const startIdx = nodes.findIndex(candidate => candidate.seq === op.startSeq)
  const endIdx = nodes.findIndex(candidate => candidate.seq === op.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    nodes.push(node)
    return { ...next, nodes, surfaceTokens: next.surfaceTokens + tokens, degraded: true }
  }
  const removed = nodes.splice(startIdx, endIdx - startIdx + 1, node)
  // A one-node replacement (pruned tool result, rewritten prompt) keeps the replaced node's topic.
  if (removed.length === 1 && removed[0] !== undefined && kind !== 'checkpoint') node.topic = removed[0].topic
  const removedTokens = removed.reduce((sum, candidate) => sum + candidate.tokens, 0)
  return { ...next, nodes, surfaceTokens: Math.max(0, next.surfaceTokens + tokens - removedTokens) }
}

function foldEvent(state: ContextDriftState, event: SessionEvent, config: ResolvedContextDriftConfig): ContextDriftState {
  if (isSurfaceEvent(event)) return foldSurface(state, event, config)
  switch (event.type) {
    case 'request/context': {
      const { provider, model, contextWindow } = event.data
      if (provider === state.provider && model === state.model && contextWindow === state.contextWindow) return state
      const { contextWindow: _previous, ...rest } = state
      return { ...rest, provider, model, ...contextWindow === undefined ? {} : { contextWindow } }
    }
    case 'request/header': {
      const toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
      return toolsTokens === state.toolsTokens ? state : { ...state, toolsTokens }
    }
    case 'assistant/attempt': {
      const usage = usageOf(event)
      if (usage === undefined) return state
      const pressureTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      return { ...state, pressureTokens, sampledSurfaceTokens: state.surfaceTokens }
    }
    case 'tool/call':
      return foldToolCall(state, event.data.arguments, config.fold)
    default:
      return state
  }
}

/**
 * Derive the score inputs from a fold state.
 * @param state - the fold state.
 * @returns counts over the retained surface.
 */
export function driftInputs(state: ContextDriftState): DriftInputs {
  let systemTokens = 0
  let staleTokens = 0
  let toolTokens = 0
  let turns = 0
  let turnsSinceBaseline = 0
  let toolErrors = 0
  let corrections = 0
  let loopWarnings = 0
  let interrupts = 0
  for (const node of state.nodes) {
    if (node.kind === 'system') {
      systemTokens += node.tokens
      continue
    }
    if (node.topic < state.topic) staleTokens += node.tokens
    switch (node.kind) {
      case 'human':
        turns++
        if (node.seq > state.baseline.seq) turnsSinceBaseline++
        if (node.correction === true) corrections++
        break
      case 'tool':
        toolTokens += node.tokens
        break
      case 'tool-error':
        toolTokens += node.tokens
        toolErrors++
        break
      case 'loop':
        loopWarnings++
        break
      case 'assistant':
        if (node.interrupted === true) interrupts++
        break
      case 'injected':
      case 'checkpoint':
        break
    }
  }
  const liveTokens = state.pressureTokens !== undefined && state.sampledSurfaceTokens !== undefined
    ? Math.max(0, state.pressureTokens + state.surfaceTokens - state.sampledSurfaceTokens)
    : state.surfaceTokens + state.toolsTokens
  return {
    liveTokens,
    ...state.provider === undefined ? {} : { provider: state.provider },
    ...state.model === undefined ? {} : { model: state.model },
    ...state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow },
    turns,
    toolErrors,
    corrections,
    loopWarnings,
    interrupts,
    messageTokens: Math.max(0, state.surfaceTokens - systemTokens),
    staleTokens,
    toolTokens,
    compactions: state.compactions,
    turnsSinceBaseline,
    baseline: state.baseline,
    degraded: state.degraded === true,
  }
}

/** The `contextDrift` unit with its wire view, as the registry's client-visible overload requires. */
export type ContextDriftDefinition = ProjectionDefinition<'contextDrift', ContextDriftState> & {
  wire: NonNullable<ProjectionDefinition<'contextDrift', ContextDriftState>['wire']>
}

/**
 * Build the `contextDrift` unit for one resolved configuration.
 * @param config - resolved plugin configuration; fold settings key the state version.
 * @returns the projection definition to register.
 */
export function createContextDriftProjection(config: ResolvedContextDriftConfig): ContextDriftDefinition {
  return {
    key: 'contextDrift',
    stateVersion: contextDriftStateVersion(config.fold),
    stateSchema: contextDriftStateSchema,
    init: header => ({
      nodes: [],
      surfaceTokens: 0,
      toolsTokens: 0,
      topic: 0,
      topicKeywords: [],
      awaitingHuman: false,
      compactions: 0,
      baseline: { kind: 'session-start', seq: 0, time: header.createdAt },
    }),
    apply: (state, event) => {
      try {
        return foldEvent(state, event, config)
      } catch (error) {
        // Containment: a throwing unit stops every projection of the session, so a
        // malformed event degrades this unit's readings instead. `error` is dropped
        // because the degraded flag is the reported outcome.
        void error
        return state.degraded === true ? state : { ...state, degraded: true }
      }
    },
    wire: {
      viewSchema,
      view: state => scoreDrift(driftInputs(state), config),
    },
  }
}
