---
description: "Session-header context-drift meter and composer nudge for users and maintainers reading, composing, or debugging the drift surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-context-drift

English | [中文](README.zh.md)

## Summary

This plugin shows how much long-context quality loss a chat carries. A meter in the session header shows the drift score with a level-tinted bar; hovering or clicking it opens a card with the readings, the main cause, the baseline, and Compact and New chat buttons. While drift is high, a nudge above the composer recommends the action that fits the cause. The value comes from the host `contextDrift` projection in `dsh-context-drift`.

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

Mount this client row with the host `dsh-context-drift` row; the web-app bundle mounts both. Without the host row the projection is absent and both surfaces render nothing.

### Composition

```yaml
- name: '@deepseek-ai/dsh-context-drift'
- name: '@deepseek-ai/dsh-client-ui-context-drift'
```

### What you see

| Surface | Behavior |
|---|---|
| Header meter | Gauge glyph, a short bar, and the score in the session-header utilities; green while fresh, amber while drifting, red when high. Hidden on blank sessions with the rest of the header chrome |
| Breakdown card | Opens after a short hover or on click; lists live versus effective tokens, the context window, turns, failed tool calls, corrections, repeat-call warnings, interrupted replies, old-topic and tool-output shares, compactions, the main cause with its share, and the baseline with its age |
| Composer nudge | Appears above the composer at the high level with the advice for the recommended action and both buttons, the recommended one first |

**Compact now** runs `/compact` in the session through the Commands Remote, so the transcript records it like a typed command; a failure line from the command appears inline. **New chat** opens a new session whose draft holds a `#` reference to this one, so the host summarizes this chat into the new one when the draft is sent.

Dismissing the nudge hides it for the current baseline. It shows again once the score falls below the host's re-arm threshold, or after a compaction moves the baseline. The dismissal is stored per session in this browser's local storage; where storage is blocked it lasts for the page view.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the surfaces are wired; the observable behavior is covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the header-utilities and input-dock registrations, and the session-bound actions |
| [`src/client/DriftChip.tsx`](src/client/DriftChip.tsx) | Header meter, hover and pinned card, Escape and outside-click dismissal |
| [`src/client/DriftCard.tsx`](src/client/DriftCard.tsx) | Card body, level tints, and the shared compact and new-chat controls |
| [`src/client/DriftNudge.tsx`](src/client/DriftNudge.tsx) | Composer nudge and its dismissal arming |
| [`src/client/model.ts`](src/client/model.ts) | Session-reference mention encoding, nudge arming rules, and token formatting |
| [`src/client/locales.ts`](src/client/locales.ts) | Chinese and English dictionaries |
| [`src/index.ts`](src/index.ts) | Inert node half so the package is an ordinary Loader row |

### Session reference

The new-chat draft uses the canonical `dsh-session:` URI that `dsh-session-reference` parses: unpadded base64url of the UTF-8 JSON session id. The browser encoder matches the host encoder byte for byte, and the label escapes backslashes and closing brackets.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the value the surfaces render and the commands they run.

- [Context-drift projection](../../session/context-drift/README.md) — the score, its signals, levels, and recommendations.
- [Compact command](../../compaction/command-compact/README.md) — what `/compact` does and the messages it reports.
- [Session reference](../../context/session-reference/README.md) — how a `#` reference summarizes another session into a prompt.

-----

<a id="model-experience"></a>
## Model Experience

None directly. Compact now runs the existing `/compact` command, and New chat drafts a `#` session reference that the user sends; their model-visible effects belong to `dsh-command-compact` and `dsh-session-reference`.

#### KV Cache effect

None from this plugin; a compaction it starts rewrites history with the compaction package's documented cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what the surfaces do not cover. They are current package constraints.

- **Compact is not disabled while the agent works** — the command answers busy and the failure line appears inline.
- **The reference label is generic** — the new-chat draft labels the reference with the localized "previous chat" text rather than the session title.
- **Dismissal is per browser** — another browser or device shows the nudge again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
