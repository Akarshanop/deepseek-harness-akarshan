/**
 * Host wiring of the change explainer: the model request, the workspace read,
 * the explanation route, and the start after each recorded turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import { CHANGES_EXPLAIN_PATH, type ChangesExplanation } from './changes.ts'
import { ChangeExplainer, type ExplainConfig, type ExplainPorts } from './explain.ts'
import { assertRoutePair, completeOnRoute, sessionRoute } from './model-call.ts'
import { changedFileCoordinates } from './present-open.ts'

/** Schemastery validation for {@link ExplainConfig}. */
export const ExplainConfigSchema: z<ExplainConfig> = z.object({
  enabled: z.boolean().default(true),
  eagerFiles: z.number().default(20),
  concurrency: z.number().default(2),
  maxDiffChars: z.number().default(24_000),
  contextLines: z.number().default(120),
  maxOutputTokens: z.number().default(4096),
  timeoutMs: z.number().default(120_000),
  language: z.string().default('English'),
  provider: z.string(),
  model: z.string(),
})

/** Longest delay a timer accepts; a longer `timeoutMs` would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Check the explainer's settings.
 * @param config - settings from the plugin configuration.
 * @throws when a count or limit is not an integer in range, the timeout exceeds the timer limit,
 * or only one of `provider` and `model` is set.
 */
export function assertExplainConfig(config: ExplainConfig): void {
  for (const field of ['eagerFiles', 'concurrency', 'maxDiffChars', 'contextLines', 'maxOutputTokens', 'timeoutMs'] as const) {
    const value = config[field]
    if (!Number.isSafeInteger(value) || value < (field === 'eagerFiles' ? 0 : 1)) {
      throw new Error(`ui-deliverables: explain.${field} must be ${field === 'eagerFiles' ? 'a non-negative' : 'a positive'} integer`)
    }
  }
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`ui-deliverables: explain.timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  assertRoutePair(config, 'explain')
}

/**
 * Serve one listed file's model-written record from a change route: 404 when the file has nothing to describe,
 * 500 for a failure a later request may retry.
 * @param request - the authenticated GET request carrying the file's coordinates.
 * @param produce - writes or waits for the record.
 * @param label - names the record in failure text.
 * @returns the response.
 */
export async function serveChangeRecord<T>(
  request: Request,
  produce: (sessionId: SessionId, seq: number, index: number, signal: AbortSignal) => Promise<T | undefined>,
  label: string,
): Promise<Response> {
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    const record = await produce(id, seq, index, request.signal)
    if (record === undefined) return new Response(`${label} unavailable.`, { status: 404 })
    return Response.json(record, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
  }
}

/**
 * Read the start of a Session workspace file as text.
 * @param ctx - host context carrying the workspace files.
 * @returns the reader; it answers undefined for a file that cannot be read as text.
 */
export function workspaceHead(ctx: Context): ExplainPorts['head'] {
  return async (sessionId, cwd, path, lines, signal) => {
    try {
      return (await ctx.workspaceFiles.read({ sessionId, workspaceRoot: cwd }, path, { offset: 1, limit: lines }, signal)).text
    } catch {
      // A file that cannot be read as text is described from its comparison alone.
      signal.throwIfAborted()
      return undefined
    }
  }
}

/**
 * Explain every changed file with a model: start the first files of each recorded turn as soon as the
 * turn's changes are recorded, and serve each file's explanation, waiting for it when it is still being written.
 * @param ctx - host context carrying the change summaries, workspace files, and the authenticated routes.
 * @param config - validated settings; nothing is registered when `enabled` is false.
 */
export function registerChangeExplain(ctx: Context, config: ExplainConfig): void {
  assertExplainConfig(config)
  if (!config.enabled) return
  const explainer = new ChangeExplainer(config, {
    summary: (sessionId, seq) => ctx.workspaceChanges.summary(sessionId, seq),
    diff: (sessionId, seq, index, signal) => ctx.workspaceChanges.diff(sessionId, seq, index, signal),
    head: workspaceHead(ctx),
    complete: (sessionId, prompt, signal) => completeOnRoute(
      ctx, sessionRoute(ctx, config, sessionId, 'change-explain'), config.maxOutputTokens, prompt, signal, 'change-explain',
    ),
    warn: (message) => { ctx.logger.warn(message) },
  })
  ctx.effect(() => () => { explainer.dispose() })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'workspace/changes') return
    // The recorder keeps the summary right after appending the event, so it is readable one microtask later.
    queueMicrotask(() => { explainer.prefetch(session.id, event.seq) })
  })
  ctx.on('session/disposed', (session) => { explainer.forget(session.id) })
  ctx.connection.fetch.register({
    path: CHANGES_EXPLAIN_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: request => serveChangeRecord<ChangesExplanation>(
      request, (sessionId, seq, index, signal) => explainer.explain(sessionId, seq, index, signal), 'Change explanation',
    ),
  })
}
