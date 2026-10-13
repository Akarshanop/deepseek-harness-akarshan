# 会话引用

[English](session-reference.md) | 中文

由 Host 支撑的文件发现，以及结构化的跨会话引用请求与准备后的消息上下文。[文件引用约定](../../packages/context/file-reference)负责仅含路径的补全记录与语法；[会话引用约定](../../packages/context/session-reference)定义规范 URI、当前表层投影、标签安全的 JSON 与字节保留、稳定错误和不可信的模型提示词。宿主适配器使用这些类型，而不会把各自 UI 的提及语法传入 agent（智能体）核心。

来源：[`packages/context/file-reference/src/types.ts`](../../packages/context/file-reference/src/types.ts) · [`packages/context/session-reference/src/types.ts`](../../packages/context/session-reference/src/types.ts)

## 文件候选项

`FileReferenceCandidate` 是仅含路径的发现结果。被寻址的 agent 提供工作目录范围；提供方负责排序和命名空间访问，但不会读取文件内容。

```ts type-equiv
/** One path-only completion candidate inside the target session cwd. */
interface FileReferenceCandidate {
  /** User-facing path accepted by normal prompts and filesystem tools. */
  path: string
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory'
}
```

## 输入与候选项

`SessionReferenceInput` 是与宿主无关的选择。id 具有权威性；label 是随快照携带的显示元数据。`compact` 输入请求摘要而非原文预览：其规范 mention 为 `#[label](dsh-session:…)`，而 `@[label](…)` 表示引用原文。

```ts type-equiv
/** One source session selected by a host. */
interface SessionReferenceInput {
  /** Opaque source session identity. */
  sessionId: SessionId
  /** Optional user-facing mention label. */
  label?: string
  /**
   * Summarize the source with a separate model request instead of quoting its messages.
   * The source is read, never written: it gains no compaction event and keeps its own history.
   */
  compact?: boolean
}
```

`SessionReferenceCandidate` 是面向宿主的发现输出。存在最新 Session 标题时，它的 `label` 使用该标题；可选显示文本则优先使用 subagent 的持久创建 label。筛选会同时搜索两者、Session id 与 cwd，绝不搜索 transcript（文本记录）。Remote 候选在 `displayTitle` 存在时用它标记规范 mention。

```ts type-equiv
/** One host-facing candidate from exact session metadata. */
interface SessionReferenceCandidate {
  /** Opaque source session identity. */
  sessionId: SessionId
  /** Latest log-backed title, falling back to the opaque session id. */
  label: string
  /** Display and canonical-mention text, preferring a subagent's durable creation label over {@link label}. */
  displayTitle?: string
  /** Source session working directory, when recorded. */
  cwd?: string
  /**
   * True when {@link SessionReferenceCandidate.cwd} is recorded and equals the
   * requesting agent's. Hosts that only surface a distinguishing location
   * read this instead of comparing paths they never received.
   */
  sameWorkspace: boolean
  /** Source session creation time in Unix epoch milliseconds. */
  createdAt: number
}
```

`sessionReferenceResolver/candidates` Remote 方法向浏览器消费方提供同一发现能力，并为每个候选附上规范提示词 mention：`mention` 引用原文，`compactMention` 生成摘要。

```ts type-equiv
/** One discovery candidate carrying its canonical prompt mention. */
interface SessionReferenceMentionCandidate extends SessionReferenceCandidate {
  /** Canonical `@[label](dsh-session:…)` mention serialized into the prompt draft. */
  mention: string
  /** Canonical `#[label](dsh-session:…)` mention that asks for a summary of the session instead of its messages. */
  compactMention: string
}
```

## 准备后的消息

准备过程保留可读的当前消息内容，并最多返回一个聚合上下文。其持久 source 记录会把 `capturedThroughSeq` 保留为被引用 Session 原始 generation 中的坐标，绝不会把它重新解释为所在 Session 的 seq。`capturedFormatVersion` 记录该 generation；缺失表示已发布格式 v0。

```ts type-equiv
/** Durable source session, cited event seqs, and snapshot facts for prepared cross-session context. */
interface SessionReferenceSource {
  kind: 'session-reference'
  /** Material lifted out of another session's log (`recall` context form). */
  form: 'recall'
  version: 1
  references: {
    sessionId: string
    label: string
    /** Source Session format generation; absence identifies version 0. */
    capturedFormatVersion?: number
    capturedThroughSeq: OptionalSessionSeq
    compacted: boolean
    originalMessages: number
    retainedMessages: number
    omittedMessages: number
    omittedBytes: number
    truncated: boolean
    inputIndex: number
  }[]
}
```

```ts type-equiv
/** Direct message content and optional referenced-session context. */
interface PreparedReferencedMessage {
  /** Readable message content after host mention tokens are removed. */
  content: ContentBlock[]
  /** Aggregated untrusted snapshot, absent when the message has no references. */
  additionalContext?: UserMessage
}
```

`compact` 源由一次独立的模型请求生成摘要，该请求运行在目标 Session 的路由上：先取其已组装的路由，其次是 agent options，最后是其最近记录的请求头。请求只携带有界投影，因此源 Session 只被读取、绝不被写入：它不会新增压缩括号、检查点或引用记录，并保留自己的历史。持久上下文把摘要放在空的 `conversation` 旁边，源记录写作 `retainedMessages: 0` 且所有消息均被省略；引用原文的预览不会出现这种记录，因为保留逻辑总会保留最新消息。没有对话内容的源按普通的空引用准备，不发起请求。

## 错误

`SessionReferenceError.code` 区分无效配置或输入、自引用、数量限制、源读取失败、预算失败、摘要失败和取消。宿主协议会把这些 code 映射到各自的错误封装，无需检查提示词字节。

```ts type-equiv
/** Stable failure codes exposed to host adapters. */
type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED'
  | 'SESSION_REFERENCE_COMPACT_FAILED'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfilereferences--filereferenceservice-abstract-seam"></a>

### `ctx.fileReferences` — `FileReferenceService` (abstract seam)

Host capability for cancellable file-reference discovery.

```ts cordis-catalog
/**
 * List file and directory candidates for one agent's working directory.
 * @param agent - target agent whose session cwd bounds discovery.
 * @param query - path text following `@` or `@"`.
 * @param signal - caller cancellation.
 * @returns deterministic path-only candidates.
 */
abstract list( agent: Agent, query: string, signal: AbortSignal, ): Promise<FileReferenceCandidate[]>
```

Types: [Agent](core.zh.md)

Source: [`packages/context/file-reference/src/index.ts`](../../packages/context/file-reference/src/index.ts)

<a id="ctxsessionfilereferences--sessionfilereferences"></a>

### `ctx.sessionFileReferences` — `SessionFileReferences`

Host Remote adapter over the composed file-reference provider.

```ts cordis-catalog
/**
 * List file and directory candidates for one Agent's working directory.
 * @param agent - target Agent resolved from the Session identity on the wire.
 * @param query - path text following `@` or `@"`.
 * @param signal - caller cancellation.
 * @returns deterministic path-only candidates from the composed provider.
 */
@Remote list( agent: Agent, query: string, signal: AbortSignal, ): Promise<FileReferenceCandidate[]>
```

Types: [Agent](core.zh.md)

Source: [`packages/api/session-controller/src/file-references.ts`](../../packages/api/session-controller/src/file-references.ts)

<a id="ctxsessionreferenceresolver--sessionreferenceresolver"></a>

### `ctx.sessionReferenceResolver` — `SessionReferenceResolver`

Exact-read consumer that prepares immutable cross-session message context.

```ts cordis-catalog
/**
 * List reference candidates, ranked by working-directory affinity.
 *
 * Discovery runs at keystroke rate, so titles and subagent labels only ever
 * come from projection reads; sessions without either fall back to their id.
 * @param agent - target agent; self is excluded and its cwd drives ranking.
 * @param query - optional case-insensitive session-id/cwd/title/display-title substring.
 * @param limit - optional positive result cap.
 * @param signal - optional cancellation boundary for host autocomplete teardown.
 * @returns candidates with canonical mention labels and presentation titles.
 */
async listCandidates( agent: Agent, query: string = '', limit: number = this.config.candidateLimit, signal?: AbortSignal, ): Promise<SessionReferenceCandidate[]>

/**
 * Remote face of {@link listCandidates}: the configured candidate limit
 * applies, and every candidate carries the canonical mention a host inserts
 * into the prompt draft.
 * @param agent - target agent; self is excluded and its cwd drives ranking.
 * @param query - optional case-insensitive session-id/cwd/title substring.
 * @param signal - caller cancellation.
 * @returns mention-carrying candidates in rank order.
 */
@Remote('candidates') async remoteExportCandidates( agent: Agent, query: string, signal: AbortSignal, ): Promise<SessionReferenceMentionCandidate[]>

/**
 * Snapshot all references for one accepted direct message and return one aggregated durable context.
 * Automatic budgets use the last assembled route, or agent options before any assembly.
 * Missing model capacity or adapter uses 64 KiB; other metadata lookup failures and cancellation reject preparation.
 * Truncated previews include omission facts and a full-snapshot spill locator, or an explicit unavailable notice.
 * Cancellation prevents context publication, including when storage completes after cancellation.
 * @param agent - target agent; references to it are rejected.
 * @param content - already host-normalized readable message content.
 * @param references - structured source sessions in mention order.
 * @param signal - optional cancellation boundary for the active turn.
 * @returns detached content and optional referenced-session context.
 */
async prepare( agent: Agent, content: ContentBlock[], references: SessionReferenceInput[], signal?: AbortSignal, ): Promise<PreparedReferencedMessage>

/**
 * Remote face that writes a `#` source's summary ahead of the send, so picking the session starts the
 * work and sending reuses its result. The source is read, never written.
 * @param agent - the composer's session; references to it are rejected.
 * @param sessionId - the source session to summarize.
 * @param signal - caller cancellation; the shared request keeps running for the send that follows.
 * @returns once the summary is ready.
 */
@Remote('summarize') async remoteSummarize(agent: Agent, sessionId: SessionId, signal: AbortSignal): Promise<void>
```

Types: [Agent](core.zh.md) · [ContentBlock](llm-streaming.zh.md) · [SessionId](core.zh.md)

Source: [`packages/context/session-reference/src/index.ts`](../../packages/context/session-reference/src/index.ts)
<!-- END GENERATED cordis-surface -->
