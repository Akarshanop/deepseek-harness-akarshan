/**
 * Refusal of consumer-subscription credentials. A Claude Pro/Max or ChatGPT
 * Plus/Pro sign-in authorizes Anthropic's and OpenAI's own clients, not a
 * third-party application: Anthropic's terms forbid collecting, storing, or
 * relaying Claude account credentials, and OpenAI documents no third-party use
 * of the Codex client's tokens. pi-ai would otherwise send such a token to the
 * model endpoint with the first-party client's identity, so this module is the
 * single place that decides which credentials never reach pi-ai.
 *
 * @module dsh-llm-pi-ai/subscription
 */

import type { Credential } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Catalog providers whose subscription OAuth sign-in this adapter does not
 * offer and whose stored OAuth grants it does not use. Their API-key methods
 * are unaffected.
 */
export const SUBSCRIPTION_OAUTH_WITHHELD: ReadonlySet<string> = new Set(['anthropic', 'openai-codex'])

/**
 * Whether a catalog provider has no credential this adapter will send: its
 * subscription sign-in is withheld and it ships no API-key method, so offering
 * it for configuration would only lead to a route that cannot authenticate.
 * @param providerId - the catalog provider id.
 * @param offersApiKey - whether pi-ai ships an API-key method for it.
 * @returns true when configuration surfaces should not offer the provider.
 */
export function isUnreachableProvider(providerId: string, offersApiKey: boolean): boolean {
  return SUBSCRIPTION_OAUTH_WITHHELD.has(providerId) && !offersApiKey
}

/**
 * pi-ai's `openai-codex-responses` protocol sends a ChatGPT access token to
 * the private ChatGPT backend; no other credential works on it.
 */
const CHATGPT_SUBSCRIPTION_API = 'openai-codex-responses'

/**
 * Substring that marks an Anthropic Pro/Max OAuth access token. pi-ai tests
 * for it with `includes`, independent of route and endpoint, and on a match
 * presents the request as Claude Code, so this module uses the same test.
 */
const ANTHROPIC_SUBSCRIPTION_TOKEN_MARKER = 'sk-ant-oat'

/** Where a user goes instead of a subscription credential, appended to every refusal. */
const ALTERNATIVES = 'use an API key (Anthropic Console or OpenAI Platform) on the matching route,'
  + ' or delegate the task to the Claude Code or Codex subagent, which use the account the user signed'
  + ' in to with that product itself'

/**
 * Whether a string is an Anthropic subscription OAuth access token.
 * @param value - a resolved credential value.
 * @returns true when pi-ai would treat the value as a Claude Code OAuth token.
 */
export function isAnthropicSubscriptionToken(value: string): boolean {
  return value.includes(ANTHROPIC_SUBSCRIPTION_TOKEN_MARKER)
}

/**
 * Whether a stored pi-ai credential is a subscription credential this adapter
 * does not use.
 * @param providerId - the catalog provider the credential is stored for.
 * @param credential - the stored credential.
 * @returns true for an OAuth grant of a withheld provider, or an API key holding a subscription token.
 */
export function isSubscriptionCredential(providerId: string, credential: Credential): boolean {
  if (credential.type === 'oauth') return SUBSCRIPTION_OAUTH_WITHHELD.has(providerId)
  return credential.key !== undefined && isAnthropicSubscriptionToken(credential.key)
}

/**
 * Refuse an explicitly configured credential that is a subscription credential.
 *
 * Two cases are refused: a value carrying the Anthropic subscription-token
 * marker on any route, and any credential on a route whose models speak the
 * ChatGPT-backend protocol, because the only value that protocol accepts is a
 * ChatGPT access token.
 * @param route - the harness route key being authenticated.
 * @param apiProtocols - the wire protocols of the route's models; absent when the route's provider could not be constructed.
 * @param ref - the credential reference the profile names; its value is never echoed.
 * @param value - the resolved credential value.
 * @throws {LlmError} code `INVALID_CREDENTIAL` naming the route and reference.
 */
export function assertNotSubscriptionCredential(
  route: string,
  apiProtocols: readonly string[] | undefined,
  ref: string,
  value: string,
): void {
  if (apiProtocols?.includes(CHATGPT_SUBSCRIPTION_API) === true) {
    throw new LlmError(
      `llm-pi-ai: route "${route}" authenticates with a ChatGPT subscription token, which this harness does not`
      + ` send on a user's behalf (credential reference ${ref}); ${ALTERNATIVES}`,
      'INVALID_CREDENTIAL',
    )
  }
  if (isAnthropicSubscriptionToken(value)) {
    throw new LlmError(
      `llm-pi-ai: credential reference ${ref} for route "${route}" is a Claude subscription (Pro/Max) OAuth token,`
      + ` which Anthropic does not permit third-party applications to use; ${ALTERNATIVES}`,
      'INVALID_CREDENTIAL',
    )
  }
}

/**
 * The explanation logged when a stored or ambient subscription credential is
 * ignored. It names where the credential was found, never the credential.
 * @param source - the stored sign-in or environment variable that held it.
 * @returns the log message.
 */
export function ignoredSubscriptionMessage(source: string): string {
  return `llm-pi-ai: ignoring a subscription credential (${source}); third-party applications may not use it, so ${ALTERNATIVES}`
}
