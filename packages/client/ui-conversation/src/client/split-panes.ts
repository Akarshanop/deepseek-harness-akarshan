/** Open Conversation tabs shown side by side: the selected Session plus any others, each other one holding its own Session reference. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    splitPane: unknown
  }
}

const STORAGE_KEY = 'dsh.conversation.splitPanes'

/** One pane's Session reference as observed by the root renderer. */
export interface SplitPaneSnapshot {
  readonly sessionId: SessionId
  /** Framework SessionProvider target; business components never read it. */
  readonly reference: SessionReference
}

interface PaneRecord extends SplitPaneSnapshot {
  mounts: number
  retired: boolean
}

/** The open Sessions in display order, and the retained references behind every one but the selected Session. */
export interface SplitPanesState {
  readonly order: readonly SessionId[]
  /** One entry per open Session other than the selected one; the selected Session is rendered by the main panel. */
  readonly panes: readonly SplitPaneSnapshot[]
}

/**
 * Owns the list of open Session tabs and the references behind the ones that are not the selected
 * Session. A Session stays in the list until it is closed; selecting a Session that is not open appends it.
 */
export class SplitPanes {
  /** Open Sessions in display order, and the non-selected Sessions' references. */
  readonly source = createSnapshotStore<SplitPanesState>({ order: [], panes: [] })
  private order: SessionId[] = []
  private readonly records = new Map<SessionId, PaneRecord>()
  private main: SessionId | undefined
  /** A selected Session being closed: it must not be re-added until the selection moves on. */
  private closing: SessionId | undefined
  private closed = false

  private stopRestore: (() => void) | undefined

  /**
   * Restores the tabs saved by the previous page load once the Session list has arrived;
   * before that, every saved id would be rejected as unknown.
   * @param sessions - Session Controller used to retain each tab's Session.
   */
  constructor(private readonly sessions: ISessions) {
    const saved = readSaved()
    if (saved.length === 0) return
    const restore = (): void => {
      if (this.sessions.list.getSnapshot().phase !== 'ready') return
      this.stopRestore?.()
      this.stopRestore = undefined
      // The selected Session may have joined the list before the saved order arrived; it keeps its saved place.
      const joined = this.order
      this.order = []
      for (const id of [...saved, ...joined]) this.add(id)
    }
    this.stopRestore = this.sessions.list.subscribe(restore)
    restore()
  }

  /**
   * Follow the selected Session. With a split view (two or more open Sessions) a Session that is not open
   * yet joins the end of the list and the one it replaced keeps its tab, with a reference of its own; with
   * at most one open Session the selection simply replaces it. The selected Session's own pane reference is
   * dropped, since the main panel renders it.
   * @param main - the Session the sidebar selected, or undefined while none is.
   */
  sync(main: SessionId | undefined): void {
    if (this.closed) return
    this.main = main
    if (main === undefined) return
    if (this.closing !== undefined && main !== this.closing) this.closing = undefined
    if (main === this.closing) return
    let changed = false
    if (!this.order.includes(main)) {
      if (this.order.length <= 1) {
        // Without a split view a selection replaces the Session on screen, as it always did.
        for (const id of this.order) this.detach(id)
        this.order = [main]
      } else {
        this.order.push(main)
      }
      changed = true
    }
    if (this.records.has(main)) {
      this.detach(main)
      changed = true
    }
    for (const id of [...this.order]) {
      if (id === main || this.records.has(id)) continue
      if (!this.open(id)) this.order = this.order.filter(candidate => candidate !== id)
      changed = true
    }
    if (changed) this.publish()
  }

  /**
   * Open another Session at the end of the list. A Session that is already open is ignored.
   * @param sessionId - Session to display.
   * @returns whether a tab was added.
   */
  add(sessionId: SessionId): boolean {
    if (this.closed || this.order.includes(sessionId)) return false
    if (sessionId !== this.main && !this.records.has(sessionId) && !this.open(sessionId)) return false
    this.order.push(sessionId)
    this.publish()
    return true
  }

  /**
   * Close a tab; its reference is released once its mounted root has unmounted. Closing the
   * selected Session also keeps it from being re-added until another Session is selected.
   * @param sessionId - Session whose tab closes.
   */
  remove(sessionId: SessionId): void {
    if (!this.order.includes(sessionId)) return
    this.order = this.order.filter(candidate => candidate !== sessionId)
    this.detach(sessionId)
    if (sessionId === this.main) this.closing = sessionId
    this.publish()
  }

  /**
   * Record a committed pane root.
   * @param reference - target published by this owner.
   * @returns cleanup for that root.
   */
  mount(reference: SessionReference): () => void {
    const pane = [...this.records.values()].find(candidate => candidate.reference === reference)
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
    const all = [...this.records.values()]
    this.records.clear()
    this.order = []
    this.source.set({ order: [], panes: [] })
    for (const pane of all) pane.reference.release()
  }

  /** Retain a Session and record its reference without publishing; false when it cannot be retained. */
  private open(sessionId: SessionId): boolean {
    let reference: SessionReference
    try {
      reference = this.sessions.retain(sessionId, { source: 'splitPane' })
    } catch (error: unknown) {
      // A saved Session that no longer exists cannot be retained; its tab is dropped.
      console.error('Split pane Session unavailable:', error)
      return false
    }
    void reference.ready.catch((error: unknown) => {
      // A reference released on purpose (the Session became the selected one, or its tab closed) also
      // rejects `ready`; only a failure of the reference that is still in use closes the tab.
      if (this.records.get(sessionId)?.reference !== reference) return
      console.error('Split pane Session opening failed:', error)
      this.remove(sessionId)
    })
    this.records.set(sessionId, { sessionId, reference, mounts: 0, retired: false })
    return true
  }

  private detach(sessionId: SessionId): void {
    const pane = this.records.get(sessionId)
    if (pane === undefined) return
    this.records.delete(sessionId)
    pane.retired = true
    if (pane.mounts === 0) pane.reference.release()
  }

  private publish(): void {
    if (!this.closed) writeSaved(this.order)
    this.source.set({
      order: [...this.order],
      panes: [...this.records.values()].map(({ sessionId, reference }) => ({ sessionId, reference })),
    })
  }
}

/** Saved tab order. Earlier versions saved a bare id array, or `{ panes, mainSlot }` without the selected Session. */
function readSaved(): SessionId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const ids: unknown = Array.isArray(raw)
      ? raw
      : (raw as { order?: unknown; panes?: unknown } | null)?.order ?? (raw as { panes?: unknown } | null)?.panes
    return Array.isArray(ids) ? ids.filter((id): id is SessionId => typeof id === 'string') : []
  } catch (error: unknown) {
    // Unavailable storage or malformed JSON means no saved tabs.
    void error
    return []
  }
}

function writeSaved(order: readonly SessionId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order }))
  } catch (error: unknown) {
    // Storage may be unavailable or full; tabs then simply do not persist.
    void error
  }
}
