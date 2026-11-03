/**
 * Read-only inspection of the Chromium cookie store.
 *
 * The Desktop Host picks a random port on every launch and mints one
 * `dsh-auth-<authority-hash>` cookie per port. Chromium never removes the old
 * names, so they pile up; around 70 entries the Cookie header passes Node's
 * 16 KB limit, the Host answers 431, and the Electron shell reports
 * "Web authentication failed" and aborts startup.
 *
 * Chromium holds this SQLite file exclusively while Harness runs, so a read
 * outside the restart window usually fails with SQLITE_BUSY. Callers must treat
 * `available: false` as "cannot tell right now", never as "no cookies".
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** One `dsh-auth-*` entry contributes roughly this many Cookie-header bytes. */
export const BYTES_PER_AUTH_COOKIE = 228

/** Node's default max HTTP header size. */
export const NODE_HEADER_LIMIT_BYTES = 16 * 1024

/**
 * @param {string} dbPath Absolute path to the Chromium `Cookies` database.
 */
export function inspectCookieStore(dbPath) {
  if (!dbPath || !existsSync(dbPath)) {
    return { available: false, reason: 'missing-db', dbPath: dbPath || '' }
  }

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return {
      available: false,
      reason: 'locked',
      message: error instanceof Error ? error.message : String(error),
      dbPath,
    }
  }

  try {
    db.exec('PRAGMA busy_timeout=2000')
    const authCount = Number(
      db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get().c,
    )
    const totalCount = Number(db.prepare('SELECT COUNT(*) AS c FROM cookies').get().c)
    return {
      available: true,
      dbPath,
      authCount,
      totalCount,
      headerBytes: authCount * BYTES_PER_AUTH_COOKIE,
      headerLimitBytes: NODE_HEADER_LIMIT_BYTES,
    }
  } catch (error) {
    return {
      available: false,
      reason: 'query-failed',
      message: error instanceof Error ? error.message : String(error),
      dbPath,
    }
  } finally {
    try {
      db.close()
    } catch {
      /* best effort */
    }
  }
}
