/** Host model access shared by the auxiliary requests: the route a request runs on and one streamed answer. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelPrompt, ModelRoute } from './model-gate.ts'

/** An explicit route from plugin configuration; both or neither field is set. */
export interface ExplicitRoute {
  provider?: string
  model?: string
}

/**
 * The configured route, when the configuration names one.
 * @param config - settings carrying an optional provider and model pair.
 * @returns the pair, or undefined when neither is set.
 */
export function configuredRoute(config: ExplicitRoute): ModelRoute | undefined {
  return config.provider !== undefined && config.model !== undefined ? { provider: config.provider, model: config.model } : undefined
}

/**
 * The route a Session-bound request runs on: the configured pair, otherwise the Session's current one.
 * @param ctx - host context carrying the live Sessions.
 * @param config - settings carrying an optional provider and model pair.
 * @param sessionId - the Session whose route is used when the configuration names none.
 * @param label - prefix of the failure message.
 * @returns the route.
 * @throws when neither the configuration nor the Session supplies a route.
 */
export function sessionRoute(ctx: Context, config: ExplicitRoute, sessionId: SessionId, label: string): ModelRoute {
  const route = configuredRoute(config) ?? ctx.get('sessions')?.get(sessionId)?.requestHeader()?.config
  if (route === undefined || route.provider === '' || route.model === '') {
    throw new Error(`${label}: no model route is available for this Session`)
  }
  return { provider: route.provider, model: route.model }
}

/**
 * Check that a provider and model pair is set together.
 * @param config - settings carrying an optional provider and model pair.
 * @param label - configuration path prefix for the failure message.
 * @throws when only one of the two is set.
 */
export function assertRoutePair(config: ExplicitRoute, label: string): void {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error(`ui-deliverables: ${label}.provider and ${label}.model must be set together`)
  }
}

/**
 * One model answer on a route, at its least supported reasoning effort so the output cap is not spent thinking.
 * @param ctx - host context carrying the model service.
 * @param route - provider and model.
 * @param maxTokens - output-token cap of the request.
 * @param prompt - the request text.
 * @param signal - cancels the request.
 * @param label - prefix of the failure messages.
 * @returns the answer text.
 * @throws when no model service is available or the request fails.
 */
export async function completeOnRoute(
  ctx: Context, route: ModelRoute, maxTokens: number, prompt: ModelPrompt, signal: AbortSignal, label: string,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error(`${label}: no model service is available`)
  const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal, (controls, info) => {
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
