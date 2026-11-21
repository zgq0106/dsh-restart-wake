/**
 * Small filesystem/error helpers shared by the probe.
 *
 * No third-party dependencies: the whole plugin runs on Node built-ins so a
 * profile install needs no build step.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stable, filesystem-safe rendering of an ISO timestamp. */
export function safeTimestamp(iso = new Date().toISOString()) {
  return String(iso).replace(/[:.]/g, '-')
}

export function ensureDir(dir) {
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Write JSON through a temporary sibling and rename it into place, so a reader
 * never sees a half-written probe file.
 */
export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath)
  ensureDir(dir)
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temp, filePath)
  } catch (error) {
    // Windows can refuse to replace an existing file; the retry is still atomic
    // enough for a single-writer artifact directory.
    try {
      rmSync(filePath, { force: true })
      renameSync(temp, filePath)
    } catch {
      try {
        rmSync(temp, { force: true })
      } catch {
        /* best effort */
      }
      throw error
    }
  }
}

export function errorText(error) {
  if (error === undefined || error === null) return 'unknown error'
  const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${code}${message}`
}

export function clip(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * Bound a promise that has no cancellation parameter of its own. The underlying
 * operation may finish later; the probe only stops waiting.
 */
export async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
        timer?.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
