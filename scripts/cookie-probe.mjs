// Read-only snapshot of Harness browser-session cookies (optional helper).
//
// Chromium keeps the Cookies SQLite file open exclusively while the app runs, so
// the only readable window is between the browser process dying and the next
// instance starting. The restart script calls this inside that window and logs
// whatever it prints.
//
// Usage: node cookie-probe.mjs <path-to-Cookies>

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Chromium stores expiry as microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET = 11644473600000000;
const HOUR_IN_MICROSECONDS = 3.6e9;

function summarize(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // expires_utc exceeds Number.MAX_SAFE_INTEGER, and node:sqlite refuses to hand
    // back such a value as a JavaScript number -- so read it as text and do the
    // arithmetic in BigInt.
    const rows = db
      .prepare(
        "SELECT CAST(expires_utc AS TEXT) AS expires_text FROM cookies " +
          "WHERE name LIKE 'dsh-auth-%' ORDER BY expires_utc"
      )
      .all();
    const nowChrome = BigInt(Date.now()) * 1000n + BigInt(CHROME_EPOCH_OFFSET);
    const ttl = rows.map((row) => {
      const microseconds = BigInt(row.expires_text);
      if (microseconds <= 0n) return 'session';
      const hours = Number(microseconds - nowChrome) / HOUR_IN_MICROSECONDS;
      return hours.toFixed(1) + 'h';
    });
    return 'authCookies=' + rows.length + ' ttl=[' + ttl.join(',') + ']';
  } finally {
    db.close();
  }
}

const source = process.argv[2];
if (!source || !existsSync(source)) {
  console.log('probe-error=missing-db');
  process.exit(0);
}

let result;
try {
  result = summarize(source);
} catch (directError) {
  // Fallback: copy the database and its WAL companions to a temp dir, then read that.
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-cookies-'));
    for (const suffix of ['', '-wal', '-shm']) {
      const from = source + suffix;
      if (existsSync(from)) copyFileSync(from, join(dir, 'Cookies' + suffix));
    }
    result = summarize(join(dir, 'Cookies'));
  } catch (copyError) {
    result = 'probe-error=' + directError.message + ' / ' + copyError.message;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort: a leftover temp dir is harmless
      }
    }
  }
}

// One line only: the restart script folds this into a single log entry.
console.log(result.replace(/\s+/g, ' '));
