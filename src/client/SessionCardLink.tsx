/**
 * Session-row「⋯」menu entry: jump to the card the session title names.
 *
 * The host writes `#ZGT4 卡片标题` into a session's title when that session
 * creates, claims or starts a card, so the row title already says which card it
 * belongs to. The row menu hands every entry the row's `displayTitle`, so the
 * number is parsed right here — no session-list lookup, nothing to guess: a row
 * without a card prefix simply gets no entry.
 *
 * Clicking opens the status-bar mini board drawer on that card (`requestMini`).
 *
 * @module dsh-taskboard-kit/client-session-link
 */

import { L } from './locale.ts'
import { getTaskboardStore, type TaskboardStore } from './store.ts'

/** Props handed by the slot: the injected store plus the row's own props. */
export interface SessionCardMenuItemProps {
  store?: TaskboardStore
  /** Row title as the sidebar renders it (persisted title, or ''). */
  displayTitle?: string
  /** The row menu's open-state pair; the entry dismisses it before acting. */
  useMenuOpenState?: () => readonly [open: boolean, setOpen: (open: boolean) => void]
}

/**
 * `#ZGT4 标题` → `T-ZGT4`. A bare `#ZGT4` (no trailing space) is not a prefix,
 * and a hand-written title stays unrecognised on purpose.
 * @param title - the row's display title.
 */
export function cardIdFromTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const match = /^#([A-Za-z0-9]+) /.exec(title)
  return match ? `T-${match[1]}` : undefined
}

/** The「⋯」entry; renders nothing while the row title carries no card number. */
export function SessionCardMenuItem(props: SessionCardMenuItemProps): JSX.Element | null {
  const store = props.store ?? getTaskboardStore()
  const cardId = cardIdFromTitle(props.displayTitle)
  const useMenuOpenState = props.useMenuOpenState
  if (!cardId) return null
  return (
    <button
      type="button"
      role="menuitem"
      className="tb-rowmenu-item"
      onClick={() => {
        // Dismiss the menu first: the drawer opens over the frame, and a stale
        // open menu would swallow the next click.
        if (typeof useMenuOpenState === 'function') {
          const [, setOpen] = useMenuOpenState()
          setOpen(false)
        }
        store.requestMini(cardId)
      }}
    >
      {/* The shipped rows lead with a 16px icon; same slot, same size. */}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2" y="3" width="3.2" height="10" rx="1" />
        <rect x="6.4" y="3" width="3.2" height="6.5" rx="1" />
        <rect x="10.8" y="3" width="3.2" height="8" rx="1" />
      </svg>
      <span>{L('在看板中打开 {id}', 'Open {id} on the board', { id: cardId })}</span>
    </button>
  )
}
