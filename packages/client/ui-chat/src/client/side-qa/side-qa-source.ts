/** Per-Session side-question state: saved records plus questions still waiting for the model. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SideQuestionId, SideQuestionRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Remote result as the generated Remote face returns it. */
type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** The three Session Remote methods this source calls. */
export interface SideQaRemote {
  askSideQuestion(
    request: { sessionId: SessionId; selection: string; question: string },
  ): Promise<RemoteOutcome<SideQuestionRecord>>
  listSideQuestions(request: { sessionId: SessionId }): Promise<RemoteOutcome<{ questions: readonly SideQuestionRecord[] }>>
  deleteSideQuestion(request: { sessionId: SessionId; id: SideQuestionId }): Promise<RemoteOutcome<{ deleted: boolean }>>
}

/** One question sent to the model whose answer has not been saved yet. */
export interface PendingSideQuestion {
  readonly key: number
  readonly selection: string
  readonly question: string
  /** Set when the call could not reach a saved answer; the entry stays until dismissed. */
  readonly failure?: string | undefined
}

/** What the Side Q&A tab renders. */
export interface SideQaState {
  readonly loaded: boolean
  /** Why the saved list could not be read, if it could not. */
  readonly loadFailure?: string | undefined
  /** Saved questions, oldest first. */
  readonly records: readonly SideQuestionRecord[]
  readonly pending: readonly PendingSideQuestion[]
}

/** Observable state and commands for one Session's side questions. */
export interface SideQaSource extends ObservableSnapshot<SideQaState> {
  /** Read the saved list from the Host. */
  refresh(): Promise<void>
  /**
   * Ask about a highlighted passage; resolves once the answer is saved or the call failed.
   * @param selection - highlighted transcript text.
   * @param question - the user's question.
   */
  ask(selection: string, question: string): Promise<void>
  /** Delete one saved question. */
  remove(id: SideQuestionId): Promise<void>
  /** Drop a failed pending entry. */
  dismiss(key: number): void
}

/**
 * Create the side-question source of one Session.
 * @param remote - Session Remote methods.
 * @param sessionId - Session the questions belong to.
 * @returns the observable source.
 */
export function createSideQaSource(remote: SideQaRemote, sessionId: SessionId): SideQaSource {
  const store = createSnapshotStore<SideQaState>({ loaded: false, records: [], pending: [] })
  const patch = (change: (state: SideQaState) => Partial<SideQaState>): void => {
    const state = store.getSnapshot()
    store.set({ ...state, ...change(state) })
  }
  let nextKey = 0
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    async refresh() {
      const result = await remote.listSideQuestions({ sessionId })
      patch(() => result.ok
        ? { loaded: true, loadFailure: undefined, records: result.value.questions }
        : { loaded: true, loadFailure: result.error.message })
    },
    async ask(selection, question) {
      const key = nextKey++
      patch(state => ({ pending: [...state.pending, { key, selection, question }] }))
      const result = await remote.askSideQuestion({ sessionId, selection, question })
      if (result.ok) {
        patch(state => ({
          records: [...state.records, result.value],
          pending: state.pending.filter(item => item.key !== key),
        }))
      } else {
        patch(state => ({
          pending: state.pending.map(item => item.key === key ? { ...item, failure: result.error.message } : item),
        }))
      }
    },
    async remove(id) {
      const result = await remote.deleteSideQuestion({ sessionId, id })
      patch(state => result.ok
        ? { records: state.records.filter(record => record.id !== id) }
        : { loadFailure: result.error.message })
    },
    dismiss(key) {
      patch(state => ({ pending: state.pending.filter(item => item.key !== key) }))
    },
  }
}
