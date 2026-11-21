/**
 * Find a real Node executable for running the recovery-chain scripts.
 *
 * The DSH desktop Host runs inside Electron, so `process.execPath` points at
 * `DeepSeek Harness.exe`, not node. Spawning a script with it only works with
 * `ELECTRON_RUN_AS_NODE=1`, so this module probes the usual candidates first
 * and uses that fallback last. A candidate only counts after it actually runs
 * JavaScript and writes a proof file: an Electron process can exit 0 without
 * executing anything.
 *
 * Order:
 *   1. `DSH_NODE` / `DSH_DESKTOP_NODE_EXECUTABLE`
 *   2. DSH-managed runtimes under `<dshHome>/dsh-runtimes/<runtime>/dependencies/node/bin`
 *   3. `node.exe` / `node` on PATH
 *   4. `<ProgramFiles>/nodejs/node.exe` (Windows) or Homebrew paths (macOS)
 *   5. `process.execPath` itself when this is a plain Node host
 *   6. Electron as Node: `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cache = new Map()

function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownshield-node-'))
    const proof = path.join(dir, 'proof')
    const result = spawnSync(
      file,
      ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof],
      { env, stdio: 'ignore', windowsHide: true, timeout: 15000 },
    )
    return !result.error && result.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch {
    return false
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* temp cleanup must never fail the resolution */
      }
    }
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ file: string, env: Record<string, string | undefined> }}
 */
export function resolveNodeRuntime(env = process.env) {
  const dshHome = String(env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  const cacheKey = `${dshHome}|${env.DSH_NODE || ''}|${env.PATH || ''}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const platform = process.platform
  const bin = platform === 'win32' ? 'node.exe' : 'node'
  const current = process.execPath
  const electron = Boolean(process.versions.electron)

  const candidates = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(os.homedir(), '.dsh', 'dsh-runtimes')])) {
    try {
      for (const entry of fs.readdirSync(root)) {
        candidates.push(path.join(root, entry, 'dependencies', 'node', 'bin', bin))
      }
    } catch {
      /* no managed runtime directory */
    }
  }
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH || '').split(separator)) {
    if (dir) candidates.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  }
  if (platform === 'win32' && env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'nodejs', bin))
  }
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  }
  if (!electron) candidates.push(current)

  for (const file of new Set(candidates.filter((value) => typeof value === 'string' && value !== ''))) {
    try {
      if (fs.statSync(file).isFile() && probeRuntime(file, env)) {
        const resolved = { file, env: { ...env } }
        cache.set(cacheKey, resolved)
        return resolved
      }
    } catch {
      /* try the next candidate */
    }
  }

  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probeRuntime(current, nodeEnv)) {
      const resolved = { file: current, env: nodeEnv }
      cache.set(cacheKey, resolved)
      return resolved
    }
  }

  throw new Error(
    'ownshield 找不到可执行脚本的 node 运行时。请设置环境变量 DSH_NODE 指向真实 node.exe，或在插件配置里设置 scriptsDir 对应的 Node 环境。',
  )
}
