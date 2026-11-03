// Restart-window cleanup for the `dsh-auth-*` cookie pile-up.
//
// Why this exists: the Desktop Host listens on a random port on every launch
// and mints one `dsh-auth-<authority-hash>` cookie per port. Chromium only ever
// accumulates those names, so after roughly 70 launches the Cookie request
// header passes Node's 16 KB limit, the Host answers 431 Request Header Fields
// Too Large, and the Electron shell reports "Web authentication failed" and
// aborts startup.
//
// Chromium holds the SQLite file exclusively while Harness runs, so the only
// window in which this file can be opened read-write is between the browser
// process dying and the next instance starting -- exactly when the restart
// script calls this. It only deletes `dsh-auth-%` rows and never touches other
// cookies or account credentials.
//
// Usage:
//   node cookie-cleanup.mjs <CookiesDb> [--dry-run] [--auto] [--threshold=50]
//
//   (no --auto)  report, then purge every dsh-auth-* cookie
//   --auto       purge only when the count reaches --threshold (default 50)
//   --dry-run    report only
//
// Output is one ASCII line so the restart script can fold it into a single log
// entry. Exit code is 0 in every non-crash case: a failed probe must never
// block a restart.

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BYTES_PER_AUTH_COOKIE = 228

function parseArgs(argv) {
  const result = { dbPath: '', dryRun: false, auto: false, threshold: 50 }
  for (const arg of argv) {
    if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--auto') result.auto = true
    else if (arg.startsWith('--threshold=')) {
      const value = Number(arg.slice('--threshold='.length))
      if (Number.isFinite(value) && value > 0) result.threshold = Math.trunc(value)
    } else if (!arg.startsWith('--')) {
      result.dbPath = arg
    }
  }
  return result
}

function emit(text) {
  console.log(String(text).replace(/\s+/g, ' ').trim())
}

const options = parseArgs(process.argv.slice(2))

if (!options.dbPath) {
  emit('cookie-cleanup-error=missing-db-argument')
  process.exit(0)
}
if (!existsSync(options.dbPath)) {
  emit('cookie-cleanup-error=missing-db')
  process.exit(0)
}

let db
try {
  db = new DatabaseSync(options.dbPath, { readOnly: options.dryRun })
} catch (error) {
  emit(`cookie-cleanup-error=open-failed ${error && error.message ? error.message : error}`)
  process.exit(0)
}

try {
  db.exec('PRAGMA busy_timeout=3000')
  const authCount = Number(
    db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE name LIKE 'dsh-auth-%'").get().c,
  )
  const totalCount = Number(db.prepare('SELECT COUNT(*) AS c FROM cookies').get().c)
  const headerKb = Math.round((authCount * BYTES_PER_AUTH_COOKIE) / 1024)
  const shouldPurge = !options.dryRun && (!options.auto || authCount >= options.threshold)

  let removed = 0
  let action = 'kept'
  if (shouldPurge) {
    const info = db.prepare("DELETE FROM cookies WHERE name LIKE 'dsh-auth-%'").run()
    removed = Number(info.changes)
    action = 'purged'
    // The restart script may be killed at any moment; flush the WAL now.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* checkpoint is best effort */
    }
  }

  emit(
    `authCookies=${authCount} others=${totalCount - authCount} headerKB=${headerKb} ` +
      `threshold=${options.threshold} action=${action} removed=${removed}`,
  )
} catch (error) {
  emit(`cookie-cleanup-error=query-failed ${error && error.message ? error.message : error}`)
} finally {
  try {
    db.close()
  } catch {
    /* best effort */
  }
}
