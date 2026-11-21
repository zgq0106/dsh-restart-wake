/**
 * Resolve plugin options (self-healing half, moved from `dsh-ownshield`).
 *
 * 2.0 合并：导出名改为 `resolveOwnshieldConfig` / `OWNSHIELD_DEFAULTS`，
 * 与 `lib/config.js`（重启侧）、`lib/config-inject.js`（回注侧）区分。
 *
 * Every field is optional. Defaults match a stock DSH Desktop install:
 *   - probe artifacts live in `~/.dsh/ownshield`,
 *   - the expected tool list is `tool-baseline.json` next to them,
 *   - the fixed resume session is remembered in `probe-session.json`.
 *
 * `override` is the Loader row's `config` object.
 */

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export const OWNSHIELD_DEFAULTS = {
  /** One short message sent to the temporary session. */
  probeMessage: 'probe',
  /** How long to wait for session creation and for the first turn to settle. */
  probeTimeoutMs: 60000,
  /** Poll interval while waiting for the first turn. */
  probePollMs: 500,
  /** How long to wait for the fixed probe session's resume. */
  resumeTimeoutMs: 30000,
  /** Time zone attached to the probe prompt. */
  timeZone: 'Asia/Shanghai',
  /**
   * Where the recovery-chain scripts live. Empty means "derive from the
   * package": `<pluginDir>/scripts/ownshield`. A development checkout can point
   * this at `<repo>/tools/ownshield` instead.
   */
  scriptsDir: '',
  /** Register the built-in protocol prompt for every Agent in this profile. */
  promptEnabled: true,
  /** Windows Task Scheduler task that runs the watchdog once a minute. */
  watchTaskName: 'ownshield-watch',
  /**
   * Node executable used inside the generated Task Scheduler launcher.
   * Empty means "let arm.mjs probe at arm time" (OWNSHIELD_NODE / DSH_NODE /
   * NODE_EXE / `where node` / common install locations).
   */
  nodePath: '',
}

function pickString(given, key, fallback) {
  const value = given?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function pickNumber(given, key, fallback, min, max) {
  const value = Number(given?.[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Where the recovery-chain scripts live.
 *
 * Priority:
 *   1. `config.scriptsDir` (explicit install location);
 *   2. `<pluginDir>/scripts/ownshield` — what a published package ships;
 *   3. `<pluginDir>/../../tools/ownshield` — a development checkout where the
 *      plugin package sits next to `tools/` in the same repo.
 *
 * Step 3 exists because a checkout installs the package by link/junction, and
 * `import.meta.url` then resolves inside `node_modules`: deriving the repo root
 * from the script path would point at the package, not the workspace. Shipping
 * packages never hit it (step 2 wins).
 */
function resolveScriptsDir(given, pluginDir) {
  const explicit = pickString(given, 'scriptsDir', '')
  if (explicit !== '') return explicit
  const packed = path.join(pluginDir, 'scripts', 'ownshield')
  if (existsSync(path.join(packed, 'arm.mjs'))) return packed
  const devLayout = path.resolve(pluginDir, '..', 'tools', 'ownshield')
  if (existsSync(path.join(devLayout, 'arm.mjs'))) return devLayout
  return packed
}

/**
 * @param {string} pluginDir Absolute package directory.
 * @param {Record<string, unknown>} [override] Loader row config.
 */
export function resolveOwnshieldConfig(pluginDir, override = {}) {
  const given = override && typeof override === 'object' ? override : {}
  const ownshieldDir = pickString(given, 'ownshieldDir', path.join(homedir(), '.dsh', 'ownshield'))
  const scriptsDir = resolveScriptsDir(given, pluginDir)

  return {
    ...OWNSHIELD_DEFAULTS,
    ...given,
    pluginDir,
    ownshieldDir,
    /** Expected tool names: a string array or `{ "tools": [...] }`. Missing means skip. */
    baselinePath: pickString(given, 'baselinePath', path.join(ownshieldDir, 'tool-baseline.json')),
    /**
     * Expected service keys, for plugins that register services instead of tools.
     * A string array or `{ "services": [...] }`. Missing means skip.
     */
    serviceBaselinePath: pickString(
      given,
      'serviceBaselinePath',
      path.join(ownshieldDir, 'service-baseline.json'),
    ),
    /**
     * Plugin heartbeats, for plugins that register neither tools nor services.
     * A heartbeat written by another process id means the plugin did not mount
     * during this boot.
     */
    heartbeatDir: pickString(given, 'heartbeatDir', path.join(ownshieldDir, 'plugins')),
    /** Remembers the fixed old session used by the resume probe. */
    probeSessionPath: pickString(given, 'probeSessionPath', path.join(ownshieldDir, 'probe-session.json')),
    /** Base directory for the temporary session cwd. */
    tmpBase: pickString(given, 'tmpBase', tmpdir()),
    /** Empty config value falls back to `<pluginDir>/scripts/ownshield`. */
    scriptsDir,
    snapshotScriptPath: path.join(scriptsDir, 'snapshot.mjs'),
    armScriptPath: path.join(scriptsDir, 'arm.mjs'),
    watchScriptPath: path.join(scriptsDir, 'watch.mjs'),
    /** Built-in protocol prompt; false keeps the tools but skips the section. */
    promptEnabled: given.promptEnabled !== false,
    /** Task Scheduler name used by arm.mjs and the tools. */
    watchTaskName: pickString(given, 'watchTaskName', OWNSHIELD_DEFAULTS.watchTaskName),
    /** Explicit node.exe for the generated launcher; empty = probe at arm time. */
    nodePath: pickString(given, 'nodePath', OWNSHIELD_DEFAULTS.nodePath),
    probeMessage: pickString(given, 'probeMessage', OWNSHIELD_DEFAULTS.probeMessage),
    probeTimeoutMs: pickNumber(given, 'probeTimeoutMs', OWNSHIELD_DEFAULTS.probeTimeoutMs, 100, 300000),
    probePollMs: pickNumber(given, 'probePollMs', OWNSHIELD_DEFAULTS.probePollMs, 10, 10000),
    resumeTimeoutMs: pickNumber(given, 'resumeTimeoutMs', OWNSHIELD_DEFAULTS.resumeTimeoutMs, 100, 300000),
    timeZone: pickString(given, 'timeZone', OWNSHIELD_DEFAULTS.timeZone),
  }
}
