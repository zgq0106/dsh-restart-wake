/**
 * The wake registry on disk.
 *
 * One file per session (`wake-pending-<sessionId>.json`) so two sessions never
 * overwrite each other. The same file doubles as the "waiting" registry: a
 * restart decision treats a session that has registered as already finished.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * `wake-pending*.json`, excluding archived results.
 *
 * Older versions left `wake-pending-done-*.json` files that also start with
 * `wake-pending`; without the exclusion they would be delivered again.
 */
export const PENDING_PATTERN = /^wake-pending(?!-(done|failed|expired|duplicate)).*\.json$/i

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** Session ids are UUID-shaped; still sanitize so a caller cannot escape the dir. */
export function pendingFileName(sessionId) {
  return `wake-pending-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

/**
 * Register a wake-up. Returns the absolute file path.
 */
export function writePending(dir, sessionId, prompt, now = new Date()) {
  ensureDir(dir)
  const file = join(dir, pendingFileName(sessionId))
  const body = { sessionId: String(sessionId), prompt: String(prompt), createdAt: now.toISOString() }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return file
}

/** Read one entry; throws on malformed content so callers can archive it. */
export function readTask(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.prompt !== 'string') {
    throw new Error('pending file missing sessionId or prompt')
  }
  return parsed
}

/** Every live entry, sorted by file name for stable ordering. */
export function listPending(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => PENDING_PATTERN.test(name))
    .sort()
    .map((name) => {
      const file = join(dir, name)
      try {
        return { file, task: readTask(file), error: undefined }
      } catch (error) {
        return { file, task: undefined, error: error instanceof Error ? error.message : String(error) }
      }
    })
}

/** Is this session already registered? Used by the blocked-session check. */
export function hasPending(dir, sessionId) {
  return existsSync(join(dir, pendingFileName(sessionId)))
}

/**
 * Rename a processed entry so it is never delivered twice.
 * Returns the target path, or undefined when the rename failed.
 */
export function archive(dir, file, suffix, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const core = basename(file)
    .replace(/^wake-pending/i, '')
    .replace(/\.json$/i, '')
    .replace(/^[-_.]+/, '')
  const renamed =
    core === '' ? `wake-${suffix}-${stamp}.json` : `wake-${suffix}-${core}-${stamp}.json`
  const target = join(dirname(file), renamed)
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}

/** Remove one session's entry (explicit cancel). */
export function removePending(dir, sessionId) {
  const file = join(dir, pendingFileName(sessionId))
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** An entry without a parseable `createdAt` is delivered, never silently dropped. */
export function isExpired(task, maxAgeMs, now = Date.now()) {
  const createdAt = Date.parse(task?.createdAt ?? '')
  return Number.isFinite(createdAt) && now - createdAt > maxAgeMs
}

/** Newest archived entries (done / failed / expired), for `wake_list`. */
export function listArchived(dir, limit = 10) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => /^wake-(done|failed|expired|duplicate)-.*\.json$/i.test(name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => join(dir, name))
}
