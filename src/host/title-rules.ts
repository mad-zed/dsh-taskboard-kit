/**
 * Pure rules for the card number a session title carries: `#ZGT4 卡片标题`.
 *
 * Kept apart from the host glue in `title.ts` so the rules can be unit-tested
 * without a session, a title service or Redis.
 *
 * @module dsh-taskboard-kit/title-rules
 */

/** The card identity a session title names. */
export interface TitleCard {
  /** Board id, e.g. `T-ZGT4`. */
  readonly id: string
  /** Current card title (may be long; it is truncated to the byte budget). */
  readonly title: string
}

/** Byte budget for a written title: `#XXXX ` plus a readable card title. */
export const MAX_TITLE_BYTES = 120

/** UTF-8 size of one code point. */
function codePointBytes(code: number): number {
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/**
 * Cut text to a UTF-8 byte budget without splitting a code point.
 * @param text - text to cut.
 * @param maxBytes - byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const size = codePointBytes(ch.codePointAt(0) ?? 0)
    if (bytes + size > maxBytes) break
    bytes += size
    out += ch
  }
  return out
}

/**
 * The prefix a card claims in session titles: `#ZGT4 ` (no `T-`).
 * @param cardId - board id such as `T-ZGT4`.
 */
export function cardPrefix(cardId: string): string {
  return `#${cardId.replace(/^T-/, '')} `
}

/**
 * The exact title a card wants: prefix plus card title, byte-capped.
 * @param card - card identity and current title.
 */
export function wantedSessionTitle(card: TitleCard): string {
  const prefix = cardPrefix(card.id)
  const room = MAX_TITLE_BYTES - Buffer.byteLength(prefix, 'utf8')
  return prefix + truncateUtf8(card.title, room > 0 ? room : 0)
}

/**
 * Whether the current title may be replaced at all: an untitled session, or a
 * title that already carries this card's prefix (the rename-refresh case).
 * A human title or another card's prefix stays untouched.
 * @param current - latest title text, `null` when the session has none.
 * @param prefix - this card's `#XXXX ` prefix.
 */
export function shouldWriteTitle(current: string | null, prefix: string): boolean {
  if (current === null || current === '') return true
  return current.startsWith(prefix)
}
