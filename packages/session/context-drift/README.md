---
description: "Long-context drift score for clients and maintainers composing, tuning, or debugging the contextDrift projection unit."
kind: "package-reference"
---

# @deepseek-ai/dsh-context-drift

English | [中文](README.zh.md)

## Summary

This package estimates how much long-context quality loss the next request carries and recommends compacting or starting a new chat. It serves the `contextDrift` value: a 0–100 score from six signals, each signal's share, the raw readings, and the baseline it measures from. The signals are length against the route's effective context, human turns, mistakes still in context, old-topic share, tool-output share, and compaction layers. The fold makes no model calls and resets on compaction.

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

Mount the plugin beside the session store and the projection registry when clients should show context drift. The web-app bundle mounts it for the session-header drift meter in `dsh-client-ui-context-drift`.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-context-drift'
  config:
    modelProfiles:
      - provider: deepseek-official
        model: deepseek-v4-pro
        effectiveTokens: 120000
```

### The score

Each signal is normalized to 0–1, where `smooth` is the cubic S-curve `x²(3 − 2x)` on `[0, 1]`:

| Signal | Formula |
|---|---|
| Length L | `smooth((live − 0.25·E) / (0.75·E))`, where `live` is the next request's provider-anchored prompt tokens and `E` the effective context |
| Turns T | `smooth((turns − 8) / 22)` over human-typed messages still in context |
| Mistakes M | `1 − exp(−(toolErrors + 2·corrections + 2·loopWarnings + interrupts) / 8)` |
| Stale S | `staleShare × L`, the share of message tokens from earlier topics |
| Noise N | `clamp((toolShare − 0.5) / 0.4) × L` |
| Layers C | `clamp((compactions − 1) / 2)` |

`score = round(100 × (1 − Π(1 − wᵢ·sᵢ)))` with weights length 0.6, turns 0.25, mistakes 0.35, stale 0.4, noise 0.2, and layers 0.3. Each signal's share is `−ln(1 − wᵢ·sᵢ)` over the sum, so shares add up to the score; the largest share is the `cause`. Length alone reaches the high level exactly at `E`; the other signals need each other.

The effective context `E` is the route's `modelProfiles` entry, else `min(windowRatio × window, fallbackEffectiveTokens)`, else the fallback, and never more than `windowRatio × window`. Defaults are 0.5 and 64,000, so an unprofiled 1M-token route uses 64,000.

### Levels and recommendations

| Score | Level |
|---|---|
| below `levels.drifting` (35) | `fresh`, action `none` |
| below `levels.high` (60) | `drifting` |
| from `levels.high` | `high` |

Outside `fresh`, the action is `new-chat` when the session has `newChatAfterCompactions` (2) compactions (`actionReason: 'layers'`), when old topics are the cause (`stale`), or when the baseline is a compaction fewer than `recentCompactionTurns` (3) human turns ago (`recent-compaction`). Otherwise it is `compact` (`cause`). The value also carries the resolved thresholds, including `levels.rearm` (50), which clients use to re-show a dismissed nudge.

### What counts

Only nodes on the retained model-visible surface count. A human turn is a `user/message` with source kind `user`. A correction is a human message right after an assistant reply that matches one of `correctionPatterns` (case-insensitive regular expressions with English and Chinese defaults). Loop warnings are `repeat-tool-reminder` messages, and interrupts are interrupted assistant replies. Provider retries and failed attempts never reach the surface, so they do not count. A human message with at least `topic.minKeywords` (6) keywords, fewer than `topic.minOverlap` (15%) of which appear in the current topic, starts a new topic; tool-call paths join the current topic.

### Failures and recovery

Invalid configuration fails the load. A replacement that names nodes the fold never saw marks the value `degraded: true` and the fold continues, because a throwing projection unit would stop every projection of the session. Unmounting the plugin removes the key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the fold behind the value; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The fold keeps a ledger of the retained surface: one entry per surface node with its heuristic tokens (the token meter's `estimateMessage`), kind, topic, and mistake marks. Replacements splice the ledger exactly as the surface does, so compaction removes shadowed turns and mistakes. Live tokens follow `contextPressure`: the newest provider usage sample plus the heuristic surface change since it. Scoring happens in the wire view from the resolved configuration.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, `inject`, unit registration |
| [`src/config.ts`](src/config.ts) | Configuration schema, defaults, and load-time validation |
| [`src/projection.ts`](src/projection.ts) | The fold: state schema, per-event transitions, wire view |
| [`src/score.ts`](src/score.ts) | The drift formula, shares, levels, and recommendation |
| [`src/text.ts`](src/text.ts) | Keyword extraction, topic overlap, and correction matching |
| [`src/types.ts`](src/types.ts) | The `contextDrift` wire value and its projection-key declaration |

### State version

The state version combines a fold-semantics constant with a hash of the fold configuration (`topic`, `correctionPatterns`), so changing either invalidates persisted checkpoints and the next open refolds.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the registry that serves the value and the surfaces that use it.

- [Session projection subsystem](../../../docs/subsystems/session-projection.md) — the registry that drives units and serves snapshot and change-feed values.
- [Token meter](../../llm/token-meter/README.md) — the heuristic pricing and the `contextPressure` anchoring this unit follows.
- [Context-drift client plugin](../../client/ui-context-drift/README.md) — the session-header meter and composer nudge.

-----

<a id="model-experience"></a>
## Model Experience

None, as the unit folds already-logged events into a client-facing read model and adds nothing model-visible.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what the score can and cannot see. They are current package constraints.

- **Weights are research-derived defaults, not measured on each route** — set `modelProfiles` per route once its quality curve is known; learning `effectiveTokens` from session history is deferred.
- **Topic changes are lexical** — a rephrased topic with no shared keywords can read as a new topic, and a new topic that reuses vocabulary can read as the same one.
- **Corrections are phrase matches** — corrections phrased without a configured pattern are not counted.
- **Message projections are not repriced** — image offload and other content projections keep the heuristic price of the original message, as in `contextBreakdown`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
