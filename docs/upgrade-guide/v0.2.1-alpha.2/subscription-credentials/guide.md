---
kind: upgrade-guide
description: "llm-pi-ai no longer signs in to or sends Claude Pro/Max and ChatGPT Codex subscription credentials, and the Codex and Claude Code subagents report rejected sign-ins as an authentication failure."
---

# Subscription credentials are no longer used by llm-pi-ai

English | [中文](guide.zh.md)

## Change

Anthropic does not permit third-party applications to collect or relay Claude Pro/Max credentials, and OpenAI documents no third-party use of the Codex client's ChatGPT tokens. `@deepseek-ai/dsh-llm-pi-ai` therefore stops using them:

- The `llm-pi-ai/openai-codex` authorization flow is removed, `llm-pi-ai/anthropic` keeps only its `api-key` method, and the Models page no longer offers the `openai-codex` provider.
- Stored `grant` records for those two providers are ignored, not deleted, and a one-time warning names the provider.
- A key containing `sk-ant-oat`, whatever variable holds it, is ignored during ambient discovery. An `apiKeyEnv` that resolves to one fails with `INVALID_CREDENTIAL`.
- Any `apiKeyEnv` on the `openai-codex` route fails with `INVALID_CREDENTIAL`, because that route accepts only a ChatGPT access token.

No secret value appears in the error or the log. API-key routes (`anthropic`, `openai`) are unchanged.

The Codex and Claude Code subagents now report a rejected or missing sign-in as `category: authentication` with a fixed remediation sentence. Codex previously reported `unauthorized` as `access-policy` and a rejected key as `product-error`; Claude Code reported `invalid-result` or `unknown`. Both gain an optional `timeoutMs`, which settles an overrunning run as `error` with `category: timeout`.

Affected: embedders that call `ctx.authorization.begin` for the removed flows, profiles that route to `openai-codex`, and tools that parse subagent diagnostics.

## Migration

1. For Claude models, create an API key in the Claude Console and store it as `ANTHROPIC_API_KEY` on the Models page. The `anthropic` route reads it through `apiKeyEnv`.
2. For OpenAI models, use the `openai` route with an OpenAI Platform API key.
3. To use a Claude Pro/Max or ChatGPT plan, enable **Claude Code subagent** or **Codex subagent** in Plugins → Official. Sign in with the product itself (`claude`, then `/login`; or `codex login`). The harness never sees those credentials.
4. Remove the `openai-codex` entry from the `llm-pi-ai` `providers` settings, and any `apiKeyEnv` that names a subscription token. Optionally delete the `llm-pi-ai/anthropic` and `llm-pi-ai/openai-codex` grants from `$DSH_HOME/.credentials.yaml`.
5. Update diagnostic parsers to accept `authentication` and `timeout` categories.
6. Confirm `ctx.authorization.list()` has no `llm-pi-ai/openai-codex` entry and the log shows no "ignoring a subscription credential" warning.
