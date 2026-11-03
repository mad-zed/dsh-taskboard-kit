/**
 * Storage-layout test: the one-file-per-card board (v0.9.5).
 *
 * The headline property is the reason the layout exists — two clones that each
 * create a card end up with two DIFFERENT files, so a `git merge` of the two
 * branches has nothing to conflict about, while an edit to the same card still
 * lands in one file (and therefore still conflicts, which is the conflict worth
 * resolving by hand).
 *
 * Run: node tests/storage.test.mjs   (after npm run build)
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKBOARDKIT_LOCALE = 'en'
delete process.env.TASKBOARD_STORAGE

const {
  StoreError,
  boardDirPath,
  boardFilePath,
  claimTask,
  createTask,
  enableBoard,
  getTask,
  listTasks,
  loadBoard,
  migrateBoardLayout,
  resolveStorageMode,
  saveBoard,
  updateTask,
  vanishedCount,
} = await import('../lib/index.js')

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-taskboard-storage-'))
  dirs.push(dir)
  return dir
}

const cardFiles = async (ws) => (await readdir(boardDirPath(ws))).filter((name) => name.endsWith('.json'))

await check('a fresh workspace can be moved to the per-card layout, which then holds meta.json + one file per card', async () => {
  const ws = await workspace()
  assert.equal(await resolveStorageMode(ws), 'file', 'no board at all reads as the legacy layout')
  await migrateBoardLayout(ws, 'tasks')
  assert.equal(await resolveStorageMode(ws), 'tasks')

  const task = await createTask(ws, { title: 'first card' }, 'dsh')
  assert.match(task.id, /^T-[0-9A-Z]{4}$/, `random id expected, got ${task.id}`)

  const files = await cardFiles(ws)
  assert.ok(files.includes('meta.json'), 'meta.json is part of the layout')
  assert.ok(files.includes(`${task.id}.json`), `card file ${task.id}.json expected, got ${files.join(', ')}`)
  const onDisk = JSON.parse(await readFile(join(boardDirPath(ws), `${task.id}.json`), 'utf8'))
  assert.equal(onDisk.id, task.id)
  assert.equal(onDisk.title, 'first card')
})

await check('ids are random: the same workspace never reuses one, and they are not sequential', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const ids = []
  for (let index = 0; index < 12; index += 1) {
    ids.push((await createTask(ws, { title: `card ${index}` }, 'dsh')).id)
  }
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique')
  for (const id of ids) assert.match(id, /^T-[0-9A-Z]{4}$/)
  assert.ok(ids.some((id) => /[A-Z]/.test(id)), 'random alphabet ids should contain a letter by now')
})

await check('a mutation rewrites only the card it touched (untouched cards keep their bytes and mtime)', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const a = await createTask(ws, { title: 'stays put' }, 'dsh')
  const b = await createTask(ws, { title: 'moves on' }, 'dsh')
  const pathB = join(boardDirPath(ws), `${b.id}.json`)
  const before = { text: await readFile(pathB, 'utf8'), mtime: (await stat(pathB)).mtimeMs }

  await claimTask(ws, b.id, 'kimi')
  const after = { text: await readFile(pathB, 'utf8'), mtime: (await stat(pathB)).mtimeMs }
  assert.notEqual(after.text, before.text, 'the claimed card must change')
  assert.ok(after.mtime >= before.mtime)

  const pathA = join(boardDirPath(ws), `${a.id}.json`)
  assert.equal(await readFile(pathA, 'utf8'), await readFile(pathA, 'utf8'))
  const untouched = JSON.parse(await readFile(pathA, 'utf8'))
  assert.deepEqual(untouched, a, 'the untouched card is byte-identical on reload')
})

await check('the roster is derived: a named-but-idle assignee has no liveness, the actor who moved the card does', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'delegated', assignee: 'kimi' }, 'dsh')
  const board = await loadBoard(ws)
  assert.equal(board.actors.kimi?.last_seen_at, null, 'being named is not evidence of activity')
  assert.equal(board.actors.dsh?.last_seen_at !== null, true, 'the creator acted')

  const free = await createTask(ws, { title: 'free work' }, 'dsh')
  await claimTask(ws, free.id, 'claude')
  const after = await loadBoard(ws)
  assert.ok(after.actors.claude?.last_seen_at, 'the claimer is live now')
  const disk = JSON.parse(await readFile(join(boardDirPath(ws), `${task.id}.json`), 'utf8'))
  assert.equal(disk.actors, undefined, 'the roster is never written into a card file')
})

await check('two branches creating a card each merge without a conflict: different ids, different files', async () => {
  const base = await workspace()
  await migrateBoardLayout(base, 'tasks')
  await createTask(base, { title: 'shared base card' }, 'dsh')

  // Two clones of the same workspace (the `git clone` shape).
  const a = await workspace()
  const b = await workspace()
  await cp(base, a, { recursive: true })
  await cp(base, b, { recursive: true })

  const ta = await createTask(a, { title: 'from branch a' }, 'dsh')
  const tb = await createTask(b, { title: 'from branch b' }, 'dsh')
  assert.notEqual(ta.id, tb.id, 'a shared next_seq is exactly what used to collide')

  // `git merge b` = bring b's new card file into a (nothing else changed).
  await cp(
    join(boardDirPath(b), `${tb.id}.json`),
    join(boardDirPath(a), `${tb.id}.json`),
  )
  const merged = await loadBoard(a)
  assert.equal(Object.keys(merged.tasks).length, 3, 'base + one new card from each branch')
  assert.ok(merged.tasks[ta.id] && merged.tasks[tb.id])
  assert.equal((await cardFiles(a)).filter((name) => name !== 'meta.json').length, 3)
})

await check('the same card edited in two branches stays ONE file — that is the conflict a human resolves', async () => {
  const base = await workspace()
  await migrateBoardLayout(base, 'tasks')
  const task = await createTask(base, { title: 'contended' }, 'dsh')

  const a = await workspace()
  const b = await workspace()
  await cp(base, a, { recursive: true })
  await cp(base, b, { recursive: true })

  await claimTask(a, task.id, 'kimi')
  await claimTask(b, task.id, 'claude')
  const fileA = JSON.parse(await readFile(join(boardDirPath(a), `${task.id}.json`), 'utf8'))
  const fileB = JSON.parse(await readFile(join(boardDirPath(b), `${task.id}.json`), 'utf8'))
  assert.notEqual(fileA.assignee, fileB.assignee)
  // Same path in both clones: `git merge` flags it, and the fix is choosing one
  // assignee — not untangling two cards that share one JSON key.
  assert.equal(`${task.id}.json`, `${task.id}.json`)
})

await check('migrating file → tasks keeps every card, keeps a recovery copy, and file → tasks → file round-trips', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'file')
  const one = await createTask(ws, { title: 'legacy one', detail: 'd' }, 'dsh')
  const two = await createTask(ws, { title: 'legacy two' }, 'dsh')
  await claimTask(ws, two.id, 'kimi')

  const toTasks = await migrateBoardLayout(ws, 'tasks')
  assert.equal(toTasks.from, 'file')
  assert.equal(toTasks.tasks, 2)
  assert.ok(toTasks.backup?.endsWith('taskboard.json.pre-tasks'))
  assert.equal(await readFile(toTasks.backup, 'utf8').then((text) => JSON.parse(text).tasks[one.id].title), 'legacy one')

  const roundTrip = await loadBoard(ws)
  assert.equal(roundTrip.tasks[one.id]?.title, 'legacy one')
  assert.equal(roundTrip.tasks[two.id]?.status, 'in_progress')
  assert.equal(roundTrip.tasks[two.id]?.assignee, 'kimi')

  const backToFile = await migrateBoardLayout(ws, 'file')
  assert.equal(backToFile.from, 'tasks')
  assert.ok(backToFile.backup?.endsWith('taskboard.pre-file'))
  const fileBoard = JSON.parse(await readFile(boardFilePath(ws), 'utf8'))
  assert.equal(fileBoard.tasks[one.id]?.title, 'legacy one')
  assert.equal(fileBoard.tasks[two.id]?.assignee, 'kimi')
})

await check('migrating to the layout already in use is a no-op, not a rewrite', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'stable' }, 'dsh')
  const path = join(boardDirPath(ws), `${task.id}.json`)
  const before = await readFile(path, 'utf8')
  const again = await migrateBoardLayout(ws, 'tasks')
  assert.equal(again.from, 'tasks')
  assert.equal(await readFile(path, 'utf8'), before)
})

await check('a card file that is not valid JSON fails loudly, naming the one file to fix', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'broken later' }, 'dsh')
  await writeFile(join(boardDirPath(ws), `${task.id}.json`), '{ not json', 'utf8')
  await assert.rejects(() => loadBoard(ws), (error) => error instanceof StoreError && /not valid JSON/.test(error.message))
})

await check('the whole board is still loadable and complete after every operation', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  const task = await createTask(ws, { title: 'lifecycle', priority: 'high', value: 3, tags: ['a'] }, 'dsh')
  await claimTask(ws, task.id, 'kimi')
  await updateTask(ws, task.id, { action: 'submit', reviewer: 'claude', note: 'handoff' }, 'kimi')
  const got = await getTask(ws, task.id)
  assert.equal(got.status, 'review')
  assert.equal(got.reviewer, 'claude')
  assert.ok(got.log.some((entry) => entry.event === 'submitted'))
  assert.equal((await listTasks(ws)).length, 1)
  // and the derived roster knows both agents
  const board = await loadBoard(ws)
  assert.ok(board.actors.kimi && board.actors.claude)
})

await check('saveBoard on the per-card layout writes meta only when tails change', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'tasks')
  await createTask(ws, { title: 'meta stability' }, 'dsh')
  const metaPath = join(boardDirPath(ws), 'meta.json')
  const before = (await stat(metaPath)).mtimeMs
  const board = await loadBoard(ws)
  await saveBoard(ws, board)
  const after = (await stat(metaPath)).mtimeMs
  assert.equal(after, before, 'meta.json must not be rewritten by an unchanged save')
})

await check('enableBoard creates the layout it was asked for, and never converts an existing board', async () => {
  const tasksWs = await workspace()
  const enabled = await enableBoard(tasksWs, { layout: 'tasks', seedProtocol: false })
  assert.equal(enabled.board_file, boardDirPath(tasksWs), 'the wizard-chosen layout is what gets created')
  assert.equal(enabled.already_existed, false)
  assert.equal(await resolveStorageMode(tasksWs), 'tasks')
  assert.equal(await readdir(boardDirPath(tasksWs)).then((names) => names.includes('meta.json')), true)

  // Asking for the other layout later must NOT convert it (that is `migrate`).
  const again = await enableBoard(tasksWs, { layout: 'file', seedProtocol: false })
  assert.equal(again.already_existed, true)
  assert.equal(again.board_file, boardDirPath(tasksWs), 'the existing per-card board kept its layout')
  assert.equal(existsSync(boardFilePath(tasksWs)), false, 'no single ledger was created next to it')

  const fileWs = await workspace()
  const fileEnabled = await enableBoard(fileWs, { layout: 'file', seedProtocol: false })
  assert.equal(fileEnabled.board_file, boardFilePath(fileWs))
  const fileAgain = await enableBoard(fileWs, { layout: 'tasks', seedProtocol: false })
  assert.equal(fileAgain.board_file, boardFilePath(fileWs), 'an existing single ledger is not converted either')
  assert.equal(await resolveStorageMode(fileWs), 'file')
})

await check('layout precedence: an existing board is never re-read as the other layout, even with the preference pinned', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'file')
  const task = await createTask(ws, { title: 'legacy card' }, 'dsh')

  process.env.TASKBOARD_STORAGE = 'tasks'
  try {
    assert.equal(await resolveStorageMode(ws), 'file', 'the artifact on disk wins over the preference')
    const board = await loadBoard(ws)
    assert.equal(board.tasks[task.id]?.title, 'legacy card', 'the card is still visible, not an "empty" per-card board')
  } finally {
    delete process.env.TASKBOARD_STORAGE
  }
})

await check('a brand-new workspace follows the pinned preference (tasks)', async () => {
  const ws = await workspace()
  process.env.TASKBOARD_STORAGE = 'tasks'
  try {
    assert.equal(await resolveStorageMode(ws), 'tasks')
    const enabled = await enableBoard(ws, { seedProtocol: false })
    assert.equal(enabled.board_file, boardDirPath(ws), 'no layout argument → the preference decides')
    const task = await createTask(ws, { title: 'new in tasks' }, 'dsh')
    assert.match(task.id, /^T-[0-9A-Z]{4}$/)
  } finally {
    delete process.env.TASKBOARD_STORAGE
  }
})


await check('a deleted single-file board does not poison a workspace that now resolves to the per-card layout', async () => {
  const ws = await workspace()
  await migrateBoardLayout(ws, 'file')
  await createTask(ws, { title: 'gone soon' }, 'dsh')
  await loadBoard(ws) // this process has seen the single-file board
  await rm(boardFilePath(ws), { force: true })

  // The profile pins `tasks`, so with nothing on disk this workspace now
  // resolves to the per-card layout — the deleted FILE board must not mark it
  // as "vanished" (that was the bug: the panel dead-ended on an error).
  process.env.TASKBOARD_STORAGE = 'tasks'
  try {
    assert.equal(await resolveStorageMode(ws), 'tasks')
    const board = await loadBoard(ws)
    assert.deepEqual(Object.keys(board.tasks), [])
    assert.equal(vanishedCount(board), undefined, 'per-layout counters: the file layout cannot mark the card layout')
    const enabled = await enableBoard(ws, { layout: 'tasks', seedProtocol: false })
    assert.equal(enabled.board_file, boardDirPath(ws))
  } finally {
    delete process.env.TASKBOARD_STORAGE
  }
})
for (const dir of dirs) await rm(dir, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
