/**
 * Restart mechanics: mutex, blocked-session check, Task Scheduler call, log tail.
 *
 * Why Task Scheduler: Harness puts its children in a Windows Job Object, so a
 * script started from inside the Harness process is killed together with it and
 * never reaches the relaunch step. A one-shot scheduled task runs outside that
 * Job Object and survives the kill.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { ensureDir } from './pending.js'

const execFileAsync = promisify(execFile)

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ─────────────────────────────── mutex ─────────────────────────────── */

/**
 * Read the restart mutex.
 * A lock is only a mutex: once it exists, another session must not schedule a
 * second restart. An old lock means the previous attempt died halfway.
 */
export function readLock(lockPath, staleMs, now = Date.now()) {
  if (!existsSync(lockPath)) return { held: false, stale: false, ageMs: 0 }
  let ageMs = 0
  try {
    ageMs = Math.max(0, now - statSync(lockPath).mtimeMs)
  } catch {
    return { held: false, stale: false, ageMs: 0 }
  }
  return { held: true, stale: ageMs > staleMs, ageMs }
}

export function writeLock(lockPath, sessionId) {
  ensureDir(dirname(lockPath))
  writeFileSync(
    lockPath,
    `${JSON.stringify({ sessionId: String(sessionId), at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

export function clearLock(lockPath) {
  rmSync(lockPath, { force: true })
}

/* ─────────────────────────── session state ─────────────────────────── */

/**
 * Running sessions from the live `sessionController`.
 *
 * `list(request, signal)` is the same admission path the Web panel uses.
 * Returns `available: false` when the Host profile has no session controller,
 * so callers can distinguish "nobody is running" from "cannot tell".
 */
export async function listRunningSessions(ctx) {
  const service = ctx.get('sessionController')
  if (!service || typeof service.list !== 'function') {
    return { available: false, sessions: [], error: 'sessionController 未组合' }
  }
  try {
    const value = await service.list({}, new AbortController().signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return {
      available: true,
      sessions: items
        .filter((item) => item && item.running === true)
        .map((item) => ({
          sessionId: String(item.sessionId),
          updatedAt:
            typeof item.updatedAt === 'number' ? new Date(item.updatedAt).toISOString() : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
        })),
    }
  } catch (error) {
    return { available: false, sessions: [], error: errorText(error) }
  }
}

/* ───────────────────────────── scheduling ───────────────────────────── */

async function runSchtasks(args) {
  try {
    return await execFileAsync('schtasks', args, { windowsHide: true })
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    const stdout = String(error?.stdout ?? '').trim()
    const detail = stderr || stdout || errorText(error)
    throw new Error(`schtasks ${args[0]} 失败：${detail}`)
  }
}

/** The restart script reads everything it needs from this JSON file. */
export function restartPayload(options, delaySeconds) {
  return {
    exePath: options.exePath,
    processName: options.processName,
    logPath: options.logPath,
    taskName: options.taskName,
    delaySeconds,
    launchWaitSeconds: options.launchWaitSeconds,
    maxLaunchAttempts: options.maxLaunchAttempts,
    graceSeconds: options.graceSeconds,
    killTimeoutSeconds: options.killTimeoutSeconds,
    singleInstanceWaitSeconds: options.singleInstanceWaitSeconds,
    cookieDbPath: options.cookieDbPath,
    cookieProbePath: options.cookieProbePath,
    cookieCleanupPath: options.cookieCleanupPath,
    cookieThreshold: options.cookieThreshold,
    crashLogDir: options.crashLogDir,
  }
}

/**
 * Create and immediately run the one-shot scheduled task.
 *
 * Everything is validated before the task is created: a missing executable
 * would otherwise produce a restart that kills the app and never brings it
 * back.
 *
 * @returns {{ configPath: string, taskName: string, commandLine: string }}
 */
export async function scheduleRestart(options, { delaySeconds }) {
  if (process.platform !== 'win32') {
    throw new Error('自动重启目前只支持 Windows（依赖 schtasks 与 PowerShell）。')
  }
  if (!existsSync(options.exePath)) {
    throw new Error(
      `找不到 Harness 可执行文件：${options.exePath || '(未配置)'}。请在插件配置里设置 exePath。`,
    )
  }
  if (!existsSync(options.scriptPath)) {
    throw new Error(`找不到重启脚本：${options.scriptPath}`)
  }
  if (!existsSync(options.commandPath)) {
    throw new Error(`找不到计划任务入口：${options.commandPath}`)
  }

  ensureDir(options.pendingDir)
  const payload = restartPayload(options, delaySeconds)
  writeFileSync(options.restartConfigPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  // Keep /TR under the 260-character Task Scheduler limit. The command only
  // carries the script path plus the payload path; all settings live in the
  // payload file, so long process names or cookies paths cannot overflow it.
  const taskCommand = `"${options.commandPath}" "${options.restartConfigPath}"`
  if (taskCommand.length > 260) {
    throw new Error(
      `计划任务命令过长（${taskCommand.length} > 260）。请把 pendingDir 改到更短的路径，例如 C:\\dsh-wake。`,
    )
  }

  await runSchtasks(['/Create', '/TN', options.taskName, '/TR', taskCommand, '/SC', 'ONCE', '/ST', '00:00', '/F'])
  try {
    await runSchtasks(['/Run', '/TN', options.taskName])
  } catch (error) {
    // Do not leave a task that will fire on its own schedule later.
    await runSchtasks(['/Delete', '/TN', options.taskName, '/F']).catch(() => {})
    throw error
  }

  return {
    configPath: options.restartConfigPath,
    taskName: options.taskName,
    commandLine: `schtasks /Run /TN "${options.taskName}"`,
  }
}

/** Remove a leftover one-shot task (manual cleanup helper). */
export async function deleteTask(taskName) {
  if (process.platform !== 'win32') return false
  await runSchtasks(['/Delete', '/TN', taskName, '/F'])
  return true
}

/* ─────────────────────────────── reading ─────────────────────────────── */

/** Last N log lines; empty when the file does not exist yet. */
export function readLogTail(logPath, lines = 40) {
  if (!existsSync(logPath)) return []
  try {
    return readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/).slice(-lines)
  } catch {
    return []
  }
}

/** Summary for `restart_status`. */
export function environmentReport(options) {
  const lock = readLock(options.lockPath, options.lockStaleMs)
  return {
    platform: process.platform,
    exePath: options.exePath,
    exeExists: options.exePath !== '' && existsSync(options.exePath),
    processName: options.processName,
    scriptPath: options.scriptPath,
    scriptExists: existsSync(options.scriptPath),
    commandPath: options.commandPath,
    commandExists: existsSync(options.commandPath),
    pendingDir: options.pendingDir,
    logPath: options.logPath,
    taskName: options.taskName,
    cookieProbePath: options.cookieProbePath,
    cookieProbeExists: existsSync(options.cookieProbePath),
    cookieDbPath: options.cookieDbPath,
    cookieDbExists: options.cookieDbPath !== '' && existsSync(options.cookieDbPath),
    lock,
    lockPath: options.lockPath,
  }
}
