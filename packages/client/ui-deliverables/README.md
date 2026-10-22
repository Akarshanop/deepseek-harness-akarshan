---
description: "Changed files, deliveries, and clickable file references for the Web GUI: the changed-files card and delivery cards a finished turn ends with, the review tab that compares each changed file beside a model judgment and a model-written explanation of it, the codebase docs that judgment reads, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

This package renders the changed-files card a finished turn ends with — each file opening the turn's review tab beside a model judgment of the change against the project's generated codebase docs and an explanation of the file — plus cards for explicitly delivered files, and links matching inline-code references in the closing prose. Paths come from the recorded summary, successful mutations, and explicit deliveries, never from the prose. Only the shipped Web patch loads this package; removing its cordis.yml entry removes the guidance, cards, explanations, judgments, codebase docs, and prose links together.

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

Mount this plugin alongside `ui-conversation` and the Host [workspace-changes](../../deliverables/workspace-changes/README.md) plugin; a finished turn then ends with the changed-files card between the closing message's body and its action footer. Without a served summary — a turn that changed no file, the plugin composed out, or a Host restarted since the turn ran — the card is absent and only deliveries and prose links remain; outside a git repository the summary lists file-tool edits only.

Changed-file and delivery entry cards and hover previews follow the [R16 preview-card rule](../../../docs/ui-radius.md#radius-scale); their file-icon tiles use the same rule’s R10 exception. Each retains the same contour on hover.

<a id="explicit-deliveries"></a>
### Explicit deliveries

The `present` tool's preparing stage is one non-expandable document-icon row. It does not show filenames, create delivery cards, or enable file actions before the recorded call supplies arguments.

The Web `standard`, `ptc`, and `cordis` presets expose `present` for final files accessible through the Session filesystem, including files created through Bash. Call it with `files: [{ path, description? }]` after creating the files. The [present tool](../../deliverables/tool-present/README.md) owns file-count limits and Session declarations. A single delivery fills the row; multiple deliveries form a two-column grid, collapsed after four files. Cards show the basename, description or file type, and a shared native opening control. Delivery and changed-file icon tiles use white at 50% opacity in the light theme and 5% in the dark theme. Icon tiles and single-file changed cards use the same border as delivery cards. Clicking the card previews the file in the right Sidebar. The control opens the default application and lists associated applications, with file reveal last. Matching inline-code references also open Sidebar previews. Duplicate declarations use the last description before the closing reply.

The `present` tool row retains its document icon and recorded result across progress, success, failure, and interruption. Native actions share pending state and publish progress or retryable errors on the card. Successful open or reveal feedback stays visible for five seconds, fades over 200ms, then restores the file description; failures remain visible until another attempt. Desktop metadata is loaded when cards mount and invalidated on connection replacement. Without a Host desktop, cards retain Sidebar preview but omit native controls; failed metadata reads offer Retry. Delivery cards and change review expose `deliverables.file.actions` and `deliverables.review.file.actions`, supplied by [ui-open-in-app](../ui-open-in-app/README.md). Association GET requests and native POST actions both validate the recorded file coordinates and Session filesystem mapping before using the Host desktop.

### The changed-files card

Coding Tools must be enabled to show this card or request its summary. Turning the preference off removes the card immediately while explicit delivery cards, inline file links, and recorded workspace changes remain available.

The card renders the summary the Host serves for the turn's latest `workspace/changes` announcement, read once per announcement through the authenticated summary route; while the read is pending, once the Host answers that the summary is gone, or when it lists no file, there is no card. A single changed file shows “Edited” and its basename with its file-type icon, without a file list; its header retains the counts or binary/oversized status and the file’s accessible full path. Multiple files use a code-file icon and a header naming the complete changed-file count and summed added and deleted lines; hovering or focusing it replaces the counts with “Preview in sidebar”. Each row shows one file's display path in the regular UI font with its own monospace counts, “binary” for a binary file, or “too large” for a file the Host did not capture. Rows appear in the recorded display order, so repository files above the working directory and files outside it sort first. Four rows show before a fold; the control reveals every recorded file and, once expanded, collapses the list again from the bottom. Each row opens the turn's review in the right Sidebar on that file, and the header opens it on the first file. Hovering a file row or the single-file header for 500ms opens a scrollable, single-column preview of the comparison, independent of the Sidebar’s view. Its full path uses muted monospace text and scrolls horizontally when needed. File-status notes accompanying code and hunk headers are hidden in the preview; comparisons without hunks retain their status text. Each row exposes the full path as its accessible description. The preview is 48px narrower than the card, inset 24px on each side, and at most 420px high, further constrained by the viewport. The whole preview fades in and out over 100ms. Moving into the preview keeps it open; leaving it, pressing Escape, or activating the row by pointer or keyboard dismisses it. Comparisons load only when the preview opens and share the review tab’s cache and retry states.

### The review tab

A row opens the turn's `changes-review` tab, addressed by the viewed Session and the announcing event's sequence and titled by the turn, on that row's file; another row of the same card reveals the same tab on its file. The header's file selector lists every recorded file with its counts and switches the comparison. A new tab selects the side-by-side view without wrapping. Comparisons containing only additions or only deletions render in one column, including surrounding context, without changing the selected view; mixed changes use the selected view. Its controls switch between unified and side-by-side comparison, toggle line wrapping, open the whole current file in the Sidebar, and, with a Host desktop available, open it in the default application with the same pending and retryable-error states as the cards; the view and wrap choices are kept per tab. The tab reads the summary and each comparison once through the authenticated routes. A text comparison lists its hunks with the old and new line numbers of every line, and highlights each rendered hunk side independently with the code preview's filename grammar and Shiki token colours. Additions and deletions use separate code and line-number backgrounds in each theme, with coloured line numbers, signs, and aligned edge markers; plain code text keeps the primary text colour. The tab also shows a note when the file was created or deleted in the turn, when both sides hold the same lines, when the Host's line comparison timed out and every line shows as replaced, or when the tab stopped drawing at 5,000 lines. A binary or oversized file, a comparison the Host no longer serves, and a failed read each show one line instead; a failed read offers Retry. The comparison is the turn's snapshot of the file, not its current content.

The selected-file title uses the shared `ui-primitives` [`PathLabel`](../ui-primitives/README.md#component-catalog): complete and left-aligned when it fits, otherwise clipped at the left with a fade that preserves trailing characters and the extension. Directories use subdued text, the filename uses primary text, and hovering reveals the complete displayed path. Resizing the pane or selecting another file updates the fade; the dropdown arrow, line counts, and toolbar actions retain their space.

Without wrapping, the two columns synchronize vertical scrolling and horizontal offsets up to each side’s available range. Line backgrounds, including empty alignment rows, cover each column’s full scrollable width. Both columns suppress elastic edge feedback and scroll chaining on both axes; the browser retains control of native momentum within each column’s scrollable range. Both horizontal scrollbars remain at the bottom of the visible comparison; scrolling vertically preserves a long line’s horizontal offset when the other side fits without horizontal scrolling.

### File explanations

The review tab draws a model-written explanation of the selected file beside its comparison: a sentence or two on what the file is for in the project, and a short list of what the turn changed in it. A tab wider than 1,100 pixels shows it as a column to the right of the comparison, after the [judgment](#change-judgments) column; a narrower tab moves both above the comparison, side by side. The sparkle button in the tab header hides and shows it, per tab, and a new tab shows it. Names in backticks render as code, and nothing in the text is read as markup. While the Host is still writing it the panel shows a shimmering placeholder; a failed request shows a Retry button and keeps the comparison. A binary or oversized file, a file with no changed lines, a turn the Host no longer serves, or a Host with `explain.enabled` set to `false` shows no panel and no button.

The Host writes explanations without waiting for a reader. When a turn's changes are recorded it starts the first `explain.eagerFiles` files; any other file starts when its tab asks for it, and a request for a file already being written waits for that one. One request is made per distinct comparison, so a turn recorded again with the same change reuses the explanation. Explanations live as long as the Session in this Host process, like the summaries they describe, so a conversation reopened after a Host restart has none for earlier turns. Each request goes to the Session's current provider and model, or to `explain.provider` and `explain.model` when both are set, at the route's least supported reasoning effort. It carries the file's comparison and, for a file that existed before and after the turn, the first `explain.contextLines` lines of the file as it now stands. It is separate from the conversation: nothing enters the Session log or the model's history.

Configure it on the plugin entry; every field is optional:

```yaml
- name: '@deepseek-ai/dsh-client-ui-deliverables'
  config:
    explain:
      eagerFiles: 8
      provider: my-gateway
      model: a-small-model
```

| Field | Default | Meaning |
|---|---|---|
| `explain.enabled` | `true` | Whether explanations are written; `false` registers no route and starts no request |
| `explain.eagerFiles` | `20` | Files per recorded turn whose explanation starts when the turn's changes are recorded; `0` writes only on request |
| `explain.concurrency` | `2` | Model requests that run at the same time |
| `explain.maxDiffChars` | `24000` | Characters of comparison one request carries; a longer comparison is cut with a marker |
| `explain.contextLines` | `120` | Lines from the start of a modified file, as it now stands, that one request carries |
| `explain.maxOutputTokens` | `4096` | Output-token cap of one request, covering any reasoning the route performs |
| `explain.timeoutMs` | `120000` | Milliseconds one explanation may take, including its wait for a free request |
| `explain.language` | `English` | Language the explanation is written in |
| `explain.provider`, `explain.model` | unset | Explicit route; both or neither. Without them the Session's current route answers |

### Codebase docs

Whenever a top-level Session opens in a project, the Host documents that project's source files with a model and writes the result into the project as a mirror tree: `codebase_docs/src/app.ts.md` documents `src/app.ts`. Each doc states the file's purpose, then one entry per function, class, method, type, constant, route, or command with its parameters, return value, side effects, errors, and the invariants callers rely on, then the file's dependencies and notes. `codebase_docs/INDEX.md` lists every documented file with a one-line summary, and `codebase_docs/.manifest.json` records the SHA-256 of the content each doc was written from. A later run documents only files whose hash changed or that have no doc, and drops deleted files from the index; after each turn the Host documents the files the turn changed again, once the judge has read the earlier docs. By default the directory carries a `.gitignore` of `*`, which keeps the docs out of git and out of the turns' change summaries.

The walk skips directories whose name starts with a dot, the docs directory, and every name in `codebaseDocs.excludeDirectories`, and keeps files with a listed extension up to `codebaseDocs.maxFileBytes`, stopping at `codebaseDocs.maxFiles` files in breadth-first name order. The docs are written on `codebaseDocs.provider` and `codebaseDocs.model` when both are set, otherwise on the default model; when neither names a route, the project starts with the Session's first model request. A file the model cannot document is logged and tried again on the next run.

| Field | Default | Meaning |
|---|---|---|
| `codebaseDocs.enabled` | `true` | Whether projects are documented; `false` also leaves the judge without docs |
| `codebaseDocs.directory` | `codebase_docs` | Project directory the docs are written to |
| `codebaseDocs.extensions` | common source extensions | File extensions, with their dot, that count as source files |
| `codebaseDocs.excludeDirectories` | `node_modules`, `dist`, `build`, `lib`, `out`, `coverage`, `target`, `vendor`, `__pycache__`, `venv`, `bower_components` | Directory names skipped wherever they appear |
| `codebaseDocs.maxFiles` | `500` | Source files documented per project |
| `codebaseDocs.maxFileBytes` | `200000` | Larger source files are left out |
| `codebaseDocs.maxFileChars` | `40000` | Characters of one file a request carries; a longer file is cut with a marker |
| `codebaseDocs.concurrency` | `4` | Model requests that run at the same time across every project |
| `codebaseDocs.maxOutputTokens` | `4096` | Output-token cap of one request |
| `codebaseDocs.timeoutMs` | `180000` | Milliseconds one file's request may take once it starts |
| `codebaseDocs.language` | `English` | Language the docs are written in |
| `codebaseDocs.ignoreInGit` | `true` | Whether the docs directory carries a `.gitignore` of `*` |
| `codebaseDocs.provider`, `codebaseDocs.model` | unset | Explicit route; both or neither. Without them the default model answers |

<a id="change-judgments"></a>
### Change judgments

The review tab draws an LLM judge's verdict on the selected file's change in a column to the left of the explanation. The judge reads the project's codebase docs first — the index, the changed file's doc as it stood before the turn, and the docs of the project files it imports through relative JavaScript, TypeScript, or Python imports — then the developer's prompt for the turn, the list of files the turn changed, the comparison, and the file as it now stands with line numbers. The panel shows the verdict (implemented properly, has concerns, or likely wrong), the judge's confidence from 0 to 100 as text and as a bar, a one-sentence summary, the issues ordered from high to low severity with their line, a check per aspect (matches the request, consistent with the codebase docs, correctness, error handling and edge cases, security, tests) with a pass, warning, fail, or not-applicable mark and a reason, and optional suggestions. When the file had no doc yet or the turn's prompt was not observed by this Host process, the panel says so. The shield button hides and shows it, per tab; loading, retry, and absence follow the explanation's rules, under `judge.enabled`.

The Host starts the first `judge.eagerFiles` judgments when a turn's changes are recorded and serves each from `/api/changes.judge`. A judgment is kept per turn and comparison for the Session's life in this Host process. Each request goes to the Session's current route, or to `judge.provider` and `judge.model` when both are set, at the route's least supported reasoning effort. With the codebase docs composed out, the judge reads the code alone.

| Field | Default | Meaning |
|---|---|---|
| `judge.enabled` | `true` | Whether judgments are written; `false` registers no route |
| `judge.eagerFiles` | `20` | Files per recorded turn whose judgment starts when the turn's changes are recorded |
| `judge.concurrency` | `2` | Model requests that run at the same time |
| `judge.maxDiffChars` | `24000` | Characters of comparison one request carries |
| `judge.contextLines` | `400` | Lines of the file as it now stands that one request carries |
| `judge.maxDocChars` | `12000` | Characters of the changed file's doc |
| `judge.maxRelatedDocs`, `judge.maxRelatedChars` | `4`, `12000` | Imported files' docs carried, and their total characters |
| `judge.maxIndexChars` | `8000` | Characters of the project index |
| `judge.maxRequestChars` | `4000` | Characters of the turn's prompt |
| `judge.maxOutputTokens` | `4096` | Output-token cap of one request |
| `judge.timeoutMs` | `180000` | Milliseconds one judgment may take once its request starts |
| `judge.language` | `English` | Language of the judgment's prose |
| `judge.provider`, `judge.model` | unset | Explicit route; both or neither. Without them the Session's current route answers |

### Inline-code links

The closing prose links produced or delivered paths: an inline-code token resolves by exact target, by an exact argument recorded for that target, or by a unique basename. Every matching fact must identify the same file; ambiguous arguments and basenames stay inert. No suffix or current-directory guess is used. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section described under [Model Experience](#model-experience). Explicit Markdown links use the shared [Markdown renderer](../ui-primitives/README.md); inline-code matching remains limited to produced or delivered files. The browser half registers a wrapper around the changed-files card and explicit deliveries into the chat view's `conversation.chat.turnTail` list alongside other feature artifacts. `deliverablesDefinition` folds the sequence of each Turn's latest validated `workspace/changes` announcement into `DeliverablesTurnData.changes`, whose summary the card reads from the Host and caches until the connection is replaced, its `deliverables/presented` events into deliveries, and the successful first-party mutation calls of `write`, `edit`, and mutating `str_replace_editor` commands into recorded file targets and exact argument aliases after validating their raw arguments; the produced paths feed only the prose mention resolver. Successful absolute `meta.path` values identify those targets. Root results without that field retain the legacy argument fallback; malformed relative targets contribute no guessed path. Reads, deletes, unsupported tools, malformed calls, malformed events, and failed results contribute nothing. Each row opens `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>` through `ctx.sidebarRight.openResource` with the file's index as the `changes-review` navigation parameter; the package registers the `changes-review` tab type at the `builtin` band for that pattern and its body under the keyed `sidebar.right.pane.tab` seat with an exclusive store of per-tab choices, and the body reads the summary and the comparisons through the authenticated routes into stores cleared on connection replacement. The package also provides the `chatFileMentions` service the chat view consults per closing message, and the `chatRewind` service behind Chat's prompt rewind: the authenticated `/api/changes.rewind` route answers GET with the conversation cut point before the turn (the previous `turn/end` and the standalone events after it) and `workspaceChanges.rewindPlan`, and answers POST by running `workspaceChanges.rewind`, refusing with 409 while a turn of the Session runs. Composing the plugin out removes every surface and leaves the view's empty list at zero cost.

Native opening uses an authenticated POST addressed by the viewed Session, event sequence, and original file index; the review tab's native open of a changed file uses the same coordinates. For a declaration the Host reads the viewed Session header with the event and passes its cwd, or the deployment workspace root when absent, to `workspaceFiles.stat`; for a changed file it passes the working directory the served summary carries. This uses the same composed filesystem as Sidebar previews and does not activate an Agent, including for child Sessions. Native actions require the canonical process path to map from a Host path back to that same process path. Providers without this mapping return 422, after which the review tab hides its native open; a same-named Host file is insufficient. The same configured desktop availability governs metadata and execution. Edits affect subsequent opens; deletion returns an error. No file-content copy or attachment is created. Plugin disposal cancels and awaits pending native-open requests.

The Node half also registers the explanation route and the eager start (`explain-host.ts`) around a `ChangeExplainer` (`explain.ts`) that holds no service. It caches one promise per Session and per SHA-256 of the file's path and hunks, so concurrent and repeated requests and re-recorded turns share one model request; a failed entry is removed so the next request writes it again; a counting gate limits simultaneous requests; and each request's signal combines plugin disposal, Session disposal, and `explain.timeoutMs`. The route waits on that promise, and its request signal only ends the wait. `ctx.get('llm')` and `ctx.get('sessions')` are read per request, so a composition without them answers 500 instead of failing to load. The eager start reads the summary one microtask after the `workspace/changes` event, because the recorder keeps the summary right after appending the event. The answer is parsed tolerantly: emphasis around the labels, code fences, and `<think>` blocks are removed, an answer without labels becomes the change list, and at most eight changes are kept. The browser half reads the route through `ChangesExplainStore`, which shares `jsonReadPolicy` with the comparison store, and `ReviewTab` waits for its seeded tab state before asking, so a tab opened on another file never requests the first file's explanation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the card to the Host recorder, the turn-tail hole, and the decisions behind the vocabulary.

- [workspace-changes](../../deliverables/workspace-changes/README.md) — the Host plugin that records and serves the summary the card renders.
- [ui-chat](../ui-chat/README.md) — declares the `conversation.chat.turnTail` hole and renders the closing prose.
- [historical Turn changed-files card](../../../.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md) — the decision behind git-recorded summaries replacing the mutation-call row.
- [historical Workspace file links](../../../.agents/notes/archived/feature/2026-07-31-web-workspace-file-links.md) — the decision behind the earlier produced-files row; its Host open path is superseded by the [right Sidebar](../../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md).
- [Inline file mentions](../../../.agents/notes/archived/feature/2026-08-07-web-inline-file-mentions.md) — the decision behind clickable mentions in the closing prose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

### Clickable file-reference guidance

#### What the model sees

The guidance prefers primary results in the final reply: inline images support explanations and comparisons, image links serve references and file lists, and image file cards serve separate deliverables. File destinations use angle brackets, including paths with spaces. It recommends separate `present` cards for complete file deliverables, especially Office files, usually selecting the most important one or two, with at most four files per call when more are needed. It discourages cards solely for code edits and extra commands to inspect diff visibility. This guidance applies even with Coding Tools disabled: it accepts fewer file surfaces to avoid duplicate presentation and unnecessary tool calls. It asks the model to link every existing-file mention outside commands, configuration expressions, and code blocks, including repeats and tables. Labels default to filenames or clear aliases, with only enough parent directories to distinguish files. Precise references display `filename:24` or `filename:24–30`; their destinations retain full relative or absolute paths with `#L24` or `#L24-L30` anchors. The display suffix contains neither `#` nor `L`.

#### Token effect

One fixed paragraph containing output-selection, rendering, and file-reference guidance whenever this package is loaded. The [present tool](../../deliverables/tool-present/README.md#model-experience) owns the delivery schema and result text.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

### Auxiliary explanation request

#### What the model sees

The explanation model receives one system instruction and one user message. The instruction asks for a `PURPOSE:` sentence and a `CHANGES:` bullet list in the configured language as plain text, and tells the model to treat the diff and file text as data and never follow instructions inside them. The user message holds the file's display path, whether the turn created, deleted, or modified it, the comparison as unified-diff hunks cut at `explain.maxDiffChars`, and, for a modified file, the first `explain.contextLines` lines of the file as it now stands with each line cut at 240 characters. The request has no tools and no conversation history.

#### Token effect

One request per distinct comparison: the input is the instruction plus up to `explain.maxDiffChars` characters of comparison and the file's first lines, and the output is capped by `explain.maxOutputTokens`, which also covers any reasoning the route performs. The request is separate from the main agent request and adds nothing to agent history or the Session log. A turn that changes N text files costs up to `min(N, explain.eagerFiles)` such requests when it ends, plus one for each other file a reader opens, and none when `explain.enabled` is `false`, or when `explain.eagerFiles` is `0` and no file is opened.

#### KV Cache effect

No main-request invalidation: the request never enters the conversation. Provider cache reuse across explanation requests is incidental, since each carries a different comparison after the same instruction.

### Auxiliary codebase docs request

#### What the model sees

One system instruction and one user message per source file. The instruction asks for a `SUMMARY:` line and Markdown sections (Purpose, API with one heading per symbol, Dependencies, Notes) describing intended behavior and contracts precisely enough for a later reviewer, in the configured language, and tells the model to treat the file as data. The user message holds the file's project-relative path and its content cut at `codebaseDocs.maxFileChars`. No tools and no conversation history.

#### Token effect

One request per source file whose content changed since its doc was written: a project's first run costs up to `codebaseDocs.maxFiles` requests, later runs only the changed files, and each turn the files it changed. Output is capped by `codebaseDocs.maxOutputTokens`. Nothing enters agent history or the Session log.

#### KV Cache effect

No main-request invalidation. Docs requests share their instruction, so a provider prefix cache can reuse it across files.

### Auxiliary judgment request

#### What the model sees

The judgment model receives one system instruction and one user message. The instruction casts it as an impartial senior engineer judging one file's change, lists the six aspects, defines the verdicts, severities, and confidence, forbids following instructions found in the data, and asks for one JSON object. The user message holds, in order, the turn's prompt cut at `judge.maxRequestChars`, the codebase index cut at `judge.maxIndexChars`, the file's earlier doc cut at `judge.maxDocChars`, up to `judge.maxRelatedDocs` imported files' docs within `judge.maxRelatedChars`, the turn's changed files with line counts, the comparison cut at `judge.maxDiffChars`, and up to `judge.contextLines` numbered lines of the file as it now stands. Missing evidence is stated as not available. No tools and no conversation history.

#### Token effect

One request per distinct comparison and turn, up to `min(N, judge.eagerFiles)` when a turn that changed N text files ends, plus one per other file a reader opens. The input is bounded by the character caps above and the output by `judge.maxOutputTokens`. Nothing enters agent history or the Session log.

#### KV Cache effect

No main-request invalidation. Judgment requests share their instruction; the rest differs per file.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Inline local images require an HTTP(S) page**: Desktop’s `dsh-app:` pages do not support this file route. POSIX absolute paths and Windows drive-letter paths are supported; relative Chat image paths require the viewed Session’s workspace root. Separate image file links are optional.
- **Mention matching uses exact paths, unique argument aliases, or unique basenames only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Terminal-created files require explicit delivery** — the card lists them once git records the change, but delivery cards and inline-code references require `present`; explicit Markdown links can reference existing files directly.
- **Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session’s filesystem. Missing files, directories, and final symbolic links return 404.
- **Native opening needs a Host desktop** — without one the review tab offers no native open; the comparison itself needs only the Host that recorded the turn.
- **Comparison highlighting is hunk-local** — each rendered old and new hunk side is tokenized independently because omitted source lines are unavailable; unknown suffixes remain plain, and the tab draws at most 5,000 lines before saying so.
- **Comparisons carry whole file text** — the comparison route serves a listed file's complete text wherever the Host recorded it, including ignored files and files outside the workspace root the Sidebar previews are confined to.
- **Explanations are model output and can be wrong** — the model sees one file's comparison and the start of the file, not the rest of the project or the conversation, so a stated purpose can be a guess from the path and the visible lines.
- **Explanations spend tokens when nobody reads them** — each turn starts its first `explain.eagerFiles` files whether or not the review tab opens; lower the count, set it to `0`, or set `explain.enabled` to `false` to trade readiness for cost.
- **Explanations last as long as the Session in this Host process** — like the summaries and comparisons they describe, a Host restart drops them.
- **Codebase docs are written into the project** — they are files in `codebase_docs/` that any tool, including the agent, can read; delete the directory to have them written again, and set `codebaseDocs.enabled` to `false` to stop writing them.
- **A project's first documentation run costs one request per source file** — up to `codebaseDocs.maxFiles` requests run in the background when a Session first opens in a project; judgments made before it finishes say the file had no docs.
- **Judgments are model output and can be wrong** — the judge sees the docs, one file's change, and the start of the file, not the whole project or the conversation; its confidence is its own estimate, not a measured accuracy.
- **The judge knows a turn's prompt only from this Host process** — a turn recorded before a Host restart, or a resumed Session's earlier turns, are judged without the request.
- **The language is configured, not inferred** — `explain.language` applies to every Session, while the tab labels follow the interface language.
- **Files outside the workspace open by absolute path only** — the recorded path is the Host path at recording time; a moved workspace or a different viewing Session cannot relocate it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
