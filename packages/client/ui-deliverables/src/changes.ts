/** Validate workspace-change records that cross the Host routes and address their summary, comparison, and native-open actions. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff, WorkspaceRewindPlan, WorkspaceRewindResult,
} from '@deepseek-ai/dsh-workspace-changes/types'

/** Authenticated GET route serving one announced change summary while its Session lives. */
export const CHANGED_FILES_PATH = '/api/changes.summary'

/** Authenticated GET route serving one listed file's turn-start and turn-end comparison while its Session lives. */
export const CHANGES_DIFF_PATH = '/api/changes.diff'

/** Authenticated POST route for opening a changed file on the Host desktop. */
export const CHANGES_OPEN_PATH = '/api/changes.open'

/**
 * Authenticated GET route serving the model-written explanation of one listed file's change. A request
 * waits for the explanation when it is still being written, so a response is the final answer.
 */
export const CHANGES_EXPLAIN_PATH = '/api/changes.explain'

/**
 * Authenticated GET route serving the model judgment of one listed file's change against the project's codebase
 * docs. A request waits for the judgment when it is still being written, so a response is the final answer.
 */
export const CHANGES_JUDGE_PATH = '/api/changes.judge'

/**
 * Authenticated route rewinding a Session to the start of one turn: GET serves what the rewind would
 * put back and where its conversation would be cut, POST puts the files back.
 */
export const CHANGES_REWIND_PATH = '/api/changes.rewind'

/**
 * Browser-relative form of {@link CHANGED_FILES_PATH}; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
export const CHANGED_FILES_ROUTE = CHANGED_FILES_PATH.slice(1)

/** Browser-relative form of {@link CHANGES_DIFF_PATH}. */
export const CHANGES_DIFF_ROUTE = CHANGES_DIFF_PATH.slice(1)

/** Browser-relative form of {@link CHANGES_OPEN_PATH}. */
export const CHANGES_OPEN_ROUTE = CHANGES_OPEN_PATH.slice(1)

/** Browser-relative form of {@link CHANGES_EXPLAIN_PATH}. */
export const CHANGES_EXPLAIN_ROUTE = CHANGES_EXPLAIN_PATH.slice(1)

/** Browser-relative form of {@link CHANGES_JUDGE_PATH}. */
export const CHANGES_JUDGE_ROUTE = CHANGES_JUDGE_PATH.slice(1)

/** Browser-relative form of {@link CHANGES_REWIND_PATH}. */
export const CHANGES_REWIND_ROUTE = CHANGES_REWIND_PATH.slice(1)

/** What rewinding to the start of one turn would do, as the rewind route's GET serves it. */
export interface ChangesRewindPreview extends WorkspaceRewindPlan {
  /** The last event seq the rewound conversation keeps, or null when the turn has no earlier cut point. */
  atSeq: number | null
  /** Whether a turn of the Session is running; the files are not put back while it runs. */
  running: boolean
}

/** What the rewind route's POST put back. */
export type ChangesRewindResult = WorkspaceRewindResult

/** Resource-address prefix of a turn's review tab in the right Sidebar. */
export const CHANGES_REVIEW_ADDRESS = 'dsh-resource://changes-review/session/'

/** The summary fields the route serves; the Host keeps the working directory and snapshot ids to itself. */
export type ChangesSummary = Pick<WorkspaceChangesSummary, 'turn' | 'files' | 'total' | 'added' | 'deleted'>

/** The comparison the route serves, as the Host computed it. */
export type ChangesDiff = WorkspaceFileDiff

/** What a model wrote about one changed file: its role in the project and the changes the turn made to it. */
export interface ChangesExplanation {
  /** What the file is for; empty when the model gave no separate statement of it. */
  purpose: string
  /** One entry per logical change, in the order the model listed them. */
  changes: string[]
}

/** The judge's overall finding: correct, correct with concerns, or likely wrong. */
export type JudgeVerdict = 'pass' | 'concerns' | 'fail'

/** How much one issue matters. */
export type JudgeSeverity = 'high' | 'medium' | 'low'

/** One reviewed aspect's outcome; `na` when the aspect does not apply or cannot be assessed. */
export type JudgeCheckStatus = 'pass' | 'warn' | 'fail' | 'na'

/**
 * The aspects every judgment reviews, in display order: fit with the turn's request, consistency with the
 * codebase docs, logical correctness, error handling and edge cases, security, and test coverage.
 */
export const JUDGE_ASPECTS = ['request', 'docs', 'correctness', 'errors', 'security', 'tests'] as const

/** One reviewed aspect. */
export type JudgeAspect = typeof JUDGE_ASPECTS[number]

/** One problem the judge found in the change. */
export interface JudgeIssue {
  severity: JudgeSeverity
  /** A short name of the problem. */
  title: string
  /** What is wrong, why, and how to fix it; empty when the title says it all. */
  detail: string
  /** Line in the file as it now stands, when the issue has one. */
  line?: number
}

/** One aspect's outcome with its reason. */
export interface JudgeCheck {
  aspect: JudgeAspect
  status: JudgeCheckStatus
  note: string
}

/** What a model judged about one changed file, having read the project's codebase docs and the turn's request. */
export interface ChangesJudgment {
  verdict: JudgeVerdict
  /** How sure the judge is of the verdict, 0 to 100. */
  confidence: number
  /** One or two sentences on the change's state. */
  summary: string
  /** Problems ordered by severity. */
  issues: JudgeIssue[]
  /** One entry per reviewed aspect the answer covered, in {@link JUDGE_ASPECTS} order. */
  checks: JudgeCheck[]
  /** Optional improvements that are not problems. */
  suggestions: string[]
  /** Which evidence the judge had: the file's codebase doc and the turn's request. */
  basis: { docs: boolean; request: boolean }
}

/** Coordinates of one turn's review: the viewed Session, the announcing event, and the turn it summarized. */
export interface ChangesReviewCoordinates {
  sessionId: SessionId
  seq: number
  /** The summarized turn, carried for the tab title. */
  turn: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one changed-file record read from the summary route.
 * @param value - decoded JSON.
 * @returns whether the record carries a path, a display path, and line counts.
 */
export function isChangedFile(value: unknown): value is WorkspaceChangedFile {
  if (!isRecord(value)) return false
  const { path, display, added, deleted, binary, oversized } = value
  return typeof path === 'string' && path.length > 0 && typeof display === 'string' && display.length > 0
    && Number.isSafeInteger(added) && Number.isSafeInteger(deleted)
    && (binary === undefined || binary === true) && (oversized === undefined || oversized === true)
}

/**
 * Validate a summary read from the summary route.
 * @param value - decoded JSON.
 * @returns whether the value identifies a turn, a complete file list, the total count, and the line totals.
 */
export function isChangesSummary(value: unknown): value is ChangesSummary {
  if (!isRecord(value)) return false
  const { turn, files, total, added, deleted } = value
  return Number.isSafeInteger(turn) && (turn as number) >= 1 && Number.isSafeInteger(total)
    && Number.isSafeInteger(added) && Number.isSafeInteger(deleted)
    && Array.isArray(files) && files.every(isChangedFile)
}

function isHunk(value: unknown): value is WorkspaceDiffHunk {
  if (!isRecord(value)) return false
  const { oldStart, oldLines, newStart, newLines, lines } = value
  return [oldStart, oldLines, newStart, newLines].every(field => Number.isSafeInteger(field) && (field as number) >= 0)
    && Array.isArray(lines) && lines.every(line => typeof line === 'string' && /^[+ -]/.test(line))
}

/**
 * Validate a comparison read from the comparison route.
 * @param value - decoded JSON.
 * @returns whether the value is a text comparison with well-formed hunks, or a binary or oversized refusal.
 */
export function isChangesDiff(value: unknown): value is ChangesDiff {
  if (!isRecord(value)) return false
  const { kind, path, display } = value
  if (typeof path !== 'string' || path.length === 0 || typeof display !== 'string' || display.length === 0) return false
  if (kind === 'binary' || kind === 'oversized') return true
  if (kind !== 'text') return false
  const { before, after, hunks, coarse } = value
  return typeof before === 'boolean' && typeof after === 'boolean' && typeof coarse === 'boolean'
    && Array.isArray(hunks) && hunks.every(isHunk)
}

/**
 * Validate an explanation read from the explanation route.
 * @param value - decoded JSON.
 * @returns whether the value holds a purpose text and a list of change texts.
 */
export function isChangesExplanation(value: unknown): value is ChangesExplanation {
  if (!isRecord(value)) return false
  const { purpose, changes } = value
  return typeof purpose === 'string' && Array.isArray(changes) && changes.every(change => typeof change === 'string')
}

const VERDICTS: readonly string[] = ['pass', 'concerns', 'fail']
const SEVERITIES: readonly string[] = ['high', 'medium', 'low']
const STATUSES: readonly string[] = ['pass', 'warn', 'fail', 'na']

function isJudgeIssue(value: unknown): value is JudgeIssue {
  if (!isRecord(value)) return false
  const { severity, title, detail, line } = value
  return SEVERITIES.includes(severity as string) && typeof title === 'string' && typeof detail === 'string'
    && (line === undefined || (Number.isSafeInteger(line) && (line as number) >= 1))
}

function isJudgeCheck(value: unknown): value is JudgeCheck {
  if (!isRecord(value)) return false
  const { aspect, status, note } = value
  return (JUDGE_ASPECTS as readonly string[]).includes(aspect as string) && STATUSES.includes(status as string) && typeof note === 'string'
}

/**
 * Validate a judgment read from the judgment route.
 * @param value - decoded JSON.
 * @returns whether the value carries a verdict, a confidence from 0 to 100, a summary, issues, checks, suggestions, and its basis.
 */
export function isChangesJudgment(value: unknown): value is ChangesJudgment {
  if (!isRecord(value)) return false
  const { verdict, confidence, summary, issues, checks, suggestions, basis } = value
  return VERDICTS.includes(verdict as string)
    && Number.isSafeInteger(confidence) && (confidence as number) >= 0 && (confidence as number) <= 100
    && typeof summary === 'string' && Array.isArray(issues) && issues.every(isJudgeIssue)
    && Array.isArray(checks) && checks.every(isJudgeCheck) && isStrings(suggestions)
    && isRecord(basis) && typeof basis.docs === 'boolean' && typeof basis.request === 'boolean'
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Validate a rewind preview read from the rewind route.
 * @param value - decoded JSON.
 * @returns whether the value carries the cut point, the running flag, and the plan.
 */
export function isChangesRewindPreview(value: unknown): value is ChangesRewindPreview {
  if (!isRecord(value)) return false
  const { atSeq, running, files, oversized, incomplete, shellUntracked } = value
  return (atSeq === null || (Number.isSafeInteger(atSeq) && (atSeq as number) >= 0)) && typeof running === 'boolean'
    && isStrings(files) && isStrings(oversized) && typeof incomplete === 'boolean' && typeof shellUntracked === 'boolean'
}

/**
 * Validate a rewind result read from the rewind route.
 * @param value - decoded JSON.
 * @returns whether the value lists the restored and skipped files.
 */
export function isChangesRewindResult(value: unknown): value is ChangesRewindResult {
  if (!isRecord(value)) return false
  const { restored, skipped, incomplete } = value
  return isStrings(restored) && typeof incomplete === 'boolean' && Array.isArray(skipped)
    && skipped.every(item => isRecord(item) && typeof item.display === 'string'
      && (item.reason === 'oversized' || item.reason === 'submodule' || item.reason === 'failed'))
}

/**
 * Build authenticated coordinates for rewinding one Session to the start of one turn.
 * @param sessionId - the Session to rewind.
 * @param turn - the first turn whose changes are undone.
 * @returns document-relative rewind route.
 */
export function changesRewindUrl(sessionId: SessionId, turn: number): string {
  return `${CHANGES_REWIND_ROUTE}?${new URLSearchParams({ sessionId, turn: String(turn) })}`
}

/**
 * Validate the `workspace/changes` event data read from a Session log.
 * @param value - decoded durable event data.
 * @returns whether the event names a turn.
 */
export function isChangesEvent(value: unknown): value is { turn: number } {
  return isRecord(value) && Number.isSafeInteger(value.turn) && (value.turn as number) >= 1
}

/**
 * Build authenticated coordinates for the summary one `workspace/changes` event announced.
 * @param sessionId - owning Session.
 * @param seq - event sequence.
 * @returns document-relative summary route.
 */
export function changesSummaryUrl(sessionId: SessionId, seq: number): string {
  return `${CHANGED_FILES_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq) })}`
}

/**
 * Build authenticated coordinates for one listed file's comparison.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the summary's files array.
 * @returns document-relative comparison route.
 */
export function changesDiffUrl(sessionId: SessionId, seq: number, index: number): string {
  return `${CHANGES_DIFF_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

/**
 * Build authenticated coordinates for one listed file's explanation.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the summary's files array.
 * @returns document-relative explanation route.
 */
export function changesExplainUrl(sessionId: SessionId, seq: number, index: number): string {
  return `${CHANGES_EXPLAIN_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

/**
 * Build authenticated coordinates for one listed file's judgment.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the summary's files array.
 * @returns document-relative judgment route.
 */
export function changesJudgeUrl(sessionId: SessionId, seq: number, index: number): string {
  return `${CHANGES_JUDGE_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

/**
 * Build authenticated coordinates for a changed file's native open.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the summary's files array.
 * @returns document-relative action route.
 */
export function changedFileUrl(sessionId: SessionId, seq: number, index: number): string {
  return `${CHANGES_OPEN_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

/**
 * The right-Sidebar address of one turn's review. The Session and the event
 * sequence identify the content; the turn rides along for the tab title.
 * @param coordinates - viewed Session, announcing event, and turn.
 * @returns a `dsh-resource://changes-review/session/…` address.
 */
export function changesReviewAddress(coordinates: ChangesReviewCoordinates): string {
  const { sessionId, seq, turn } = coordinates
  return `${CHANGES_REVIEW_ADDRESS}${encodeURIComponent(sessionId)}/${seq}/${turn}`
}

/**
 * Read the coordinates back out of a review address.
 * @param address - a resource address.
 * @returns the coordinates, or undefined for any other address.
 */
export function parseChangesReviewAddress(address: string): ChangesReviewCoordinates | undefined {
  if (!address.startsWith(CHANGES_REVIEW_ADDRESS)) return undefined
  const parts = address.slice(CHANGES_REVIEW_ADDRESS.length).split('/')
  if (parts.length !== 3) return undefined
  const [sessionId, seq, turn] = parts as [string, string, string]
  if (sessionId === '' || !/^\d+$/.test(seq) || !/^[1-9]\d*$/.test(turn)) return undefined
  try {
    return { sessionId: decodeURIComponent(sessionId) as SessionId, seq: Number(seq), turn: Number(turn) }
  } catch {
    // A malformed percent sequence is not an address this package minted.
    return undefined
  }
}
