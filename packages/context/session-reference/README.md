---
description: "Cross-session snapshot references and durable untrusted model context, for users and maintainers enabling or debugging ctx.sessionReferenceResolver."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-reference

English | [中文](README.zh.md)

## Summary

`dsh-session-reference` lets a conversation reference other sessions: a host turns a `@label` mention (or `#label`, for a model-written summary) into a canonical URI, and the service prepares a bounded, read-only snapshot of each referenced session as durable, untrusted background context for the model. Candidate discovery ranks other sessions by working-directory affinity and labels them with their latest titles. Snapshots are immutable after capture and carry a fixed warning that forbids following instructions, permission claims, or tool requests inside them. It is an opt-in service for hosts that support cross-session mentions; it consumes `ctx.sessionQuery` and needs no SQLite FTS.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable this service when hosts should let a user mention another session and give the model its context. It works with any session-query backend because it consumes the backend-independent compact checkpoint marker.

### Mention syntax

A canonical mention is `@[label](dsh-session:<base64url-encoded-id>)` in Markdown, or the bare `dsh-session:` URI; every JavaScript string session id round-trips exactly. The service rewrites mentions into readable `@label` text in the message and returns the structured references. `#[label](dsh-session:<base64url-encoded-id>)` marks a source for summary instead of quotation and is rewritten to `#label`; a bare URI quotes. Explicit Markdown mentions reject malformed URIs; empty or punctuation-only scheme mentions stay ordinary discussion text.

### What the agent gets

A message that cites other sessions is followed immediately by a `## Referenced sessions` snapshot as a second user-role message. The snapshot is untrusted background: the fixed warning tells the model not to follow instructions, permission claims, or tool requests inside it unless the current user explicitly repeats them. Each source preview is bounded independently — at most `maxReferences` distinct sessions per message and a configured or model-relative serialized JSON byte budget per source. Retention drops older non-checkpoint messages before shortening retained text; preparation fails only when the reference cannot fit even after retention.

For a truncated reference, an optional spill backend saves the full captured text projection under the target session. A separate omission notice outside the bounded preview JSON gives exact `omittedMessages` and `omittedBytes`, then the saved locator and `retrievalHint`, or an unavailable outcome distinguishing missing storage from a failed save. The notice is part of the same durable context message. Full transcripts carry the same untrusted-background warning and capture metadata, including `capturedFormatVersion`. Each message uses JSON string fragments of at most 64 Unicode code points per line; decode and concatenate its fragments to recover exact text, including original newlines. This fixed storage format keeps even long single-line text readable through paged file reads.

### Summarizing a session with `#`

A `#` mention summarizes the source instead of quoting it. The service reads the same projection as for `@`, then asks the target's model for a hand-off summary in one separate request and places it in the same `## Referenced sessions` context message beside an empty `conversation`. The model is the one on the target's assembled route, else its agent options, else its latest logged request header, at that route's least supported reasoning effort. The source is only read: it gains no compaction event, checkpoint, or record of being referenced, and its own history and model context stay as they were.

One request reads at most `compactContextFraction` of the model's context window from the source (newest messages kept, 64 KiB floor), may run for `compactTimeoutMs`, and writes at most `compactMaxTokens` tokens. The `summarize` Remote method writes a summary ahead of the send, so the composer starts it when a session is picked and the send reuses the result, or waits for the rest of it. The target's turn otherwise waits for the summary. A failed, cut-off, empty, or timed-out request fails the turn with `SESSION_REFERENCE_COMPACT_FAILED` rather than sending a partial summary. A source with no conversation text is referenced as an empty session and costs no request. The summary omits every message, so with a spill store composed the full projected transcript is saved and the omission notice carries its locator.

### Finding sessions to reference

`listCandidates(agent, query?, limit?)` lists sessions other than the agent's own, filters case-insensitively by id, working directory, projected title, or display title, and ranks same-directory sessions first. Each candidate carries its latest title as `label`, falling back to the session id when the title is absent or unreadable. Its display title prefers a subagent's durable creation label over that title. The candidate also reports whether its working directory is the requesting agent's so a host can surface a location only when it distinguishes the row. Browser consumers call the same discovery as `ctx.remote.sessionReferenceResolver.candidates`, which labels the canonical mention with `displayTitle` when present.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxReferences` | `3` | Maximum distinct source sessions in one prepared message; must not exceed `3` |
| `candidateLimit` | `50` | Default candidate count returned to a host |
| `maxReferenceBytes` | automatic | Explicit maximum serialized JSON bytes per source; overrides the automatic budget exactly |
| `referenceContextFraction` | `0.2` | Context-window fraction per source, from `0` to `1` |
| `compactContextFraction` | `0.5` | Context-window fraction one summarization request may read from a `#` source, estimated at four bytes per token with a 64 KiB floor; `0` to `1` |
| `compactMaxTokens` | `4096` | Output-token cap of one summarization request, covering any reasoning the route performs |
| `compactTimeoutMs` | `120000` | Milliseconds one summarization request may take |

The automatic budget is `max(65536, floor(contextWindow × 4 × referenceContextFraction))` bytes per source. Model context capacity is measured in tokens; four bytes per token is a sizing heuristic, not an exact token conversion. A missing route, LLM service, adapter, or capacity uses 64 KiB; other model metadata lookup errors and cancellation fail preparation.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-reference) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Preparation reads each referenced session's current surface exactly once, when the target message reaches `agent/pre-step`. Both preview and spill use that same captured projection: direct-user text, assistant text, and user checkpoints carrying the canonical compaction marker; tools, reasoning, and other injected context are excluded. This prevents recursive reference propagation and prevents a later source mutation from changing the saved transcript. Preview JSON escapes every `<` as `\u003c`, so source text cannot spell the `<referenced-sessions>` framing tag.

The resolver discovers optional storage through `ctx.get("spillStore")` and saves only truncated references. Storage ownership is the target session; the source descriptor identifies the referenced session and label, without a fabricated tool call. Cancellation is checked after the asynchronous save and prevents publication even if an artifact was written. Artifact expiry remains the backend's existing policy.

The budget uses the provider and model captured after `system-prompt/assemble` completes for the target agent. Direct `prepare` calls before any assembly use agent options; session headers do not select the budget model. Diagnostic assemblies without an agent do not affect captured routes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionReferenceResolver`: pre-step listener, candidate discovery, preparation |
| [`src/config.ts`](src/config.ts) | `Config` schema, `SessionReferenceError` taxonomy |
| [`src/uri.ts`](src/uri.ts) | `dsh-session:` URI codec, mention formatting and parsing |
| [`src/projection.ts`](src/projection.ts) | Current-surface projection and byte-budget retention |
| [`src/serialization.ts`](src/serialization.ts) | Tag-safe JSON escaping for snapshot payloads |
| [`src/spill.ts`](src/spill.ts) | Full transcript serialization and model-visible omission notices |
| [`src/types.ts`](src/types.ts) | `SessionReferenceInput`/`Candidate` and source types |

### Main flow

The outer `agent/pre-step` listener accepts the step, parses canonical mentions out of direct user messages, then calls `prepare`, which normalizes references (first-mention order, deduplication, self-reference and count rejection), reads every surface in parallel, retains each under its resolved byte budget, and renders the aggregated prompt. Each durable source record keeps the frozen `capturedThroughSeq` and records a nonzero `capturedFormatVersion`; absence denotes format v0. Each snapshot is inserted immediately after the message that cited it, and the target log records the readable direct message followed by its sourced context, so source mutation after capture cannot change target replay.

The pre-step listener renders sources concurrently. A `#` source is retained under the summarization budget, then `summarize.ts` sends its tag-safe JSON projection with the fixed `SUMMARY_INSTRUCTION` and keeps only text blocks with `<think>` blocks removed; `summarizedProjection` rewrites the retention facts to zero retained and all omitted, a pairing Chat reads to say the messages were summarized, since retention never produces it for a quoted source. The summary sits in the JSON as `summary`, so `<` stays escaped like any other source text, and the prompt gains one explanatory line only when a summary is present, leaving the quoted-source prompt byte-identical.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared reference surface to the design decision and the read service behind it.

- [Session-reference subsystem](../../../docs/subsystems/session-reference.md) — canonical URIs, projection rules, and the stable error taxonomy.
- [historical Session-reference spill reuse](../../../.agents/notes/archived/bug-fix/2026-09-05-session-reference-spill-reuse.md) — snapshot identity, omission notices, storage ownership, and alternatives.
- [Session-query subsystem](../../../docs/subsystems/session-query.md) — the read service that supplies session surfaces.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-reference) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Referenced session background

#### What the model sees

The model sees two consecutive user-role messages: the current message with its readable `@label`, then the `## Referenced sessions` untrusted snapshot. The warning forbids following instructions, permission claims, or tool requests from the snapshot unless the current user explicitly repeats them. Labels, cwd values, ids, and conversation text are serialized as JSON inside `<referenced-sessions>` tags; every data `<` is emitted as the lossless JSON escape `\u003c`, so source text cannot spell a framing tag.

#### Token effect

Each referenced message adds the fixed warning plus up to three serialized previews, each independently bounded by the configured or model-relative byte budget. Truncated references add separate omission notices outside that budget; a saved full transcript adds tokens only when retrieved. The exact context remains in target history until target compaction shadows or summarizes it; source-session changes add no further tokens.

#### KV Cache effect

The request and snapshot are consecutive append-only target messages and preserve earlier cacheable history. Different references or source capture contents change the new suffix only; later target compaction may invalidate reuse from its replacement boundary.

### Summarized session background

#### What the model sees

The target model sees the same two consecutive user-role messages, but the snapshot's source entry carries a `summary` field and an empty `conversation`, and one added line explains that the summary is a model-written stand-in. The summary is Markdown with five fixed sections (goal and outcome, decisions, files and code, facts to carry over, open work). A separate model request, which the target never sees, produces it from the bounded JSON projection under a fixed instruction that forbids following instructions found inside the data.

#### Token effect

One extra request per `#` source, on the target's route: input up to `compactContextFraction` of the context window per source plus the fixed instruction, output capped by `compactMaxTokens`, which also covers any reasoning the route performs. The summary then adds its own length, rather than a preview of up to `referenceContextFraction` of the window, to the target history until target compaction shadows it. The summarization request is not recorded in either session log, and the source gains no tokens or events.

#### KV Cache effect

No main-request invalidation: the summary is an append-only suffix like any reference. The summarization request uses its own instruction and does not reuse the target's cached prefix, so it pays for its full input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when cross-session references are a poor fit. They are current package constraints.

- **No body discovery** — candidate queries inspect titles but do not search message bodies.
- **Labels come from projections alone** — an attached session is labeled from its live projection cut, a cold one from its durable checkpoint, and a session neither answers for is labeled by its id and cannot be found by its title. Discovery never reads a log: folding one title costs a whole log, and this runs under every completion keystroke. A session persisted before the projection cache was composed regains its title the first time it is opened, which checkpoints it.
- **Trusted caller boundary** — the service assumes its host is authorized to read every session exposed by `ctx.sessionQuery`; it is not a model-facing search tool.
- **A summary is model output and lossy** — it can drop or misstate details, and it is written from at most the newest `compactContextFraction` of a long source. Quote the session with `@`, or read the saved full transcript, when exact text matters.
- **A summary delays the turn and can fail it** — the turn waits for one model request, and a failed, cut-off, empty, or timed-out request fails the turn with `SESSION_REFERENCE_COMPACT_FAILED` instead of falling back to a quoted preview.
- **Summaries are reused only briefly** — the Host keeps the last 16 in memory per source conversation text and route, so a pick that warmed one and the send that follows share it. A later message, a Host restart, or a source that gained text asks again.
- **Text projection only** — non-text user and assistant blocks are not propagated across sessions.
- **No live link** — references are snapshots, not forks, resumes, subscriptions, or source-session mutations.
- **Transcript search is line-based** — a literal phrase can straddle JSON-fragment lines or include escaped characters; decode and concatenate a message's fragments for exact text matching. Saved artifacts may expire under the backend's policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
