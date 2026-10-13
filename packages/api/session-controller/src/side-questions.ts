/**
 * Side questions: one standalone model call about a highlighted transcript
 * passage, answered with the whole Session as context and saved beside the
 * Session instead of inside its event log.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'
import type {
  SessionAskSideQuestionRequest,
  SessionAskSideQuestionValue,
  SessionDeleteSideQuestionRequest,
  SessionDeleteSideQuestionValue,
  SessionListSideQuestionsRequest,
  SessionListSideQuestionsValue,
  SideQuestionId,
  SideQuestionRecord,
} from './types.ts'

/** System prompt of every side question; the Session's own system prompt is not replayed. */
export const SIDE_QUESTION_SYSTEM_PROMPT = [
  'You are answering a side question about a conversation between a user and an AI agent.',
  'The conversation so far is provided as history.',
  'The user highlighted one passage of it and asked a question about that passage.',
  'Answer only that question, directly and concisely, using the conversation as context.',
  'This exchange is private and does not continue the conversation: do not call tools, do not act on the conversation\'s task, and do not claim to have changed anything.',
].join(' ')

const recordSchema = z.object({
  id: z.string().min(1).transform(value => brandString<SideQuestionId>(value)),
  sessionId: z.string().min(1).transform(SessionId),
  askedAt: z.iso.datetime({ precision: 3 }),
  selection: z.string(),
  question: z.string(),
  system: z.string(),
  prompt: z.string(),
  contextMessageCount: z.number().int().min(0),
  provider: z.string().min(1),
  model: z.string().min(1),
  answer: z.string(),
  error: z.string().optional(),
}).strict()

/** Authoritative storage for side questions; a malformed record rejects opening the domain. */
export const sideQuestionDomain = defineDomain({
  name: 'side_questions',
  version: 1,
  tables: { questions: domainTable<SideQuestionId, SideQuestionRecord>(recordSchema) },
})

/** Deployment limits for one side-question model call. */
export interface SideQuestionLimits {
  /** Output-token cap for the answer. */
  readonly maxOutputTokens: number
  /** End-to-end deadline for the model call, in milliseconds. */
  readonly timeoutMs: number
}

/** Build the user message that follows the replayed history. */
export function sideQuestionPrompt(selection: string, question: string): string {
  return `<selected_text>\n${selection}\n</selected_text>\n\nQuestion: ${question}`
}

/** Owns the side-question store and the model call behind the three Session Remote methods. */
export class SessionSideQuestionController {
  private domain: Promise<Domain<typeof sideQuestionDomain>> | undefined

  /**
   * @param ctx - Host context providing the LLM and storage-domain services.
   * @param agents - Session resolver that resumes a cold Session before it is read.
   * @param limits - output-token and deadline limits for each call.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly limits: SideQuestionLimits,
  ) {}

  /**
   * Ask the model one question about a highlighted passage and save the exchange.
   * A model failure is saved on the record; only cancellation and invalid requests throw.
   * @param request - Session, highlighted text, and question.
   * @param signal - caller cancellation; a cancelled question is not saved.
   * @returns the saved record, with `error` set when the model failed.
   */
  async ask(request: SessionAskSideQuestionRequest, signal: AbortSignal): Promise<SessionAskSideQuestionValue> {
    const selection = request.selection.trim()
    const question = request.question.trim()
    if (selection.length === 0 || question.length === 0) {
      throw new RemoteError('gateway/bad-request', 'A side question needs both highlighted text and a question', {})
    }
    const table = (await this.open()).table('questions')
    const found = await this.agents.resolveAgent(request.sessionId)
    if ('error' in found) throw found.error
    const { session } = found.agent
    const route = session.requestHeader()?.config
    if (route === undefined) {
      throw new RemoteError('gateway/bad-request', 'This Session has not sent a model request yet, so there is no model to ask', {})
    }
    const history = session.deriveMessages().filter(message => message.role !== 'system')
    const prompt = sideQuestionPrompt(selection, question)
    const messages: RequestMessage[] = [...history, { role: 'user', content: [{ type: 'text', text: prompt }] }]
    const tools = session.requestHeader()?.tools
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeoutMs)])
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      system: SIDE_QUESTION_SYSTEM_PROMPT,
      toolHistory: session.toolHistory(),
      ...tools === undefined ? {} : { tools: [...tools] },
      maxTokens: this.limits.maxOutputTokens,
      sessionId: session.id,
      signal: callSignal,
    }
    const base = {
      id: brandString<SideQuestionId>(randomUUID()),
      sessionId: request.sessionId,
      askedAt: new Date().toISOString(),
      selection,
      question,
      system: SIDE_QUESTION_SYSTEM_PROMPT,
      prompt,
      contextMessageCount: history.length,
      provider: route.provider,
      model: route.model,
    }
    const outcome = await this.answer(options, signal)
    const record: SideQuestionRecord = { ...base, ...outcome }
    await table.put(record.id, record)
    return record
  }

  /**
   * List one Session's saved side questions.
   * @param request - Session identity.
   * @returns the Session's questions, oldest first.
   */
  async list(request: SessionListSideQuestionsRequest): Promise<SessionListSideQuestionsValue> {
    const table = (await this.open()).table('questions')
    const questions = [...table.entries()]
      .map(([, record]) => record)
      .filter(record => record.sessionId === request.sessionId)
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
    return { questions }
  }

  /**
   * Delete one saved side question.
   * @param request - Session identity and question identity.
   * @returns whether a question of that Session existed.
   */
  async delete(request: SessionDeleteSideQuestionRequest): Promise<SessionDeleteSideQuestionValue> {
    const table = (await this.open()).table('questions')
    if (table.get(request.id)?.sessionId !== request.sessionId) return { deleted: false }
    return { deleted: await table.delete(request.id) }
  }

  private async answer(
    options: GenerateOptions,
    signal: AbortSignal,
  ): Promise<{ readonly answer: string; readonly error?: string }> {
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      signal.throwIfAborted()
      return { answer: '', error: errorChain(error) }
    }
    signal.throwIfAborted()
    const { finish } = assembler
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      return { answer: '', error: finish.failure.message }
    }
    const answer = assembler.blocks()
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
      .trim()
    return answer.length === 0 ? { answer: '', error: 'The model returned no text answer.' } : { answer }
  }

  private open(): Promise<Domain<typeof sideQuestionDomain>> {
    if (this.domain === undefined) {
      const facility = this.ctx.get('storageDomain')
      if (facility === undefined) {
        throw new RemoteError('gateway/internal', 'side questions are unavailable: this deployment mounts no storage-domain service', {})
      }
      this.domain = facility.open(sideQuestionDomain)
      this.domain.catch(() => { this.domain = undefined })
    }
    return this.domain
  }
}
