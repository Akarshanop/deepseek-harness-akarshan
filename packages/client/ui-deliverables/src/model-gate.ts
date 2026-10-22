/** Concurrency and cancellation helpers shared by the auxiliary model requests: explanations, judgments, and codebase docs. */

/** The system and user text of one model request. */
export interface ModelPrompt {
  system: string
  user: string
}

/** One provider route an auxiliary request runs on. */
export interface ModelRoute {
  provider: string
  model: string
}

/**
 * The reason a signal aborted with, as an Error.
 * @param signal - an aborted signal.
 * @returns the reason, wrapped when it is not an Error.
 */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

/** Limits simultaneous model requests; a waiter leaves the queue when its signal aborts. */
export class Gate {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  /**
   * Run a task once a slot is free.
   * @param signal - abandons the wait; a started task observes the signal itself.
   * @param task - the work holding the slot.
   * @returns the task's result.
   */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.enter(signal)
    try {
      return await task()
    } finally {
      this.leave()
    }
  }

  private enter(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      // A granted waiter inherits the departing request's slot, so `active` stays counted.
      const grant = (): void => {
        signal.removeEventListener('abort', abandon)
        resolve()
      }
      const abandon = (): void => {
        this.queue.splice(this.queue.indexOf(grant), 1)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abandon, { once: true })
      this.queue.push(grant)
    })
  }

  private leave(): void {
    const next = this.queue.shift()
    if (next === undefined) this.active -= 1
    else next()
  }
}

/**
 * Resolve when `promise` settles, or reject when `signal` aborts first; the promise itself keeps running.
 * @param promise - shared work other callers may still wait for.
 * @param signal - this caller's cancellation.
 * @returns the promise's value.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abandon = (): void => { reject(abortReason(signal)) }
    signal.addEventListener('abort', abandon, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abandon) })
  })
}

/**
 * Cut text to a limit, appending a marker when it was cut.
 * @param text - the text.
 * @param limit - characters kept.
 * @param marker - appended after a cut.
 * @returns the text, or its first `limit` characters and the marker.
 */
export function cut(text: string, limit: number, marker: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${marker}`
}

/** A `<think>` block some routes put before the answer. */
export const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi
