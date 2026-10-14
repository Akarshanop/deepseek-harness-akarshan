---
kind: upgrade-guide
description: "llm-pi-ai 不再登录或发送 Claude Pro/Max 与 ChatGPT Codex 订阅凭据，Codex 与 Claude Code 子代理把被拒绝的登录报告为认证失败。"
---

# llm-pi-ai 不再使用订阅凭据

[English](guide.md) | 中文

## 变更

Anthropic 不允许第三方应用收集或转发 Claude Pro/Max 凭据，OpenAI 也未记录第三方可使用 Codex 客户端 ChatGPT 令牌的方式。因此 `@deepseek-ai/dsh-llm-pi-ai` 停止使用它们：

- 移除 `llm-pi-ai/openai-codex` 授权流程，`llm-pi-ai/anthropic` 只保留 `api-key` 方法，模型页面也不再提供 `openai-codex` 提供商。
- 这两个提供方已存储的 `grant` 记录会被忽略而不是删除，并输出一次点名该提供方的警告。
- 含有 `sk-ant-oat` 的密钥无论由哪个变量持有，都会在环境自动发现时被忽略。`apiKeyEnv` 解析到这类密钥时，请求以 `INVALID_CREDENTIAL` 失败。
- `openai-codex` 路由上的任何 `apiKeyEnv` 都以 `INVALID_CREDENTIAL` 失败，因为该路由只接受 ChatGPT 访问令牌。

错误和日志中不会出现任何密钥值。API 密钥路由（`anthropic`、`openai`）不变。

Codex 与 Claude Code 子代理现在把被拒绝或缺失的登录报告为 `category: authentication`，并附带固定的补救说明。此前 Codex 把 `unauthorized` 报告为 `access-policy`，把被拒绝的密钥报告为 `product-error`；Claude Code 报告为 `invalid-result` 或 `unknown`。两者新增可选的 `timeoutMs`，超时的运行以 `error` 和 `category: timeout` 结束。

受影响对象：为已移除流程调用 `ctx.authorization.begin` 的嵌入方、路由到 `openai-codex` 的 profile，以及解析子代理诊断的工具。

## 迁移

1. 使用 Claude 模型时，在 Claude Console 创建 API 密钥，并在模型页面将其存为 `ANTHROPIC_API_KEY`。`anthropic` 路由通过 `apiKeyEnv` 读取它。
2. 使用 OpenAI 模型时，在 `openai` 路由上使用 OpenAI Platform API 密钥。
3. 要使用 Claude Pro/Max 或 ChatGPT 套餐，在插件 → 官方中启用 **Claude Code subagent** 或 **Codex subagent**，并用产品自身登录（`claude` 后执行 `/login`，或 `codex login`）。Harness 不会接触这些凭据。
4. 从 `llm-pi-ai` 的 `providers` 设置中移除 `openai-codex` 条目，以及指向订阅令牌的 `apiKeyEnv`。可选：从 `$DSH_HOME/.credentials.yaml` 删除 `llm-pi-ai/anthropic` 和 `llm-pi-ai/openai-codex` 的 grant。
5. 更新诊断解析器，使其接受 `authentication` 与 `timeout` 类别。
6. 确认 `ctx.authorization.list()` 中没有 `llm-pi-ai/openai-codex` 条目，且日志中没有 "ignoring a subscription credential" 警告。
