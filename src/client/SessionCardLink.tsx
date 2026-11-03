/**
 * Session-row hover card: jump to the card the session title names.
 *
 * The host writes `#ZGT4 卡片标题` into the title when a session creates,
 * claims or starts a card, so the row already says which card it belongs to.
 * This entry turns that number into a link: click → the status-bar mini board
 * drawer opens on that card's detail (`store.requestMini`).
 *
 * The row seat only hands us the session id, so the card number is parsed from
 * the session list's title projection. No title, no entry — the link never
 * guesses.
 *
 * @module dsh-taskboard-kit/client-session-link
 */

import { useSyncExternalStore } from 'react'
import { L } from './locale.ts'
import { getTaskboardStore, type TaskboardStore } from './store.ts'

interface SessionRowLike {
  byId?: Record<string, { projections?: { values?: { title?: unknown } } } | undefined>
}

interface ObservableLike<T> {
  get?(): T
  snapshot?: T
  value?: T
  subscribe?(listener: () => void): () => void
}

interface SessionsLike {
  list?: ObservableLike<SessionRowLike>
}

/** Props handed by the slot: the injected store, the session list, the row id. */
export interface SessionCardLinkProps {
  store?: TaskboardStore
  sessions?: SessionsLike
  /** The row's session (standard row-seat prop). */
  sessionId?: string
}

/**
 * `#ZGT4 标题` → `T-ZGT4`. Anything that is not a card prefix (`#`, letters or
 * digits, then a space) stays unrecognised.
 * @param title - the session title projection value.
 */
export function cardIdFromTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const match = /^#([A-Za-z0-9]+) /.exec(title)
  return match ? `T-${match[1]}` : undefined
}

/** Read an observable's current value whichever shape the host exposes. */
function snapshotOf<T>(source: ObservableLike<T> | undefined): T | undefined {
  if (!source) return undefined
  if (typeof source.get === 'function') {
    try {
      return source.get()
    } catch {
      return undefined
    }
  }
  return source.snapshot ?? source.value
}

/** The hover-card link; renders nothing while the row carries no card number. */
export function SessionCardLink(props: SessionCardLinkProps): JSX.Element | null {
  const store = props.store ?? getTaskboardStore()
  const list = props.sessions?.list
  const state = useSyncExternalStore(
    (notify) => (typeof list?.subscribe === 'function' ? list.subscribe(notify) : () => {}),
    () => snapshotOf(list),
    () => snapshotOf(list),
  )
  const sessionId = props.sessionId
  const cardId = sessionId ? cardIdFromTitle(state?.byId?.[sessionId]?.projections?.values?.title) : undefined
  if (!cardId) return null
  return (
    <button
      type="button"
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'block',
        width: '100%',
        padding: '4px 2px',
        color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-xxs-12)',
      }}
      onClick={() => store.requestMini(cardId)}
    >
      {L('打开任务 {id} →', 'Open task {id} →', { id: cardId })}
    </button>
  )
}
