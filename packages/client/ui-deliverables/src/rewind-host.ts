/** Host side of rewinding a Session to the start of one turn: the conversation cut point and the file restore route. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import { CHANGES_REWIND_PATH, type ChangesRewindPreview, type ChangesRewindResult } from './changes.ts'

/**
 * The last event a conversation rewound to the start of one turn keeps: the
 * previous turn's `turn/end` and the standalone events after it, stopping
 * before the prompt that opened the turn was queued or admitted.
 * @param events - the Session log, indexed by seq.
 * @param turn - the turn the rewound conversation must not contain.
 * @returns the inclusive cut seq, or undefined when the turn is not in the log or nothing precedes it.
 */
export function rewindBoundary(events: readonly SessionEvent[], turn: number): number | undefined {
  const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return undefined
  const prefix = events.slice(0, start)
  let boundary: number | undefined
  let from = 0
  for (const [index, event] of prefix.entries()) {
    if (event.type !== 'turn/end') continue
    boundary = event.seq
    from = index + 1
  }
  for (const next of prefix.slice(from)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** The rewind coordinates from a route query, or the 400 to answer with. */
function coordinates(request: Request): { sessionId: SessionId; turn: number } | Response {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const turn = query.get('turn')
  if (!sessionId || turn === null || !/^[1-9]\d*$/.test(turn) || !Number.isSafeInteger(Number(turn))) {
    return new Response('Invalid rewind coordinates.', { status: 400 })
  }
  return { sessionId: sessionId as SessionId, turn: Number(turn) }
}

/**
 * Register the rewind route inside Connection's authentication fence. GET
 * answers the preview; POST puts the files back, refusing with 409 while a
 * turn of the Session runs.
 * @param ctx - Session lookup, change records, and route lifetime.
 */
export function registerRewind(ctx: Context): void {
  const running = (sessionId: SessionId): boolean => ctx.get('agents')?.get(sessionId)?.status === 'running'
  ctx.connection.fetch.register({
    path: CHANGES_REWIND_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const target = coordinates(request)
      if (target instanceof Response) return target
      const { sessionId, turn } = target
      const headers = { 'cache-control': 'no-store' }
      if (request.method === 'POST') {
        if (running(sessionId)) return new Response('A turn of this Session is running.', { status: 409 })
        const result = await ctx.workspaceChanges.rewind(sessionId, turn, request.signal)
        return Response.json(result satisfies ChangesRewindResult, { headers })
      }
      let atSeq: number | undefined
      try {
        using observed = await ctx.sessionQuery.observeSession(sessionId, { signal: request.signal, projectionMode: 'none' })
        atSeq = rewindBoundary(observed.events, turn)
      } catch (error: unknown) {
        request.signal.throwIfAborted()
        ctx.logger.warn(`ui-deliverables: rewind preview of ${sessionId} failed: ${String(error)}`)
        return new Response('Session unavailable.', { status: 404 })
      }
      const preview: ChangesRewindPreview = {
        ...ctx.workspaceChanges.rewindPlan(sessionId, turn), atSeq: atSeq ?? null, running: running(sessionId),
      }
      return Response.json(preview, { headers })
    },
  })
}
