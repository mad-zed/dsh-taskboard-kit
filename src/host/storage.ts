/**
 * Storage layouts for the board.
 *
 * Two shapes, one `Board`:
 *
 *   file   <cwd>/.dsh/taskboard.json        — the original single-file ledger.
 *   tasks  <cwd>/.dsh/taskboard/T-7K2M.json — one file per card, plus
 *          <cwd>/.dsh/taskboard/meta.json   — the few board-level facts that
 *                                             cannot be derived from a card.
 *
 * Why a second layout exists: a single ledger is a single merge conflict. Two
 * clones that each create a card both bump `next_seq` and both write the same
 * key, so `git merge` conflicts on the file, and a hand-merge can silently drop
 * a card (last duplicate key wins). With one file per card, two branches that
 * touch different cards merge cleanly; only two edits to the SAME card conflict,
 * which is the conflict worth resolving by hand.
 *
 * Nothing here may become a new shared hotspot. The card id is random, so no
 * allocator is shared; `actors` is derived on load, so no roster is rewritten on
 * every action; review notices live on the card they are about; only `tails`
 * settlements stay in `meta.json`, and those are written by an explicit CLI
 * command, not by ordinary agent traffic.
 *
 * The mode is a pure function of the workspace plus one preference: `auto`
 * picks `tasks` once a board directory exists (i.e. after `taskboard migrate
 * --to tasks`, or on a workspace that opted in) and `file` otherwise. Existing
 * single-file boards keep working untouched unless the user migrates.
 *
 * @module dsh-taskboard-kit/storage
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Board, Task } from '../shared/types.ts'

export type StorageMode = 'file' | 'tasks'
export type StoragePreference = 'auto' | StorageMode

/** Set from plugin config (`storage`) or the CLI/env; `auto` by default. */
let preference: StoragePreference = 'auto'

export function setStoragePreference(mode: StoragePreference | undefined): void {
  preference = mode ?? 'auto'
}

export function storagePreference(): StoragePreference {
  return preference
}

/** The single-file ledger (the legacy layout, still the default for new boards). */
export function boardFilePath(cwd: string): string {
  return join(cwd, '.dsh', 'taskboard.json')
}

/** The directory that holds one file per card. */
export function boardDirPath(cwd: string): string {
  return join(cwd, '.dsh', 'taskboard')
}

/** Board-level facts that no card owns. */
export function metaFilePath(cwd: string): string {
  return join(boardDirPath(cwd), 'meta.json')
}

/** The lock file is shared by both layouts: one writer per workspace, ever. */
export function lockFilePath(cwd: string): string {
  return `${boardFilePath(cwd)}.lock`
}

/** `T-7K2M.json` for the canonical name (a future slug suffix is tolerated on read). */
export function cardFilePath(cwd: string, id: string): string {
  return join(boardDirPath(cwd), `${id}.json`)
}

/** Any id this store will address: legacy `T-42` and the random `T-7K2M`. */
export const TASK_ID_PATTERN = /^T-(?:\d+|[0-9A-Z]{4})$/

/** The alphabet excludes 0/O/1/I/L: ids get read aloud and typed by hand. */
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const ID_LENGTH = 4

/** A fresh random card id; the caller checks it against the board for collisions. */
export function randomTaskId(): string {
  const bytes = randomBytes(8)
  let body = ''
  for (let index = 0; body.length < ID_LENGTH; index += 1) {
    body += ID_ALPHABET[bytes[index % bytes.length]! % ID_ALPHABET.length]
  }
  return `T-${body}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Which layout this workspace uses right now. */
export async function resolveStorageMode(cwd: string): Promise<StorageMode> {
  // Explicit config wins; then the env switch (the CLI/agent side); then `auto`.
  if (preference !== 'auto') return preference
  const env = process.env.TASKBOARD_STORAGE
  if (env === 'file' || env === 'tasks') return env
  return (await exists(boardDirPath(cwd))) ? 'tasks' : 'file'
}

/** What a load remembered, so a save can write only the files that changed. */
export interface CardSnapshot {
  /** id → the exact bytes last seen on disk. */
  cards: Map<string, string>
  /** id → the file it was read from (a slug-suffixed name is written back in place). */
  files: Map<string, string>
  /** The meta file's exact bytes (null when there was none). */
  meta: string | null
  /** How many cards this workspace had at load time (the "vanished" guard). */
  seen: number
}

/**
 * Per-board snapshots, keyed by the returned object. A WeakMap: boards are
 * short-lived, and a stale snapshot must never outlive the object it describes.
 */
const snapshots = new WeakMap<Board, CardSnapshot>()

export function snapshotOf(board: Board): CardSnapshot | undefined {
  return snapshots.get(board)
}

export function rememberSnapshot(board: Board, snapshot: CardSnapshot): void {
  snapshots.set(board, snapshot)
}

/** Atomic text write: tmp-then-rename, 0600, no litter on failure. */
let tempCounter = 0

export async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${(tempCounter += 1)}`
  try {
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Serialize exactly the way both layouts write a task. */
export function taskText(task: Task): string {
  return `${JSON.stringify(task, null, 2)}\n`
}

export function metaText(board: Board): string {
  return `${JSON.stringify({ version: 1, tails: board.tails ?? {} }, null, 2)}\n`
}

/** Result of reading the task directory. */
export interface TaskDirRead {
  cards: Map<string, string>
  files: Map<string, string>
  meta: string | null
  /** The directory does not exist at all. */
  missing: boolean
}

/**
 * Read every card file without interpreting it. Parsing/validation stays in
 * the store, so both layouts share one set of shape checks and error messages.
 */
export async function readTaskDir(cwd: string): Promise<TaskDirRead> {
  const dir = boardDirPath(cwd)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cards: new Map(), files: new Map(), meta: null, missing: true }
    }
    throw error
  }
  const cards = new Map<string, string>()
  const files = new Map<string, string>()
  let meta: string | null = null
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    if (entry.name === 'meta.json') {
      meta = await readFile(path, 'utf8')
      continue
    }
    // `T-7K2M.json`, plus `T-7K2M-fix-login.json` for a future readable suffix.
    const match = /^(T-(?:\d+|[0-9A-Z]{4}))(?:-[a-z0-9-]{1,32})?\.json$/.exec(entry.name)
    if (!match) continue
    cards.set(match[1]!, await readFile(path, 'utf8'))
    files.set(match[1]!, path)
  }
  return { cards, files, meta, missing: false }
}

/** Write only the cards whose bytes changed, plus meta when it changed. */
export async function saveTaskDir(cwd: string, board: Board, snapshot: CardSnapshot): Promise<void> {
  const dir = boardDirPath(cwd)
  await mkdir(dir, { recursive: true })
  for (const [id, task] of Object.entries(board.tasks)) {
    const text = taskText(task)
    if (snapshot.cards.get(id) === text) continue
    const file = snapshot.files.get(id) ?? cardFilePath(cwd, id)
    await atomicWrite(file, text)
    snapshot.cards.set(id, text)
    snapshot.files.set(id, file)
  }
  // Cards are never deleted through the tool surface, but a future prune or a
  // hand-removed file must not leave a ghost behind after a save.
  for (const id of snapshot.cards.keys()) {
    if (Object.hasOwn(board.tasks, id)) continue
    await rm(snapshot.files.get(id) ?? cardFilePath(cwd, id), { force: true })
    snapshot.cards.delete(id)
    snapshot.files.delete(id)
  }
  const meta = metaText(board)
  if (snapshot.meta !== meta) {
    await atomicWrite(metaFilePath(cwd), meta)
    snapshot.meta = meta
  }
  snapshot.seen = Object.keys(board.tasks).length
}

/** Directory mtime is not enough: a changed card does not touch its parent. */
export async function boardMtimeMs(cwd: string, mode: StorageMode): Promise<number> {
  if (mode === 'file') {
    try {
      return (await stat(boardFilePath(cwd))).mtimeMs
    } catch {
      return 0
    }
  }
  const { cards, files, meta } = await readTaskDir(cwd)
  let newest = 0
  for (const path of files.values()) {
    try {
      newest = Math.max(newest, (await stat(path)).mtimeMs)
    } catch {
      // A card removed between readdir and stat cannot make the board newer.
    }
  }
  if (meta !== null) {
    try {
      newest = Math.max(newest, (await stat(metaFilePath(cwd))).mtimeMs)
    } catch {
      // Same as above.
    }
  }
  void cards
  return newest
}

/** The human-facing path the UI prints for this workspace's board. */
export async function displayBoardPath(cwd: string): Promise<string> {
  return (await resolveStorageMode(cwd)) === 'file' ? boardFilePath(cwd) : boardDirPath(cwd)
}

export function workspaceOf(cwd: string): string {
  return resolve(cwd)
}
