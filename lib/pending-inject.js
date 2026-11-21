/**
 * Pending 文件层。
 *
 * 本文件是 dsh-restart-wake 0.1.6 `lib/pending.js` 的**适配副本**（不是重写）：
 * 同一份磁盘格式、同一套「读 → 去重 → 移动归档」语义。改动只有三处：
 *   1. 同时接受 wake 风格（`wake-pending-<sessionId>.json`）与 ownshield 单文件
 *      风格（`inject-pending.json` / `inject-pending-<sessionId>.json`）；
 *   2. 记录体允许 ownshield 的富字段（level / errorTail / snapshotTag / recovered…），
 *      不再强制要求 `prompt` 字符串；
 *   3. 处理成功/失败后**移动到** `inject-done/` / `inject-failed/`，绝不 rm
 *      （restart-wake 成功时直接丢弃，本插件按 ownshield 硬约束改为移动）。
 *
 * wake 风格的记录体保持逐字兼容：
 *   { "sessionId": "...", "prompt": "...", "createdAt": "ISO" }
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
import { basename, join } from 'node:path'

/**
 * `wake-pending*.json` 与 `inject-pending*.json`，排除旧版本留下的归档名。
 */
export const PENDING_PATTERN =
  /^(?:wake|inject)-pending(?!-(done|failed|expired|duplicate)).*\.json$/i

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** Session id 是 UUID 形状；仍做白名单替换，调用方无法逃出目录。 */
export function pendingFileName(sessionId) {
  return `wake-pending-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '')
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** `createdAt` / `ts` 允许 ISO、epoch 毫秒数字或数字字符串；认不出就返回 undefined。 */
export function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) return new Date(numeric).toISOString()
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** errorTail 允许数组或字符串；统一成行数组（保留顺序）。 */
export function normalizeErrorTail(value) {
  if (Array.isArray(value)) return value.map((line) => String(line))
  if (typeof value !== 'string') return []
  return value.split(/\r?\n/)
}

/**
 * 读一条 pending；畸形内容抛错，调用方据此把它移进 inject-failed/。
 *
 * 与 restart-wake 一样容忍 UTF-8 BOM（PowerShell 5.1 的 Set-Content 会加）。
 * @param {string} file
 */
export function readTask(file) {
  const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pending file must hold a JSON object')
  }
  const sessionId = firstString(parsed.sessionId, parsed.targetSessionId, parsed.session)
  if (!sessionId) throw new Error('pending file missing session id (sessionId/targetSessionId)')
  const createdAt = normalizeTimestamp(parsed.createdAt ?? parsed.ts)
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : undefined
  return {
    ...parsed,
    sessionId,
    createdAt,
    prompt,
    level: firstString(parsed.level, parsed.stageLevel, parsed.grade),
    phase: firstString(parsed.phase, parsed.stage, parsed.errorPhase),
    source: firstString(parsed.source, parsed.errorSource),
    snapshotTag: firstString(parsed.snapshotTag, parsed.snapshot, parsed.tag),
    errorTail: normalizeErrorTail(parsed.errorTail ?? parsed.error ?? parsed.detail),
  }
}

/** 目录里所有待投递条目，按文件名排序（保证顺序稳定）。 */
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
        return {
          file,
          task: undefined,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
}

/** 该会话是否已有待投递条目（供生产者去重）。 */
export function hasPending(dir, sessionId) {
  return existsSync(join(dir, pendingFileName(sessionId)))
}

/**
 * 把处理过的条目移动到 done/failed 子目录；同名时追加序号，绝不覆盖、不删除。
 * @returns {string|undefined} 目标路径，移动失败时 undefined。
 */
export function moveTo(targetDir, file, now = new Date()) {
  try {
    ensureDir(targetDir)
    const name = basename(file)
    let target = join(targetDir, name)
    if (existsSync(target)) {
      const dot = name.toLowerCase().endsWith('.json') ? name.length - 5 : name.length
      const core = name.slice(0, dot)
      const ext = name.slice(dot)
      const suffix = now.toISOString().replace(/[:.]/g, '-')
      target = join(targetDir, `${core}-${suffix}${ext}`)
      for (let ordinal = 1; existsSync(target) && ordinal < 100; ordinal += 1) {
        target = join(targetDir, `${core}-${suffix}-${ordinal}${ext}`)
      }
    }
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}

/** 显式取消一条待投递（工具/人手动清理时用；正常投递只 moveTo）。 */
export function removePending(dir, sessionId) {
  const file = join(dir, pendingFileName(sessionId))
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** 没有可解析的时间戳时照常投递，绝不静默丢弃。 */
export function isExpired(task, maxAgeMs, now = Date.now()) {
  const createdAt = Date.parse(task?.createdAt ?? '')
  return Number.isFinite(createdAt) && now - createdAt > maxAgeMs
}

/** 按 wake 格式写一条（测试与其它工具复用；生产者一般直接写 inject-pending.json）。 */
export function writeWakePending(dir, sessionId, prompt, now = new Date()) {
  ensureDir(dir)
  const file = join(dir, pendingFileName(sessionId))
  const body = { sessionId: String(sessionId), prompt: String(prompt), createdAt: now.toISOString() }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 写 ownshield 单文件 pending（任务规定的格式）。
 * `ts` 缺省补当前 ISO；其余字段原样保留，交给 message.js 组装。
 */
export function writeInjectPending(dir, task, now = new Date()) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('inject pending 必须是 JSON 对象')
  }
  ensureDir(dir)
  const body = {
    ...task,
    ts: task.ts ?? now.toISOString(),
  }
  const file = join(dir, 'inject-pending.json')
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}
