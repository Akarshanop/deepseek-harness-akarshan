/**
 * Host wiring of the change judge: the turn requests it compares against, the
 * docs it reads, the model request, the judgment route, and the order after
 * each recorded turn — capture the docs, start the judgments, then document
 * the changed files again.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import { CHANGES_JUDGE_PATH, type ChangesJudgment } from './changes.ts'
import type { CodebaseDocsHost } from './codebase-docs-host.ts'
import { serveChangeRecord, workspaceHead } from './explain-host.ts'
import { ChangeJudge, type JudgeConfig } from './judge.ts'
import { assertRoutePair, completeOnRoute, sessionRoute } from './model-call.ts'

/** Schemastery validation for {@link JudgeConfig}. */
export const JudgeConfigSchema: z<JudgeConfig> = z.object({
  enabled: z.boolean().default(true),
  eagerFiles: z.number().default(20),
  concurrency: z.number().default(2),
  maxDiffChars: z.number().default(24_000),
  contextLines: z.number().default(400),
  maxDocChars: z.number().default(12_000),
  maxRelatedDocs: z.number().default(4),
  maxRelatedChars: z.number().default(12_000),
  maxIndexChars: z.number().default(8_000),
  maxRequestChars: z.number().default(4_000),
  maxOutputTokens: z.number().default(4096),
  timeoutMs: z.number().default(180_000),
  language: z.string().default('English'),
  provider: z.string(),
  model: z.string(),
})

/** Longest delay a timer accepts; a longer `timeoutMs` would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Turns per Session whose request text is kept for judgments. */
const KEPT_TURNS = 50

/**
 * Check the judge's settings.
 * @param config - settings from the plugin configuration.
 * @throws when a count or limit is not an integer in range, the timeout exceeds the timer limit,
 * or only one of `provider` and `model` is set.
 */
export function assertJudgeConfig(config: JudgeConfig): void {
  const nonNegative = new Set<string>(['eagerFiles', 'maxRelatedDocs'])
  for (const field of [
    'eagerFiles', 'concurrency', 'maxDiffChars', 'contextLines', 'maxDocChars', 'maxRelatedDocs', 'maxRelatedChars',
    'maxIndexChars', 'maxRequestChars', 'maxOutputTokens', 'timeoutMs',
  ] as const) {
    const value = config[field]
    const floor = nonNegative.has(field) ? 0 : 1
    if (!Number.isSafeInteger(value) || value < floor) {
      throw new Error(`ui-deliverables: judge.${field} must be ${floor === 0 ? 'a non-negative' : 'a positive'} integer`)
    }
  }
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`ui-deliverables: judge.timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  assertRoutePair(config, 'judge')
}

/** The developer prompts of one Session's recent turns, folded from its live events. */
interface TurnRequests {
  turn: number
  readonly texts: Map<number, string>
}

/**
 * Judge every changed file against the project's codebase docs, and keep the docs current after each turn.
 * @param ctx - host context carrying the change summaries, workspace files, live Sessions, and the authenticated routes.
 * @param config - validated settings; no judgment is written when `enabled` is false.
 * @param docs - the codebase docs, or undefined when they are composed out; the judge then reads the code alone.
 */
export function registerChangeJudge(ctx: Context, config: JudgeConfig, docs: CodebaseDocsHost | undefined): void {
  assertJudgeConfig(config)
  if (!config.enabled && docs === undefined) return
  const requests = new Map<SessionId, TurnRequests>()
  const judge = new ChangeJudge(config, {
    summary: (sessionId, seq) => ctx.workspaceChanges.summary(sessionId, seq),
    diff: (sessionId, seq, index, signal) => ctx.workspaceChanges.diff(sessionId, seq, index, signal),
    head: workspaceHead(ctx),
    request: (sessionId, turn) => requests.get(sessionId)?.texts.get(turn),
    baseline: (cwd, paths, signal) => docs?.docs.baseline(cwd, paths, signal) ?? Promise.resolve({ index: undefined, docs: {} }),
    related: (cwd, path, text, limit, signal) => docs?.docs.related(cwd, path, text, limit, signal) ?? Promise.resolve({}),
    complete: (sessionId, prompt, signal) => completeOnRoute(
      ctx, sessionRoute(ctx, config, sessionId, 'change-judge'), config.maxOutputTokens, prompt, signal, 'change-judge',
    ),
    warn: (message) => { ctx.logger.warn(message) },
  })
  ctx.effect(() => () => { judge.dispose() })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const record = requests.get(session.id) ?? { turn: 0, texts: new Map<number, string>() }
      record.turn = event.data.turn
      requests.set(session.id, record)
      for (const turn of record.texts.keys()) if (turn <= event.data.turn - KEPT_TURNS) record.texts.delete(turn)
      return
    }
    if (event.type === 'user/message') {
      const record = requests.get(session.id)
      if (record === undefined || event.data.source.kind !== 'user') return
      const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text === '') return
      const earlier = record.texts.get(record.turn)
      record.texts.set(record.turn, earlier === undefined ? text : `${earlier}\n\n${text}`)
      return
    }
    if (event.type !== 'workspace/changes') return
    const { seq } = event
    const sessionId = session.id
    // The recorder keeps the summary right after appending the event, so it is readable one microtask later.
    queueMicrotask(() => {
      const summary = ctx.workspaceChanges.summary(sessionId, seq)
      if (summary === undefined) return
      void judge.prefetch(sessionId, seq).then(() => {
        docs?.refresh(sessionId, summary.cwd, summary.files.filter(file => file.binary !== true).map(file => file.path))
      })
    })
  })
  ctx.on('session/disposed', (session) => {
    requests.delete(session.id)
    judge.forget(session.id)
  })
  if (!config.enabled) return
  ctx.connection.fetch.register({
    path: CHANGES_JUDGE_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: request => serveChangeRecord<ChangesJudgment>(
      request, (sessionId, seq, index, signal) => judge.judge(sessionId, seq, index, signal), 'Change judgment',
    ),
  })
}
