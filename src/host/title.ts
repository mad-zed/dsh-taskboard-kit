/**
 * Write the card number into the calling session's title.
 *
 * A session that creates, claims or starts a card is the session working on it,
 * so its sidebar row says which card that is. `sessionTitle.rename` pins the
 * title as a user rename, so automatic title generation stops overwriting it.
 * Every failure is swallowed: a title must never turn a tool result into an
 * error. The rules themselves live in `title-rules.ts`.
 *
 * @module dsh-taskboard-kit/session-title
 */

import { resolveSession, type ExecLike } from './workspace.ts'
import { cardPrefix, shouldWriteTitle, wantedSessionTitle, type TitleCard } from './title-rules.ts'

/** The `ctx.get('sessionTitle')` slice we read. */
interface TitlesLike {
  get(session: unknown): { title?: unknown } | undefined
  rename(session: unknown, title: string): unknown
}

/** Read the session-title service, absent on hosts that do not ship it. */
function readTitles(ctx: unknown): TitlesLike | undefined {
  try {
    const getter = (ctx as { get?: unknown }).get
    const candidate = typeof getter === 'function'
      ? (getter as (name: string) => unknown).call(ctx, 'sessionTitle')
      : (ctx as { sessionTitle?: unknown }).sessionTitle
    if (!candidate || typeof candidate !== 'object') return undefined
    const titles = candidate as TitlesLike
    if (typeof titles.get !== 'function' || typeof titles.rename !== 'function') return undefined
    return titles
  } catch {
    /* reading an un-provided cordis service throws: treat as absent */
    return undefined
  }
}

/**
 * Write the card number into the calling session's title.
 * @param ctx - host context carrying `sessions` and the session-title service.
 * @param exec - tool execution slice (the calling agent).
 * @param card - card the session just created, claimed or updated.
 * @returns the title written, or `undefined` when nothing was written.
 */
export function syncSessionTitle(ctx: unknown, exec: ExecLike | undefined, card: TitleCard): string | undefined {
  try {
    const session = resolveSession(ctx, exec)
    if (!session) return undefined
    const titles = readTitles(ctx)
    if (!titles) return undefined
    const latest = titles.get(session)?.title
    const current = typeof latest === 'string' ? latest : null
    if (!shouldWriteTitle(current, cardPrefix(card.id))) return undefined
    const wanted = wantedSessionTitle(card)
    if (current === wanted) return undefined
    titles.rename(session, wanted)
    return wanted
  } catch {
    return undefined
  }
}
