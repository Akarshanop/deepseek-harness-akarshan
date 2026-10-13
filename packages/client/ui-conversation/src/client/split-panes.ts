/** Extra Conversation panes shown beside the main Conversation, each holding its own Session reference. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    splitPane: unknown
  }
}

/** Number of Conversations visible at once, including the main one. */
export const MAX_VISIBLE_PANES = 3

const STORAGE_KEY = 'dsh.conversation.splitPanes'

/** One extra pane as observed by the root renderer. */
export interface SplitPaneSnapshot {
  readonly sessionId: SessionId
  /** Framework SessionProvider target; business components never read it. */
  readonly reference: SessionReference
}

interface PaneRecord extends SplitPaneSnapshot {
  mounts: number
  retired: boolean
}

/** Owns the retained references behind the extra panes until their React roots unmount. */
export class SplitPanes {
  /** Extra panes in display order. */
  readonly source = createSnapshotStore<readonly SplitPaneSnapshot[]>([])
  private readonly panes = new Map<SessionId, PaneRecord>()
  private closed = false

  private stopRestore: (() => void) | undefined

  /**
   * Restores the panes saved by the previous page load once the Session list has arrived;
   * before that, every saved id would be rejected as unknown.
   */
  constructor(private readonly sessions: ISessions) {
    const saved = readSavedIds()
    if (saved.length === 0) return
    const restore = (): void => {
      if (this.sessions.list.getSnapshot().phase !== 'ready') return
      this.stopRestore?.()
      this.stopRestore = undefined
      for (const id of saved) this.add(id)
    }
    this.stopRestore = this.sessions.list.subscribe(restore)
    restore()
  }

  /**
   * Add a pane for a Session. A Session that already has a pane, or a full layout, is ignored.
   * @param sessionId - Session to display.
   * @returns whether a pane was added.
   */
  add(sessionId: SessionId): boolean {
    if (this.closed || this.panes.has(sessionId) || this.panes.size >= MAX_VISIBLE_PANES - 1) return false
    let reference: SessionReference
    try {
      reference = this.sessions.retain(sessionId, { source: 'splitPane' })
    } catch (error: unknown) {
      // A saved Session that no longer exists cannot be retained; the pane is dropped.
      console.error('Split pane Session unavailable:', error)
      return false
    }
    void reference.ready.catch((error: unknown) => {
      console.error('Split pane Session opening failed:', error)
      this.remove(sessionId)
    })
    this.panes.set(sessionId, { sessionId, reference, mounts: 0, retired: false })
    this.publish()
    return true
  }

  /**
   * Withdraw a pane; its reference is released once its mounted root has unmounted.
   * @param sessionId - Session whose pane closes.
   */
  remove(sessionId: SessionId): void {
    const pane = this.panes.get(sessionId)
    if (pane === undefined) return
    this.panes.delete(sessionId)
    this.publish()
    pane.retired = true
    if (pane.mounts === 0) pane.reference.release()
  }

  /**
   * Record a committed pane root.
   * @param reference - target published by this owner.
   * @returns cleanup for that root.
   */
  mount(reference: SessionReference): () => void {
    const pane = [...this.panes.values()].find(candidate => candidate.reference === reference)
    if (pane === undefined) return () => {}
    pane.mounts += 1
    return () => {
      pane.mounts -= 1
      if (pane.retired && pane.mounts === 0) pane.reference.release()
    }
  }

  /** Release every pane's reference at plugin shutdown. */
  dispose(): void {
    this.closed = true
    this.stopRestore?.()
    const all = [...this.panes.values()]
    this.panes.clear()
    this.source.set([])
    for (const pane of all) pane.reference.release()
  }

  private publish(): void {
    if (!this.closed) writeSavedIds([...this.panes.keys()])
    this.source.set([...this.panes.values()].map(({ sessionId, reference }) => ({ sessionId, reference })))
  }
}

function readSavedIds(): SessionId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((id): id is SessionId => typeof id === 'string') : []
  } catch (error: unknown) {
    // Unavailable storage or malformed JSON means no saved panes.
    void error
    return []
  }
}

function writeSavedIds(ids: readonly SessionId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch (error: unknown) {
    // Storage may be unavailable or full; panes then simply do not persist.
    void error
  }
}
