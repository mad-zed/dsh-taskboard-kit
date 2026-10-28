/**
 * Inbox identity test: "is this card mine?" must fold the same names the rest of
 * the board folds.
 *
 * The bug this pins (T-1 实训): a card whose assignee is `dsh` never showed up in
 * the inbox of a session acting as `dsh-agent`, even though the tool schema
 * promises "Aliases like dsh/dsh-agent resolve to one owner" and
 * `actorAliasGroups()` hardcodes exactly that pair. Reason: `inboxFor` folds
 * through the roster only, and the per-card layout (ADR 0001) does not persist
 * `actors` — every load re-derives the entries from the log with `aliases: []`
 * (store.ts roster backfill), so the declared groups never reach the read path.
 *
 * Run: node tests/inbox-identity.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_STORAGE
delete process.env.TASKBOARD_ACTOR
delete process.env.TASKBOARD_ACTOR_ALIASES
delete process.env.TASKBOARD_WATCH_NAMES

const { createTask, inbox, migrateBoardLayout, selfActor } = await import('../lib/index.js')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
    if (error.stack) console.log(error.stack.split('\n').slice(1, 4).join('\n'))
  }
}

const dirs = []
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-inbox-'))
  dirs.push(dir)
  return dir
}

const kinds = (items) => items.map((item) => `${item.kind}:${item.task.id}`)

// The per-card layout is the one whose roster has no aliases at all (nothing is
// persisted between loads), so it is the layout where the folding has to come
// from the declared groups rather than from disk.
await check('by=dsh-agent sees a card assigned to dsh (built-in alias, per-card layout)', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'assigned to the canonical name', assignee: 'dsh' }, 'human')

  const mine = await inbox(ws, 'dsh-agent', { poolLimit: 0 })
  assert.deepEqual(kinds(mine), [`start_assigned:${task.id}`], 'the alias must fold to one owner')
})

await check('by=dsh-agent sees a card claimed as dsh (alias survives a reload)', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'claimed under the canonical name', assignee: 'dsh' }, 'human')

  // A second load is what loses the roster in the per-card layout.
  const again = await inbox(ws, 'dsh-agent', { poolLimit: 0 })
  assert.deepEqual(kinds(again), [`start_assigned:${task.id}`])
})

await check('TASKBOARD_ACTOR_ALIASES folds a configured pair on the read path', async () => {
  process.env.TASKBOARD_ACTOR_ALIASES = 'kimi:kimi-code'
  try {
    const ws = await workspace()
    await migrateBoardLayout(ws, 'tasks')
    const task = await createTask(ws, { title: 'configured alias', assignee: 'kimi-code' }, 'human')

    const mine = await inbox(ws, 'kimi', { poolLimit: 0 })
    assert.deepEqual(kinds(mine), [`start_assigned:${task.id}`])
  } finally {
    delete process.env.TASKBOARD_ACTOR_ALIASES
  }
})

await check('a different actor still does not see the card (no over-folding)', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  await createTask(ws, { title: 'someone else s card', assignee: 'dsh' }, 'human')

  const theirs = await inbox(ws, 'kimi', { poolLimit: 0 })
  assert.deepEqual(kinds(theirs), [])
})

// The session-start notice and the tools must answer "who am I" identically —
// they used to disagree whenever TASKBOARD_WATCH_NAMES was configured, so the
// notice counted `dsh`'s cards and the tools filed under `dsh-agent`.
await check('selfActor: one resolver for notice and tools', async () => {
  const env = { ...process.env }
  try {
    delete process.env.TASKBOARD_ACTOR
    delete process.env.TASKBOARD_WATCH_NAMES
    assert.equal(selfActor(), 'dsh-agent', 'no env at all → the default')

    process.env.TASKBOARD_WATCH_NAMES = 'dsh,dsh-agent'
    assert.equal(selfActor(), 'dsh', 'the first watch name is the canonical one')

    process.env.TASKBOARD_ACTOR = 'kimi'
    assert.equal(selfActor(), 'kimi', 'TASKBOARD_ACTOR outranks the watch names')
    assert.equal(selfActor('  dsh-audit '), 'dsh-audit', 'an explicit by wins, trimmed')
    assert.equal(selfActor('   '), 'kimi', 'a blank by falls back instead of becoming an empty owner')
  } finally {
    process.env = env
  }
})

for (const dir of dirs) await rm(dir, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
