/**
 * Resolve the plugin options.
 *
 * Every field is optional. The defaults aim at a stock DeepSeek Harness Desktop
 * install on Windows:
 *   - the executable is discovered from the running Electron process,
 *   - the wake registry lives in `~/.dsh/restart-wake`,
 *   - the restart scripts ship inside this package.
 *
 * `override` is the Loader row's `config` object, so users can move the registry
 * next to their own tools folder or point at a portable install.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_PROCESS_NAME = 'DeepSeek Harness'

export const DEFAULTS = {
  /** Process name used for kill + "is it running" checks (no .exe suffix). */
  processName: DEFAULT_PROCESS_NAME,
  /** One-shot Task Scheduler task name. */
  taskName: 'DshRestartWake',
  /** Seconds between scheduling and the actual kill: lets the reply go out first. */
  delaySeconds: 12,
  /** Seconds to wait after launching before counting processes. */
  launchWaitSeconds: 8,
  /** Launch attempts before reporting FAILED. */
  maxLaunchAttempts: 3,
  /** Seconds to wait after a graceful close request. */
  graceSeconds: 8,
  /** Seconds to wait for every process to disappear after the force kill. */
  killTimeoutSeconds: 20,
  /** Seconds to wait for the Electron single-instance lock to be released. */
  singleInstanceWaitSeconds: 3,
  /** Wake entries older than this are archived as expired instead of delivered. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** Delay before the first wake scan after Host startup. */
  startupDelayMs: 3000,
  /** How long to wait for `sessionController` to become available. */
  readyTimeoutMs: 60000,
  /**
   * How long to wait for the Agent-preset registry before delivering.
   *
   * A cold resume composes its Agent from `agentPresets`; if the registry is
   * still loading, the session mounts with no preset at all and loses every
   * preset-provided tool (shell, files, memory). Measured on a 19-bundle
   * profile: 3 s was not enough.
   */
  presetsReadyTimeoutMs: 20000,
  /** Per-delivery timeout passed to the AbortSignal. */
  deliverTimeoutMs: 30000,
  /** Delivery attempts per wake entry. */
  maxAttempts: 3,
  /** Delay between delivery attempts. */
  retryDelayMs: 15000,
  /** A restart mutex older than this is considered abandoned. */
  lockStaleMs: 10 * 60 * 1000,
  /** Optional directory holding `crash-*-renderer.log`; empty disables the check. */
  crashLogDir: '',
  /**
   * `dsh-auth-*` cookie count at which the restart window purges them.
   * One entry is about 228 bytes of Cookie header; Node's limit is 16 KB, so
   * roughly 70 entries hit 431 Request Header Fields Too Large.
   */
  cookieThreshold: 50,
  /** Register the built-in protocol prompt for every Agent in this profile. */
  promptEnabled: true,
  /** Keep at most this many failure/expiry/duplicate archives; older ones are pruned. */
  keepArchives: 10,
  /** Rotate wake.log to wake.log.1 once it grows past this many bytes. */
  maxLogBytes: 256 * 1024,
  /** Time zone attached to every delivered prompt. */
  timeZone: 'Asia/Shanghai',
}

/**
 * Find the Harness executable.
 *
 * In Electron the Host runs inside the application process, so
 * `process.execPath` is usually the app executable itself. Node-spawned hosts
 * report a node binary instead, so the surrounding directories are probed for
 * `<processName>.exe` as a fallback.
 */
export function detectExecutable(processName = DEFAULT_PROCESS_NAME) {
  const candidates = []
  const execPath = typeof process.execPath === 'string' ? process.execPath : ''
  if (/\.exe$/i.test(execPath)) candidates.push(execPath)

  const anchors = []
  for (const value of [execPath, process.argv?.[0] ?? '', process.argv?.[1] ?? '']) {
    if (typeof value === 'string' && value !== '') anchors.push(path.dirname(value))
  }
  for (const dir of anchors) {
    if (dir === '.' || dir === path.sep) continue
    candidates.push(path.join(dir, `${processName}.exe`))
    candidates.push(path.join(dir, '..', `${processName}.exe`))
    candidates.push(path.join(dir, '..', '..', `${processName}.exe`))
  }

  return candidates.find((candidate) => candidate !== '' && existsSync(candidate)) ?? candidates[0] ?? ''
}

/**
 * Default Chromium cookie store of the Desktop app.
 *
 * The Desktop Host listens on a random port on every launch and mints one
 * `dsh-auth-<authority-hash>` cookie per port. Chromium never removes old
 * names, so they accumulate; at roughly 70 entries the Cookie request header
 * passes Node's 16 KB limit and every request gets 431, which the Electron
 * shell reports as "Web authentication failed". This file is held exclusively
 * while Harness runs, so the only readable/cleanable window is between the
 * browser process dying and the next instance starting -- exactly where the
 * restart script runs.
 */
export function detectCookieDbPath() {
  if (process.platform !== 'win32') return ''
  const appData = process.env.APPDATA
  if (!appData) return ''
  return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/**
 * @param {string} pluginDir Absolute package directory.
 * @param {Record<string, unknown>} [override] Loader row config.
 */
export function resolveConfig(pluginDir, override = {}) {
  const given = override && typeof override === 'object' ? override : {}
  const pickString = (key, fallback) => {
    const value = given[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  const pickNumber = (key, fallback) => {
    const value = Number(given[key])
    return Number.isFinite(value) ? value : fallback
  }

  const pendingDir = pickString('pendingDir', path.join(homedir(), '.dsh', 'restart-wake'))
  const exePath = pickString('exePath', '')
  const explicitProcessName = pickString('processName', '')
  const processName =
    explicitProcessName ||
    (exePath ? path.basename(exePath, path.extname(exePath)) : DEFAULT_PROCESS_NAME)

  return {
    ...DEFAULTS,
    ...(given ?? {}),
    pluginDir,
    pendingDir,
    logPath: pickString('logPath', path.join(pendingDir, 'wake.log')),
    lockPath: pickString('lockPath', path.join(pendingDir, 'restart.lock')),
    restartConfigPath: path.join(pendingDir, 'restart-config.json'),
    scriptPath: pickString('scriptPath', path.join(pluginDir, 'scripts', 'restart-dsh.ps1')),
    commandPath: pickString('commandPath', path.join(pluginDir, 'scripts', 'run-restart.cmd')),
    exePath: exePath || detectExecutable(processName),
    processName,
    taskName: pickString('taskName', DEFAULTS.taskName),
    cookieDbPath: pickString('cookieDbPath', detectCookieDbPath()),
    cookieProbePath: pickString('cookieProbePath', path.join(pluginDir, 'scripts', 'cookie-probe.mjs')),
    cookieCleanupPath: pickString(
      'cookieCleanupPath',
      path.join(pluginDir, 'scripts', 'cookie-cleanup.mjs'),
    ),
    cookieThreshold: pickNumber('cookieThreshold', DEFAULTS.cookieThreshold),
    promptEnabled: given.promptEnabled !== false,
    keepArchives: pickNumber('keepArchives', DEFAULTS.keepArchives),
    maxLogBytes: pickNumber('maxLogBytes', DEFAULTS.maxLogBytes),
    crashLogDir: pickString('crashLogDir', ''),
    delaySeconds: pickNumber('delaySeconds', DEFAULTS.delaySeconds),
    launchWaitSeconds: pickNumber('launchWaitSeconds', DEFAULTS.launchWaitSeconds),
    maxLaunchAttempts: pickNumber('maxLaunchAttempts', DEFAULTS.maxLaunchAttempts),
    graceSeconds: pickNumber('graceSeconds', DEFAULTS.graceSeconds),
    killTimeoutSeconds: pickNumber('killTimeoutSeconds', DEFAULTS.killTimeoutSeconds),
    singleInstanceWaitSeconds: pickNumber(
      'singleInstanceWaitSeconds',
      DEFAULTS.singleInstanceWaitSeconds,
    ),
    maxAgeMs: pickNumber('maxAgeMs', DEFAULTS.maxAgeMs),
    startupDelayMs: pickNumber('startupDelayMs', DEFAULTS.startupDelayMs),
    readyTimeoutMs: pickNumber('readyTimeoutMs', DEFAULTS.readyTimeoutMs),
    presetsReadyTimeoutMs: pickNumber('presetsReadyTimeoutMs', DEFAULTS.presetsReadyTimeoutMs),
    deliverTimeoutMs: pickNumber('deliverTimeoutMs', DEFAULTS.deliverTimeoutMs),
    maxAttempts: pickNumber('maxAttempts', DEFAULTS.maxAttempts),
    retryDelayMs: pickNumber('retryDelayMs', DEFAULTS.retryDelayMs),
    lockStaleMs: pickNumber('lockStaleMs', DEFAULTS.lockStaleMs),
    timeZone: pickString('timeZone', DEFAULTS.timeZone),
  }
}
