/**
 * Host wiring of the change explainer: the model request, the workspace read,
 * the explanation route, and the start after each recorded turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import { CHANGES_EXPLAIN_PATH, type ChangesExplanation } from './changes.ts'
import { ChangeExplainer, type ExplainConfig, type ExplainPrompt } from './explain.ts'
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
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('ui-deliverables: explain.provider and explain.model must be set together')
  }
}

/** The route one explanation request runs on: the configured pair, otherwise the Session's current one. */
function routeFor(ctx: Context, config: ExplainConfig, sessionId: SessionId): { provider: string; model: string } {
  const route = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : ctx.get('sessions')?.get(sessionId)?.requestHeader()?.config
  if (route === undefined || route.provider === '' || route.model === '') {
    throw new Error('change-explain: no model route is available for this Session')
  }
  return route
}

/** One model answer on the Session's route, at its least supported reasoning effort so the output cap is not spent thinking. */
async function complete(
  ctx: Context, config: ExplainConfig, sessionId: SessionId, prompt: ExplainPrompt, signal: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('change-explain: no model service is available')
  const { provider, model } = routeFor(ctx, config, sessionId)
  const call = await llm.prepareCall({ provider, model, maxTokens: config.maxOutputTokens }, signal, (controls, info) => {
    const effort = info.reasoning?.efforts[0]?.id
    return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
  })
  const options: GenerateOptions = {
    ...call.config, system: prompt.system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }], signal,
  }
  let answer = ''
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'text-delta') answer += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure.message)
    }
  }
  return answer
}

/** One file's explanation; 404 when the file has nothing to explain, 500 for a failure a later request may retry. */
async function handleChangesExplain(explainer: ChangeExplainer, request: Request): Promise<Response> {
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    const explanation = await explainer.explain(id, seq, index, request.signal)
    if (explanation === undefined) return new Response('Change explanation unavailable.', { status: 404 })
    return Response.json(explanation satisfies ChangesExplanation, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response(`Change explanation failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
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
    head: async (sessionId, cwd, path, lines, signal) => {
      try {
        return (await ctx.workspaceFiles.read({ sessionId, workspaceRoot: cwd }, path, { offset: 1, limit: lines }, signal)).text
      } catch {
        // A file that cannot be read as text is explained from its comparison alone.
        signal.throwIfAborted()
        return undefined
      }
    },
    complete: (sessionId, prompt, signal) => complete(ctx, config, sessionId, prompt, signal),
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
    fetch: request => handleChangesExplain(explainer, request),
  })
}
