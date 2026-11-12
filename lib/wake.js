/**
 * Startup wake loop.
 *
 * The restart script runs outside the Harness process (Task Scheduler), so it
 * cannot notify a session when the new instance is ready. This loop lives in
 * the new Host process: after a short delay it scans the registry and delivers
 * each entry through `sessionController.prompt`, which explicitly resumes cold
 * sessions. That is what makes "restart and come back" work without a timer.
 *
 * Safety boundaries:
 *   - no entries means complete silence (only a log line);
 *   - only text is delivered, never a command;
 *   - at most `maxAttempts` deliveries per entry, then archived as failed;
 *   - processed entries are renamed, so nothing is delivered twice.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  archive,
  discard,
  ensureDir,
  isExpired,
  listPending,
  pruneArchives,
  readTask,
} from './pending.js'
import { clearLock } from './restart.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Appended to every delivered wake-up.
 *
 * A session may have armed a re-check reminder while it waited. That reminder
 * is either already consumed (inactive, so `schedule_list` no longer shows it)
 * or about to fire in this new process — either way the session must delete it
 * by id before continuing. `schedule_edit({ id, action: 'delete' })` accepts
 * both active and inactive reminders, which is why the id has to be kept from
 * `schedule_create`.
 */
export const WAKE_CLEANUP_NOTE =
  '\n\n（dsh-restart-wake）你刚被重启唤醒。等待期间挂过的重检提醒请先删掉：`schedule_list` 只能看到未触发的；已触发的不在列表里，按你记下的 id 用 `schedule_edit({ id, action: "delete" })` 删（active 和 inactive 都能删）。删完再继续。'

/** Rotate wake.log once it outgrows `maxBytes`; at most two log files remain. */
function rotateLog(logPath, maxBytes) {
  try {
    if (!existsSync(logPath)) return
    if (statSync(logPath).size < maxBytes) return
    const previous = `${logPath}.1`
    try {
      rmSync(previous, { force: true })
    } catch {
      /* best effort */
    }
    renameSync(logPath, previous)
  } catch {
    /* rotation must never break logging */
  }
}

/** Append-only wake log plus the Host logger; logging never breaks activation. */
export function createLogger(ctx, options) {
  return (message) => {
    try {
      ensureDir(dirname(options.logPath))
      rotateLog(options.logPath, options.maxLogBytes ?? 256 * 1024)
      appendFileSync(options.logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
      /* the log file is best effort */
    }
    try {
      ctx.logger?.info?.(`restart-wake: ${message}`)
    } catch {
      /* same */
    }
  }
}

/**
 * `sessionController.prompt(request, signal)` requires an AbortSignal: the
 * implementation calls `signal.throwIfAborted()` immediately. Passing only the
 * request fails with "Cannot read properties of undefined (reading
 * 'throwIfAborted')" and no message is ever delivered.
 */
async function deliver(service, task, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.deliverTimeoutMs)
  try {
    return await service.prompt(
      {
        requestId: randomUUID(),
        sessionId: task.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `${task.prompt}${WAKE_CLEANUP_NOTE}` }],
        clientTimeZone: options.timeZone,
      },
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function waitForController(ctx, options) {
  const deadline = Date.now() + options.readyTimeoutMs
  while (Date.now() < deadline) {
    const service = ctx.get('sessionController')
    if (service && typeof service.prompt === 'function') return service
    await sleep(500)
  }
  return undefined
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Deliver one entry: validate, retry, archive. */
async function handleEntry(service, entry, options, log) {
  const label = entry.file.split(/[\\/]/).pop() ?? entry.file

  let task
  try {
    task = entry.task ?? readTask(entry.file)
  } catch (error) {
    log(`pending-unreadable ${label} ${errorText(error)}`)
    archive(options.pendingDir, entry.file, 'failed')
    return
  }

  if (isExpired(task, options.maxAgeMs)) {
    log(`expired session=${task.sessionId} createdAt=${task.createdAt ?? '-'}`)
    archive(options.pendingDir, entry.file, 'expired')
    return
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await deliver(service, task, options)
      log(`delivered session=${task.sessionId} attempt=${attempt} file=${label}`)
      // The log line is the record; a successful delivery leaves no file behind.
      discard(entry.file)
      return
    } catch (error) {
      const code = error && typeof error.code === 'string' ? ` code=${error.code}` : ''
      log(`deliver-failed session=${task.sessionId} attempt=${attempt}${code} ${errorText(error)}`)
      if (attempt < options.maxAttempts) await sleep(options.retryDelayMs)
    }
  }

  log(`gave-up session=${task.sessionId} after ${options.maxAttempts} attempts`)
  archive(options.pendingDir, entry.file, 'failed')
}

/**
 * Start the loop once per Host process.
 * @param ctx Cordis plugin context.
 * @param options Resolved plugin options.
 */
export function startWakeLoop(ctx, options) {
  const log = createLogger(ctx, options)

  async function run() {
    // A new Host process means the previous restart finished (or failed long
    // ago). Leaving the lock would make the next session believe somebody else
    // is still restarting and go to sleep for nothing.
    try {
      clearLock(options.lockPath)
    } catch (error) {
      log(`restart-lock-clear-failed ${errorText(error)}`)
    }

    // Housekeeping, every startup: failures/expiries keep only the newest N,
    // and successful-delivery archives from older versions are removed.
    try {
      const pruned = pruneArchives(options.pendingDir, options.keepArchives)
      if (pruned > 0) log(`pruned-archives removed=${pruned}`)
    } catch (error) {
      log(`prune-failed ${errorText(error)}`)
    }

    const entries = listPending(options.pendingDir)
    if (entries.length === 0) {
      log('no-pending')
      return
    }

    const service = await waitForController(ctx, options)
    if (service === undefined) {
      log(`controller-unavailable timeoutMs=${options.readyTimeoutMs} entries=${entries.length}`)
      return
    }

    const seen = new Set()
    for (const entry of entries) {
      let task
      try {
        task = entry.task ?? readTask(entry.file)
      } catch {
        task = undefined
      }
      if (task && seen.has(task.sessionId)) {
        log(`duplicate session=${task.sessionId} file=${entry.file}`)
        archive(options.pendingDir, entry.file, 'duplicate')
        continue
      }
      if (task) seen.add(task.sessionId)
      await handleEntry(service, entry, options, log)
    }
  }

  const start = () => {
    void run().catch((error) => log(`crashed ${errorText(error)}`))
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setTimeout(start, options.startupDelayMs)
      return () => clearTimeout(timer)
    }, 'restart-wake.startup()')
  } else {
    setTimeout(start, options.startupDelayMs)
  }
}
