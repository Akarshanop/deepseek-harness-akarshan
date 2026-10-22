/**
 * What the model-written records of changed files share: the reads of a
 * listed file's comparison and content, and one cache per Session of the
 * records written so far, each shared by every request for an equal comparison.
 */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { untilAborted } from './model-gate.ts'

/** The change reads every record writer makes, supplied by the plugin so the writers hold no service. */
export interface ChangeSourcePorts {
  /**
   * The summary one `workspace/changes` event announced.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined once the Host no longer holds it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * One listed file's comparison.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary.
   * @param signal - cancels the read.
   * @returns the comparison, or undefined when the Host no longer serves it.
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
  /**
   * The start of a file as it stands now.
   * @param sessionId - the Session whose workspace holds the file.
   * @param cwd - the Session working directory.
   * @param path - the listed file's `path`.
   * @param lines - lines to read from the start.
   * @param signal - cancels the read.
   * @returns the text, or undefined when the file cannot be read as text.
   */
  head(sessionId: SessionId, cwd: string, path: string, lines: number, signal: AbortSignal): Promise<string | undefined>
}

/** A listed file with a text comparison to describe. */
export interface ChangeTarget {
  summary: WorkspaceChangesSummary
  file: WorkspaceChangedFile
  diff: Extract<WorkspaceFileDiff, { kind: 'text' }>
}

/** One Session's records and the cancellation of the requests that write them. */
export interface RecordBucket<T> {
  readonly lifetime: AbortController
  readonly entries: Map<string, Promise<T>>
}

/**
 * The cache key of one comparison.
 * @param parts - what distinguishes the comparison: its path, sides, and hunks, and any scope such as the turn.
 * @returns a SHA-256 digest of the parts.
 */
export function comparisonKey(...parts: readonly unknown[]): string {
  return createHash('sha256').update(parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join('\0')).digest('hex')
}

/** Per-Session caches of records about changed files; a failed record is forgotten so the next request writes it again. */
export class ChangeRecords<T, B extends RecordBucket<T>> {
  /** Aborts every request on disposal. */
  readonly lifetime = new AbortController()
  private readonly buckets = new Map<SessionId, B>()

  constructor(private readonly ports: Pick<ChangeSourcePorts, 'summary' | 'diff'>, private readonly create: () => B) {}

  /**
   * The listed file and its text comparison.
   * @param sessionId - the Session that appended the announcing event.
   * @param seq - the announcing event's sequence.
   * @param index - the file's index in the summary.
   * @param signal - cancels the comparison read.
   * @returns the target, or undefined for no recorded summary, a binary or oversized file, or an unchanged one.
   */
  async target(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<ChangeTarget | undefined> {
    const summary = this.ports.summary(sessionId, seq)
    const file = summary?.files[index]
    if (summary === undefined || file === undefined || file.binary === true || file.oversized === true) return undefined
    const diff = await this.ports.diff(sessionId, seq, index, signal)
    if (diff?.kind !== 'text' || diff.hunks.length === 0) return undefined
    return { summary, file, diff }
  }

  /**
   * The record cached under a key, written now when absent.
   * @param sessionId - the Session the record belongs to.
   * @param key - the comparison's cache key.
   * @param write - starts writing the record into a bucket.
   * @param signal - stops the wait; the record keeps being written for other requests.
   * @returns the record.
   */
  shared(sessionId: SessionId, key: string, write: (bucket: B) => Promise<T>, signal: AbortSignal): Promise<T> {
    const bucket = this.bucket(sessionId)
    let written = bucket.entries.get(key)
    if (written === undefined) {
      const started = write(bucket)
      bucket.entries.set(key, started)
      started.catch(() => { bucket.entries.delete(key) })
      written = started
    }
    return untilAborted(written, signal)
  }

  /**
   * One Session's bucket, created on first use.
   * @param sessionId - the Session.
   * @returns the bucket.
   */
  bucket(sessionId: SessionId): B {
    let bucket = this.buckets.get(sessionId)
    if (bucket === undefined) {
      bucket = this.create()
      this.buckets.set(sessionId, bucket)
    }
    return bucket
  }

  /**
   * Drop a disposed Session's records and cancel the requests still writing them.
   * @param sessionId - the disposed Session.
   */
  forget(sessionId: SessionId): void {
    this.buckets.get(sessionId)?.lifetime.abort()
    this.buckets.delete(sessionId)
  }

  /** Cancel every request in flight; later calls write nothing new. */
  dispose(): void {
    this.lifetime.abort()
    for (const sessionId of [...this.buckets.keys()]) this.forget(sessionId)
  }
}
