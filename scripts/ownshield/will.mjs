#!/usr/bin/env node
/**
 * ownshield · 遗嘱（will）—— M2
 *
 * 设计依据：docs/ownshield-还魂设计-2026-11-19.md §2.1
 * 每步结束把「目标 / 已完成（可验证）/ 下一步 / 工具集指纹 / 插件指纹」追加一行到
 *   <state-dir>/will/<sessionId>.jsonl        （默认 <state-dir> = ~/.dsh/ownshield）
 * 一行一 JSON。只写可验证的事实，写不出就写 unverified，绝不编：
 *   - done[i].path 必须给；文件存在 → 记录文件真实 sha256 的前 16 位；
 *   - 文件不存在/不可读 → sha256 = "unverified"，并带 exists:false；
 *   - 调用方自称的 sha256 与真实值不符 → 记 claimedSha256 + hashMatch:false，
 *     落盘的是真实值（伪造会在续跑消息里露出来）；
 *   - 拿不到工具清单/插件清单 → toolprint / pluginprint = "unverified"。
 *
 * 工具指纹来源（诚实优先，DSH 运行时的工具清单无法从盘上静态还原，所以不猜）：
 *   1. 调用方显式 { toolNames: [...] }（局内插件能拿到真实注册工具）；
 *   2. 或读 <state-dir>/tool-inventory.json（探针/插件落盘的工具清单）；
 *   3. 都没有 → "unverified"。
 * 插件指纹：调用方 { bundles: [...] }，或读 profile 的 package.json
 *   （dsh.profile.bundles + node_modules/<name>/package.json 的 version）。
 *   两项指纹都是「排序去重后按 \n 拼接 → sha256 → 前 12 位」。
 *
 * 滚动（不删、不截断）：单文件 ≥ 2000 行或首条 ts 超过 7 天 → 整文件 rename 到
 *   will/archive/<sessionId>-<UTC时间戳>.jsonl；下一条 seq 从归档末条继续。
 *
 * 崩溃容错：若上次崩溃把最后一行写成半截，追加前先补一个换行，半截行保留在文件里
 *   并被 readWillFile 计入 badLines；seq 从最后一条合法记录继续。
 *
 * 面板数据结构（M5 用，本文件只出结构不做 UI）：
 *   listWills() → { willDir, total, limit, items: [{
 *     sessionId, seq, turn, step, goal, next, toolprint, pluginprint,
 *     ts, doneCount, source: 'live'|'archive', file
 *   }] }，最近 20 条（limit 可调）。
 *
 * CLI：
 *   node will.mjs list [--state-dir <dir>] [--limit 20] [--json]
 *   node will.mjs last <sessionId> [--state-dir <dir>] [--json]
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WILL_DIRNAME = 'will'
export const ARCHIVE_DIRNAME = 'archive'
export const MAX_LINES = 2000
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const SHA_PREFIX = 16
export const PRINT_LEN = 12
export const GOAL_MAX = 120
export const UNVERIFIED = 'unverified'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PRINT_RE = /^[0-9a-f]{12}$/
// 一行遗嘱 JSON 最短也远大于 8 字节；文件小于 2000*8 字节时不可能有 2000 行，
// 这样可以免掉每步全量读盘数行。
const MIN_LINE_BYTES = 8
const TAIL_BYTES = 64 * 1024
const HEAD_BYTES = 16 * 1024
const CHUNK = 1024 * 1024

/** 默认状态目录：~/.dsh/ownshield（与 design §2.1 / 实施计划 §四 一致）。 */
export function defaultStateDir(home = os.homedir()) {
  return path.join(home, '.dsh', 'ownshield')
}

/** 允许 { stateDir } 直给，或 { home } 指到 ~/.dsh 的父目录。 */
export function resolveStateDir(options = {}) {
  if (options.stateDir) return path.resolve(options.stateDir)
  if (options.home) return path.join(path.resolve(options.home), '.dsh', 'ownshield')
  return defaultStateDir()
}

export function willDir(stateDir) {
  return path.join(resolveStateDir({ stateDir }), WILL_DIRNAME)
}

export function archiveDir(stateDir) {
  return path.join(willDir(stateDir), ARCHIVE_DIRNAME)
}

export function willFile(stateDir, sessionId) {
  assertSessionId(sessionId)
  return path.join(willDir(stateDir), `${sessionId}.jsonl`)
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`非法 sessionId（只允许字母数字开头、[A-Za-z0-9._-]，≤128 字符）：${JSON.stringify(sessionId)}`)
  }
  return sessionId
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 流式算文件 sha256（不把大文件整个读进内存）。 */
export function fileSha256(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let read
    while ((read = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) hash.update(buf.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** 校验一个路径：存在且是普通文件 → 真实 sha256 前 16 位；否则 unverified。 */
export function verifyPath(file) {
  const abs = path.resolve(file)
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return { path: abs, exists: false, reason: 'not-a-file' }
    return { path: abs, exists: true, bytes: st.size, sha256: fileSha256(abs).slice(0, SHA_PREFIX) }
  } catch (err) {
    return { path: abs, exists: false, reason: err.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

/**
 * done 归一化：每条必须有 path（字符串或 {tool, path, sha256?}）。
 * 永远以磁盘真实值为准；调用方自称的 sha256 只作对照记录，不采信。
 */
export function normalizeDone(done, options = {}) {
  if (done == null) return []
  if (!Array.isArray(done)) throw new Error('done 必须是数组（每条形如 {tool, path, sha256?}）')
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : process.cwd()
  return done.map((item, index) => {
    const raw = typeof item === 'string' ? { path: item } : item
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`done[${index}] 必须是 path 字符串或对象`)
    }
    const given = typeof raw.path === 'string' ? raw.path.trim() : ''
    if (!given) throw new Error(`done[${index}] 缺少 path：没有路径的「已完成」不可验证，不能写入遗嘱`)
    const abs = path.isAbsolute(given) ? path.normalize(given) : path.resolve(baseDir, given)
    const verified = verifyPath(abs)
    const entry = {
      path: abs,
      sha256: verified.exists ? verified.sha256 : UNVERIFIED,
      exists: verified.exists,
    }
    if (typeof raw.tool === 'string' && raw.tool.trim()) entry.tool = raw.tool.trim()
    if (typeof raw.sha256 === 'string' && raw.sha256.trim() && raw.sha256.trim().toLowerCase() !== UNVERIFIED) {
      const claimed = raw.sha256.trim().toLowerCase()
      const actual = verified.exists ? verified.sha256 : UNVERIFIED
      if (!verified.exists || claimed.slice(0, SHA_PREFIX) !== actual) {
        entry.claimedSha256 = raw.sha256.trim()
        entry.hashMatch = false
      }
    }
    return entry
  })
}

export function normalizeGoal(text) {
  const s = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''
  if (!s) throw new Error('goal 不能为空：遗嘱必须能回答「中断时我们在做什么」')
  return s.length > GOAL_MAX ? `${s.slice(0, GOAL_MAX - 1)}…` : s
}

function assertCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数（拿不到就写 0，不要编）`)
  }
  return value
}

/** 排序去重后按 \n 拼接，取 sha256 前 12 位。显式数组（含空数组）总是算出确定性值。 */
export function fingerprintNames(names) {
  const list = [...new Set((names ?? []).map((n) => String(n).trim()).filter(Boolean))].sort()
  return sha256Hex(list.join('\n')).slice(0, PRINT_LEN)
}

/** 解析并校验一个 12 位指纹；unverified 原样保留。 */
export function normalizePrint(value, label = 'fingerprint') {
  if (value == null || value === '') return UNVERIFIED
  const v = String(value).trim().toLowerCase()
  if (v === UNVERIFIED) return UNVERIFIED
  if (!PRINT_RE.test(v)) throw new Error(`${label} 必须是 12 位小写 hex 或 "unverified"：${value}`)
  return v
}

export function toolInventoryPath(stateDir) {
  return path.join(resolveStateDir({ stateDir }), 'tool-inventory.json')
}

/** 读 <state-dir>/tool-inventory.json；支持数组 / {tools|names|toolNames}。读不到返回 null。 */
export function readToolInventory(stateDir) {
  const file = toolInventoryPath(stateDir)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.tools)
      ? parsed.tools
      : Array.isArray(parsed?.names)
        ? parsed.names
        : Array.isArray(parsed?.toolNames)
          ? parsed.toolNames
          : null
  if (!list) return null
  const names = list
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim())
  if (!names.length) return null
  return { file, names }
}

function resolveBundleVersion(profileDir, name, depSpec) {
  const pkgPath = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  try {
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
    if (typeof version === 'string' && version.trim()) return version.trim()
  } catch {
    /* 链接插件读不到时退回声明的依赖版本 */
  }
  if (typeof depSpec === 'string' && /^\d/.test(depSpec.trim())) return depSpec.trim()
  return ''
}

/**
 * 读 profile 的已挂载 bundle 名+版本：dsh.profile.bundles 里每个名字，
 * 版本取 node_modules/<name>/package.json（本地链接插件也能读到），
 * 读不到再退回 package.json dependencies 的精确版本，否则 unknown。
 * 返回形如 ['@deepseek-ai/dsh-base@0.2.2-alpha.3', ...]；读不到返回 null。
 */
export function readProfileBundles(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  } catch {
    return null
  }
  const declared = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(declared)) return null
  const deps = pkg?.dependencies ?? {}
  const specs = declared
    .map((entry) => {
      const raw = String(entry).trim()
      if (!raw) return null
      let name = raw
      let version = ''
      const at = raw.lastIndexOf('@')
      if (at > 0) {
        name = raw.slice(0, at)
        version = raw.slice(at + 1)
      }
      if (!version) version = resolveBundleVersion(profileDir, name, deps[name])
      return `${name}@${version || 'unknown'}`
    })
    .filter(Boolean)
  return specs.length ? specs : null
}

/** 工具指纹：toolNames 数组 > 显式 toolprint > tool-inventory.json > unverified。 */
export function resolveToolprint(options = {}) {
  if (options.toolNames !== undefined) {
    if (!Array.isArray(options.toolNames) || options.toolNames.length === 0) {
      throw new Error('toolNames 必须是非空数组：拿不到清单就别传，不要用空数组冒充已采集')
    }
    return { value: fingerprintNames(options.toolNames), source: 'toolNames' }
  }
  if (options.toolprint != null) {
    return { value: normalizePrint(options.toolprint, 'toolprint'), source: 'explicit' }
  }
  const inventory = options.stateDir ? readToolInventory(options.stateDir) : null
  if (inventory) return { value: fingerprintNames(inventory.names), source: inventory.file }
  return { value: UNVERIFIED, source: null }
}

/** 插件指纹：bundles 数组 > 显式 pluginprint > profile package.json > unverified。 */
export function resolvePluginprint(options = {}) {
  if (options.bundles !== undefined) {
    if (!Array.isArray(options.bundles) || options.bundles.length === 0) {
      throw new Error('bundles 必须是非空数组：拿不到就别传，不要用空数组冒充已采集')
    }
    const specs = options.bundles
      .filter(Boolean)
      .map((b) => (typeof b === 'string' ? b : `${b?.name ?? ''}@${b?.version ?? 'unknown'}`))
      .filter((s) => s.trim())
    return { value: fingerprintNames(specs), source: 'bundles' }
  }
  if (options.pluginprint != null) {
    return { value: normalizePrint(options.pluginprint, 'pluginprint'), source: 'explicit' }
  }
  if (options.profileDir) {
    const specs = readProfileBundles(options.profileDir)
    if (specs) return { value: fingerprintNames(specs), source: path.join(options.profileDir, 'package.json') }
  }
  return { value: UNVERIFIED, source: null }
}

function readHeadText(file, bytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function readTailText(file, bytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    const start = Math.max(0, size - bytes)
    const buf = Buffer.allocUnsafe(size - start)
    const read = fs.readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** 最后一条合法 JSON 记录；半截行（崩溃残留）直接跳过，不抛。 */
export function readLastEntry(file, tailBytes = TAIL_BYTES) {
  let text
  try {
    text = readTailText(file, tailBytes)
  } catch {
    return null
  }
  if (!text) return null
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      /* 崩溃可能留下半行，继续往前找 */
    }
  }
  return null
}

function readFirstTs(file) {
  try {
    const head = readHeadText(file, HEAD_BYTES)
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (typeof value?.ts === 'string') return value.ts
      } catch {
        /* 首行损坏时退化为 mtime 判断 */
      }
      break
    }
  } catch {
    /* 读不到就按 mtime */
  }
  return null
}

export function countLines(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(64 * 1024)
  let lines = 0
  let lastByte = 0x0a
  try {
    let read
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i += 1) if (buf[i] === 0x0a) lines += 1
      lastByte = buf[read - 1]
    }
  } finally {
    fs.closeSync(fd)
  }
  if (lastByte !== 0x0a) lines += 1
  return lines
}

export function inspectWillFile(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return { file, exists: false, bytes: 0, mtimeMs: 0, firstTs: null, lastEntry: null, lastSeq: 0 }
  }
  if (!st.isFile()) return { file, exists: false, bytes: 0, mtimeMs: st.mtimeMs, firstTs: null, lastEntry: null, lastSeq: 0 }
  const lastEntry = readLastEntry(file)
  return {
    file,
    exists: true,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    firstTs: readFirstTs(file),
    lastEntry,
    lastSeq: typeof lastEntry?.seq === 'number' ? lastEntry.seq : 0,
  }
}

/** 判定是否该归档：≥ maxLines 行，或首条 ts 早于 now-maxAgeMs。 */
export function shouldArchive(info, nowMs = Date.now(), options = {}) {
  const maxLines = options.maxLines ?? MAX_LINES
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS
  if (!info?.exists) return null
  if (info.bytes >= maxLines * MIN_LINE_BYTES) {
    const lines = countLines(info.file)
    if (lines >= maxLines) return { reason: 'lines', lines }
  }
  if (info.firstTs) {
    const first = Date.parse(info.firstTs)
    if (Number.isFinite(first) && nowMs - first > maxAgeMs) return { reason: 'age', ageMs: nowMs - first }
  } else if (info.mtimeMs && nowMs - info.mtimeMs > maxAgeMs) {
    return { reason: 'age', ageMs: nowMs - info.mtimeMs }
  }
  return null
}

export function stamp(date = new Date()) {
  const d = new Date(date)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function uniqueArchiveName(dir, sessionId, now) {
  const base = `${sessionId}-${stamp(now)}`
  let candidate = `${base}.jsonl`
  let i = 2
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${i}.jsonl`
    i += 1
  }
  return candidate
}

/** 归档一个 will 文件（rename，不删除）；未触发时返回 null。 */
export function archiveWillFile(stateDir, sessionId, options = {}) {
  assertSessionId(sessionId)
  const dir = resolveStateDir({ stateDir })
  const file = willFile(dir, sessionId)
  const now = options.now ? new Date(options.now) : new Date()
  const info = inspectWillFile(file)
  const why = shouldArchive(info, now.getTime(), options)
  if (!why) return null
  const target = path.join(archiveDir(dir), uniqueArchiveName(archiveDir(dir), sessionId, now))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(file, target)
  return {
    file: target,
    reason: why.reason,
    lines: why.lines,
    ageMs: why.ageMs,
    maxSeq: info.lastSeq,
    archivedAt: now.toISOString(),
  }
}

function ensureTrailingNewline(file) {
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (!size) return
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    fs.readSync(fd, buf, 0, 1, size - 1)
    if (buf[0] !== 0x0a) fs.appendFileSync(file, '\n', 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 追加一条遗嘱。返回 { file, record, archived }。
 * entry: { turn, step, goal, done[], next, toolprint?, pluginprint? }
 * options: { stateDir, home, profileDir, toolNames, bundles, toolprint, pluginprint,
 *            now, maxLines, maxAgeMs, baseDir }
 */
export function appendWill(sessionId, entry = {}, options = {}) {
  assertSessionId(sessionId)
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry 必须是对象')
  const stateDir = resolveStateDir(options)
  const now = options.now ? new Date(options.now) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error('now 不是合法时间')
  const turn = assertCount(entry.turn, 'turn')
  const step = assertCount(entry.step, 'step')
  const goal = normalizeGoal(entry.goal)
  const next = typeof entry.next === 'string' ? entry.next.trim() : ''
  const done = normalizeDone(entry.done, options)

  // 先归档再写，保证最新一条永远在活跃文件里（续跑只需读活跃文件）。
  const archived = archiveWillFile(stateDir, sessionId, { now, maxLines: options.maxLines, maxAgeMs: options.maxAgeMs })
  const file = willFile(stateDir, sessionId)
  const previous = readLastEntry(file) ?? (archived ? readLastEntry(archived.file) : null)
  const seq = (typeof previous?.seq === 'number' ? previous.seq : 0) + 1

  const tool = resolveToolprint({ ...options, stateDir })
  const plugin = resolvePluginprint(options)
  const record = {
    seq,
    turn,
    step,
    goal,
    done,
    next,
    toolprint: tool.value,
    pluginprint: plugin.value,
    ts: now.toISOString(),
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  ensureTrailingNewline(file)
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  return { file, record, archived }
}

/** 读整个 will 文件；坏行（含崩溃半行）计入 badLines，不中断。 */
export function readWillFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, entries: [], badLines: 0, rawLines: 0 }
  }
  const entries = []
  let badLines = 0
  let rawLines = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    rawLines += 1
    try {
      const value = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object')
      entries.push(value)
    } catch {
      badLines += 1
    }
  }
  return { file, exists: true, entries, badLines, rawLines }
}

/** 某会话的归档文件，按 mtime 倒序（最新在前）。 */
export function listArchives(stateDir, sessionId) {
  const dir = archiveDir(stateDir)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const prefix = `${sessionId}-`
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl'))
    .map((n) => path.join(dir, n))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((x) => x.file)
}

/** 最后一条遗嘱：优先活跃文件，没有则回落到最新归档。 */
export function readLastWill(sessionId, options = {}) {
  assertSessionId(sessionId)
  const stateDir = resolveStateDir(options)
  const file = willFile(stateDir, sessionId)
  const live = readWillFile(file)
  if (live.entries.length) {
    return {
      sessionId,
      source: 'live',
      file,
      entry: live.entries[live.entries.length - 1],
      entries: live.entries.length,
      badLines: live.badLines,
    }
  }
  for (const archive of listArchives(stateDir, sessionId)) {
    const read = readWillFile(archive)
    if (read.entries.length) {
      return {
        sessionId,
        source: 'archive',
        file: archive,
        entry: read.entries[read.entries.length - 1],
        entries: read.entries.length,
        badLines: read.badLines,
      }
    }
  }
  return { sessionId, source: null, file, entry: null, entries: 0, badLines: live.badLines }
}

/** M5 面板用的摘要字段（顺序即展示顺序）。 */
export const WILL_LIST_FIELDS = Object.freeze([
  'sessionId',
  'seq',
  'turn',
  'step',
  'goal',
  'next',
  'toolprint',
  'pluginprint',
  'ts',
  'doneCount',
  'source',
  'file',
])

export function summarizeWill(entry, meta = {}) {
  return {
    sessionId: meta.sessionId ?? '',
    seq: entry.seq ?? null,
    turn: entry.turn ?? null,
    step: entry.step ?? null,
    goal: entry.goal ?? '',
    next: entry.next ?? '',
    toolprint: entry.toolprint ?? UNVERIFIED,
    pluginprint: entry.pluginprint ?? UNVERIFIED,
    ts: entry.ts ?? '',
    doneCount: Array.isArray(entry.done) ? entry.done.length : 0,
    source: meta.source ?? 'live',
    file: meta.file ?? '',
  }
}

function collectSessionIds(stateDir) {
  const ids = new Set()
  try {
    for (const name of fs.readdirSync(willDir(stateDir))) {
      if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length))
    }
  } catch {
    /* 目录还不存在 */
  }
  try {
    for (const name of fs.readdirSync(archiveDir(stateDir))) {
      const m = /^(.+)-(\d{8}T\d{6}Z)(?:-(\d+))?\.jsonl$/.exec(name)
      if (m) ids.add(m[1])
    }
  } catch {
    /* 还没有归档 */
  }
  return [...ids]
}

/**
 * 面板数据：最近 limit 条（默认 20）will 的摘要。每个会话取最后一条
 * （活跃文件优先，无活跃则取最新归档），按 ts 倒序。
 */
export function listWills(options = {}) {
  const stateDir = resolveStateDir(options)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 20
  const items = []
  for (const sessionId of collectSessionIds(stateDir)) {
    const liveFile = willFile(stateDir, sessionId)
    let entry = readLastEntry(liveFile)
    let source = 'live'
    let file = liveFile
    if (!entry) {
      for (const archive of listArchives(stateDir, sessionId)) {
        entry = readLastEntry(archive)
        if (entry) {
          source = 'archive'
          file = archive
          break
        }
      }
    }
    if (!entry) continue
    items.push(summarizeWill(entry, { sessionId, source, file }))
  }
  items.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
  return { willDir: willDir(stateDir), total: items.length, limit, items: items.slice(0, limit) }
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--state-dir') args.stateDir = argv[++i]
    else if (arg.startsWith('--state-dir=')) args.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length))
    else args._.push(arg)
  }
  return args
}

export const HELP = `ownshield will —— 遗嘱（意图快照）

node will.mjs list [--state-dir <dir>] [--limit 20] [--json]
    列出最近 20 条遗嘱摘要（M5 面板数据结构）
node will.mjs last <sessionId> [--state-dir <dir>] [--json]
    打印某会话最后一条遗嘱
`

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  try {
    if (command === 'list') {
      const result = listWills({ stateDir: args.stateDir, limit: args.limit })
      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`遗嘱目录  ${result.willDir}`)
        console.log(`会话 ${result.total} 个（列出最近 ${result.items.length} 条）`)
        for (const it of result.items) {
          console.log(`${it.ts}  ${it.sessionId}  seq=${it.seq}  turn=${it.turn}  step=${it.step}  done=${it.doneCount}  ${it.goal}`)
        }
      }
      return
    }
    if (command === 'last') {
      const sessionId = args._[0]
      if (!sessionId) {
        console.error('缺少 <sessionId>')
        process.exitCode = 2
        return
      }
      const found = readLastWill(sessionId, { stateDir: args.stateDir })
      if (!found.entry) {
        console.error(`没有找到 session ${sessionId} 的遗嘱`)
        process.exitCode = 1
        return
      }
      console.log(args.json ? JSON.stringify({ ...found }, null, 2) : JSON.stringify(found.entry, null, 2))
      return
    }
    console.log(HELP)
    if (!command) process.exitCode = 2
  } catch (err) {
    console.error(`失败：${err.message}`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
