/**
 * The `contextDrift` projection unit driven through the real session store
 * and projection registry: readings fold from the retained surface only,
 * compaction removes shadowed turns and mistakes and moves the baseline, topic
 * changes mark earlier tokens stale, an inconsistent replacement degrades the
 * unit instead of throwing, and unloading the plugin removes the key.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
// Type-only: merges the repeat-tool-reminder message source kind.
import type {} from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as ContextDriftPlugin from '@deepseek-ai/dsh-context-drift'
import type { ContextDriftConfig, ContextDriftProjection } from '@deepseek-ai/dsh-context-drift'
import { resolveContextDriftConfig } from '../src/config.ts'
import { createContextDriftProjection } from '../src/projection.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(config: ContextDriftConfig = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ContextDriftPlugin, config)
  return { ctx, session: ctx.sessions.create() }
}

function drift(ctx: Context, session: Session): ContextDriftProjection {
  const value = ctx.sessionProjections.snapshot(session).values.contextDrift
  if (value === undefined) throw new Error('contextDrift is not registered')
  return value
}

function user(session: Session, text: string, source: MessageSource = { kind: 'user' }): SessionSeq {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), { surfaceOp: 'append' }).seq
}

function reply(session: Session, text: string, options: { inputTokens?: number; interrupted?: true } = {}): SessionSeq {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } }),
    ...options.inputTokens === undefined ? {} : { usage: { inputTokens: options.inputTokens, outputTokens: 10 } },
    ...options.interrupted === undefined ? {} : { interrupted: options.interrupted },
  }, { surfaceOp: 'append' }).seq
}

function toolResult(session: Session, text: string, isError: boolean): SessionSeq {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(`call-${text.length}`), content: [{ type: 'text', text }], isError }),
  }, { surfaceOp: 'append' }).seq
}

function compact(session: Session, start: SessionSeq, end: SessionSeq, id: string): SessionSeq {
  const shadowed = session.surface.nodes.filter(seq => seq >= start && seq <= end)
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary of earlier work' }],
    source: compactCheckpointSource(CompactionId(id)),
  }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: shadowed }).seq
}

describe('contextDrift projection', () => {
  it('serves a fresh session-start baseline on the empty log', async () => {
    const { ctx, session } = await harness()
    expect(drift(ctx, session)).toMatchObject({
      score: 0,
      level: 'fresh',
      action: 'none',
      baseline: { kind: 'session-start', seq: 0, time: session.header.createdAt },
      readings: { liveTokens: 0, effectiveTokens: 64_000, turns: 0 },
    })
  })

  it('anchors live tokens to provider usage and reads the route window', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'p', model: 'm', contextWindow: 128_000 })
    user(session, 'hello')
    reply(session, 'x'.repeat(400), { inputTokens: 50_000 })
    const view = drift(ctx, session)
    // 50k reported before the reply joined the surface, plus the reply's heuristic price.
    expect(view.readings.liveTokens).toBe(50_000 + 100 + 4 + 4)
    expect(view.readings).toMatchObject({ contextWindow: 128_000, effectiveTokens: 64_000 })
    expect(view.level).toBe('drifting')
  })

  it('counts human turns, failed tools, corrections after a reply, loop warnings, and interrupts', async () => {
    const { ctx, session } = await harness()
    user(session, 'no, start by reading the config')
    reply(session, 'reading')
    toolResult(session, 'ENOENT', true)
    toolResult(session, 'ok', false)
    user(session, 'that is wrong, it still does not work')
    user(session, 'loop', { kind: 'repeat-tool-reminder' })
    reply(session, 'partial', { interrupted: true })
    expect(drift(ctx, session).readings).toMatchObject({
      turns: 2,
      toolErrors: 1,
      // The first message precedes any reply, so its leading "no" is not a correction.
      corrections: 1,
      loopWarnings: 1,
      interrupts: 1,
    })
  })

  it('drops shadowed turns and mistakes on compaction and moves the baseline', async () => {
    const { ctx, session } = await harness()
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' })
    const first = user(session, 'fix the parser')
    reply(session, 'done')
    toolResult(session, 'boom', true)
    const last = user(session, 'still broken')
    expect(drift(ctx, session).readings).toMatchObject({ turns: 2, toolErrors: 1, corrections: 1, compactions: 0 })

    const checkpoint = compact(session, first, last, 'c1')
    const view = drift(ctx, session)
    expect(view.readings).toMatchObject({ turns: 0, toolErrors: 0, corrections: 0, compactions: 1 })
    expect(view.baseline).toMatchObject({ kind: 'compaction', seq: checkpoint })
  })

  it('marks tokens from before a topic change as stale', async () => {
    const { ctx, session } = await harness()
    user(session, 'refactor parser tokenizer grammar lexer module tests coverage')
    reply(session, 'parser refactored')
    user(session, 'deploy kubernetes cluster ingress certificates monitoring dashboards alerts')
    const view = drift(ctx, session)
    expect(view.readings.stalePercent).toBeGreaterThan(0)
    expect(view.readings.stalePercent).toBeLessThan(100)
  })

  it('keeps one topic while messages share keywords or are too short to judge', async () => {
    const { ctx, session } = await harness()
    user(session, 'refactor parser tokenizer grammar lexer module tests coverage')
    reply(session, 'ok')
    user(session, 'continue')
    user(session, 'parser tokenizer grammar lexer error recovery diagnostics')
    expect(drift(ctx, session).readings.stalePercent).toBe(0)
  })

  it('degrades instead of throwing when a replacement names nodes the fold never saw', async () => {
    const { session } = await harness()
    const first = user(session, 'one')
    const second = user(session, 'two')
    compact(session, first, second, 'c1')
    const definition = createContextDriftProjection(resolveContextDriftConfig())
    let state = definition.init(session.header, session.inheritedEventCount)
    for (const event of session.snapshotEvents()) {
      if (event.seq === first) continue
      state = definition.apply(state, event)
    }
    expect(definition.wire.view(state).degraded).toBe(true)
  })

  it('applies plugin configuration to the served value', async () => {
    const { ctx, session } = await harness({ fallbackEffectiveTokens: 1_000 })
    expect(drift(ctx, session).readings.effectiveTokens).toBe(1_000)
  })

  it('removes the key when the plugin unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = ctx.plugin(ContextDriftPlugin)
    await fiber
    const session = ctx.sessions.create()
    expect(ctx.sessionProjections.snapshot(session).values.contextDrift).toBeDefined()
    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.contextDrift).toBeUndefined()
  })
})
