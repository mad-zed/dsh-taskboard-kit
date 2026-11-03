/**
 * Session-title rules for dsh-taskboard-kit: the `#ZGT4 卡片标题` prefix a tool
 * call writes into the calling session, and the three rules that keep it polite
 * (untitled only, same card only, never a human title).
 *
 * Run: node tests/session-title.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'

process.env.TASKBOARDKIT_LOCALE = 'en'

const {
  cardPrefix,
  MAX_TITLE_BYTES,
  shouldWriteTitle,
  syncSessionTitle,
  truncateUtf8,
  wantedSessionTitle,
} = await import('../lib/index.js')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

/**
 * A host stand-in: one live session, a mutable title, and the writes it saw.
 * `titles: false` models a host that does not ship the session-title service.
 */
function harness(initialTitle, { titles = true, source = 'user' } = {}) {
  const state = { title: initialTitle }
  const writes = []
  const session = { id: 's1' }
  const ctx = {
    sessions: { get: (id) => (id === 's1' ? session : undefined) },
    get: (name) => {
      if (name !== 'sessionTitle' || !titles) return undefined
      return {
        get: () => (state.title === null ? undefined : { title: state.title, source: { kind: source } }),
        rename: (_session, next) => {
          writes.push(next)
          state.title = next
          return { title: next }
        },
      }
    },
  }
  return { ctx, exec: { agent: { id: 's1' } }, writes, state }
}

const CARD = { id: 'T-ZGT4', title: '一条龙失败排查' }

console.log('session-title')

await check('cardPrefix drops the T- prefix', () => {
  assert.equal(cardPrefix('T-ZGT4'), '#ZGT4 ')
  assert.equal(cardPrefix('ZGT4'), '#ZGT4 ')
})

await check('untitled session gets #CARD + title', () => {
  const h = harness(null)
  const written = syncSessionTitle(h.ctx, h.exec, CARD)
  assert.equal(written, '#ZGT4 一条龙失败排查')
  assert.deepEqual(h.writes, ['#ZGT4 一条龙失败排查'])
})

await check('same card, unchanged title → no write', () => {
  const h = harness('#ZGT4 一条龙失败排查')
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), undefined)
  assert.deepEqual(h.writes, [])
})

await check('same card, renamed → text follows, prefix kept', () => {
  const h = harness('#ZGT4 旧标题')
  const written = syncSessionTitle(h.ctx, h.exec, { id: 'T-ZGT4', title: '新标题' })
  assert.equal(written, '#ZGT4 新标题')
  assert.deepEqual(h.writes, ['#ZGT4 新标题'])
})

await check('another card prefix is never taken over', () => {
  const h = harness('#ABCD 别人的卡')
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), undefined)
  assert.deepEqual(h.writes, [])
})

await check('a human title (no # prefix) is never overwritten', () => {
  const h = harness('我自己起的标题')
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), undefined)
  assert.deepEqual(h.writes, [])
})

await check('a generated title may be replaced', () => {
  const h = harness('自动生成的标题', { source: 'fallback' })
  const written = syncSessionTitle(h.ctx, h.exec, CARD)
  assert.equal(written, '#ZGT4 一条龙失败排查')
})

await check('a provider title may be replaced too', () => {
  const h = harness('自动生成的标题', { source: 'provider' })
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), '#ZGT4 一条龙失败排查')
})

await check('shouldWriteTitle: empty or own prefix only', () => {
  assert.equal(shouldWriteTitle(null, '#ZGT4 '), true)
  assert.equal(shouldWriteTitle('', '#ZGT4 '), true)
  assert.equal(shouldWriteTitle('#ZGT4 x', '#ZGT4 ', 'user'), true)
  assert.equal(shouldWriteTitle('#ZGT45 x', '#ZGT4 ', 'user'), false, 'no prefix-by-accident')
  assert.equal(shouldWriteTitle('手写标题', '#ZGT4 ', 'user'), false)
  assert.equal(shouldWriteTitle('自动标题', '#ZGT4 ', 'fallback'), true)
  assert.equal(shouldWriteTitle('自动标题', '#ZGT4 ', 'provider'), true)
})

await check('long titles stay inside the byte budget, code points intact', () => {
  const long = '长'.repeat(200)
  const wanted = wantedSessionTitle({ id: 'T-ZGT4', title: long })
  assert.ok(Buffer.byteLength(wanted, 'utf8') <= MAX_TITLE_BYTES, 'within budget')
  assert.ok(wanted.startsWith('#ZGT4 长'), 'keeps the prefix and full code points')
  assert.equal(wanted.includes('\uFFFD'), false, 'no replacement characters')
  assert.equal(truncateUtf8('abc', 0), '')
  assert.equal(truncateUtf8('中文', 4), '中')
})

await check('missing session-title service is silent', () => {
  const h = harness(null, { titles: false })
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), undefined)
  assert.deepEqual(h.writes, [])
})

await check('unknown session is silent', () => {
  const h = harness(null)
  assert.equal(syncSessionTitle(h.ctx, { agent: { id: 'other' } }, CARD), undefined)
  assert.equal(syncSessionTitle(h.ctx, undefined, CARD), undefined)
  assert.deepEqual(h.writes, [])
})

await check('a throwing rename never escapes', () => {
  const h = harness(null)
  h.ctx.get = () => ({
    get: () => undefined,
    rename: () => {
      throw new Error('boom')
    },
  })
  assert.equal(syncSessionTitle(h.ctx, h.exec, CARD), undefined)
})

if (failed > 0) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall session-title checks passed')
