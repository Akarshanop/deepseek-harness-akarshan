/**
 * Side questions: the model sees the Session history plus the highlighted
 * passage under its own system prompt, and each exchange is saved outside the
 * Session log. The storage-domain facility and the LLM service are in-memory
 * doubles; the Session is a real one with a logged request header.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from '../src/agent.ts'
import {
  SIDE_QUESTION_SYSTEM_PROMPT,
  SessionSideQuestionController,
  sideQuestionPrompt,
} from '../src/side-questions.ts'

const sid = (id: string): SessionId => id as SessionId

/** Minimal in-memory facility: one Map per table, same surface the controller uses. */
function memoryFacility(): { open: (spec: { tables: Record<string, unknown> }) => Promise<unknown> } {
  const tables = new Map<string, Map<string, unknown>>()
  return {
    open: () => Promise.resolve({
      table: (name: string) => {
        const rows = tables.get(name) ?? new Map<string, unknown>()
        tables.set(name, rows)
        return {
          get: (key: string) => rows.get(key),
          entries: () => rows.entries(),
          put: (key: string, value: unknown) => { rows.set(key, value); return Promise.resolve() },
          delete: (key: string) => Promise.resolve(rows.delete(key)),
        }
      },
    }),
  }
}

function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

interface Harness {
  readonly controller: SessionSideQuestionController
  readonly session: Session
  readonly calls: GenerateOptions[]
}

async function harness(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>, withHeader = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(sid('session-aside'), { meta: { cwd: '/proj' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'explain lecture.py' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (withHeader) {
    session.append('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' })
  }
  const calls: GenerateOptions[] = []
  ctx.provide('llm', {
    stream: (options: GenerateOptions) => { calls.push(options); return stream(options) },
  } as never)
  ctx.provide('storageDomain', memoryFacility() as never)
  const agents = {
    resolveAgent: (id: SessionId) => Promise.resolve(id === session.id
      ? { agent: { session } }
      : { error: new RemoteError('gateway/internal', 'unknown session', {}) }),
  } as unknown as ApiSessionAgentController
  const controller = new SessionSideQuestionController(ctx, agents, { maxOutputTokens: 321, timeoutMs: 60_000 })
  return { controller, session, calls }
}

const noSignal = new AbortController().signal

describe('side questions', () => {
  it('sends history, its own system prompt, and the selection, then saves the answer', async () => {
    const { controller, session, calls } = await harness(() => textStream('  It validates the body.  '))

    const saved = await controller.ask({ sessionId: session.id, selection: ' extra="forbid" ', question: ' why? ' }, noSignal)

    expect(saved).toMatchObject({
      sessionId: session.id, selection: 'extra="forbid"', question: 'why?', answer: 'It validates the body.',
      provider: 'p', model: 'm', contextMessageCount: 1, system: SIDE_QUESTION_SYSTEM_PROMPT,
      prompt: sideQuestionPrompt('extra="forbid"', 'why?'),
    })
    expect(saved.error).toBeUndefined()
    const [call] = calls
    expect(call).toMatchObject({ provider: 'p', model: 'm', system: SIDE_QUESTION_SYSTEM_PROMPT, maxTokens: 321, sessionId: session.id })
    expect(call?.messages).toHaveLength(2)
    expect(call?.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: saved.prompt }] })
    expect(session.snapshotEvents().some(event => event.type === 'user/message' && event.seq > 3)).toBe(false)
    expect((await controller.list({ sessionId: session.id })).questions).toEqual([saved])
  })

  it('saves a model failure on the record instead of throwing', async () => {
    const { controller, session } = await harness(() => (async function* (): AsyncIterable<StreamChunk> {
      await Promise.resolve()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } as never }
    })())

    const saved = await controller.ask({ sessionId: session.id, selection: 'a', question: 'b' }, noSignal)

    expect(saved).toMatchObject({ answer: '', error: 'rate limited' })
    expect((await controller.list({ sessionId: session.id })).questions).toHaveLength(1)
  })

  it('saves a thrown stream error, and reports an empty answer', async () => {
    const thrown = await harness(() => (async function* (): AsyncIterable<StreamChunk> {
      await Promise.resolve()
      throw new Error('socket closed')
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    expect((await thrown.controller.ask({ sessionId: thrown.session.id, selection: 'a', question: 'b' }, noSignal)).error)
      .toContain('socket closed')

    const empty = await harness(() => (async function* (): AsyncIterable<StreamChunk> {
      await Promise.resolve()
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    expect((await empty.controller.ask({ sessionId: empty.session.id, selection: 'a', question: 'b' }, noSignal)).error)
      .toBe('The model returned no text answer.')
  })

  it('does not save a cancelled question', async () => {
    const abort = new AbortController()
    const { controller, session } = await harness(() => (async function* (): AsyncIterable<StreamChunk> {
      await Promise.resolve()
      abort.abort()
      throw new Error('aborted upstream')
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())

    await expect(controller.ask({ sessionId: session.id, selection: 'a', question: 'b' }, abort.signal)).rejects.toThrow()
    expect((await controller.list({ sessionId: session.id })).questions).toEqual([])

    const late = new AbortController()
    const finished = await harness(() => (async function* (): AsyncIterable<StreamChunk> {
      yield* textStream('done')
      late.abort()
    })())
    await expect(finished.controller.ask({ sessionId: finished.session.id, selection: 'a', question: 'b' }, late.signal)).rejects.toThrow()
    expect((await finished.controller.list({ sessionId: finished.session.id })).questions).toEqual([])
  })

  it('rejects blank input and a Session that has not routed a model request', async () => {
    const blank = await harness(() => textStream('x'))
    await expect(blank.controller.ask({ sessionId: blank.session.id, selection: '  ', question: 'b' }, noSignal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(blank.controller.ask({ sessionId: blank.session.id, selection: 'a', question: '' }, noSignal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(blank.controller.ask({ sessionId: sid('missing'), selection: 'a', question: 'b' }, noSignal))
      .rejects.toThrow('unknown session')

    const cold = await harness(() => textStream('x'), false)
    await expect(cold.controller.ask({ sessionId: cold.session.id, selection: 'a', question: 'b' }, noSignal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('lists oldest first and deletes only within the addressed Session', async () => {
    const { controller, session } = await harness(() => textStream('ok'))
    const first = await controller.ask({ sessionId: session.id, selection: 'a', question: 'one' }, noSignal)
    const second = await controller.ask({ sessionId: session.id, selection: 'a', question: 'two' }, noSignal)

    expect((await controller.list({ sessionId: session.id })).questions.map(item => item.id)).toEqual([first.id, second.id])
    expect((await controller.list({ sessionId: sid('other') })).questions).toEqual([])
    expect(await controller.delete({ sessionId: sid('other'), id: first.id })).toEqual({ deleted: false })
    expect(await controller.delete({ sessionId: session.id, id: first.id })).toEqual({ deleted: true })
    expect((await controller.list({ sessionId: session.id })).questions.map(item => item.id)).toEqual([second.id])
  })

  it('fails with an actionable error when no storage-domain service is mounted', async () => {
    const ctx = new Context()
    const controller = new SessionSideQuestionController(ctx, {} as ApiSessionAgentController, { maxOutputTokens: 1, timeoutMs: 1 })
    await expect(controller.list({ sessionId: sid('x') })).rejects.toThrow('mounts no storage-domain service')
  })
})
