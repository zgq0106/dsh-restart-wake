/**
 * 重启侧 ↔ 自愈侧的状态桥（2.0 合包后新增）。
 *
 * 只做一件事：**主动重启前，先告诉武装中的看门狗「这次退出是预期的」**。
 *
 * 为什么必须告诉：看门狗判 process-gone 只有一条自证路径——拿到退出码 0
 * （`classifyExit` 默认 mode=exit-code）。而重启脚本是杀进程，拿不到退出码。
 * 于是「旧进程已死、新进程未起」那十几秒里跑的那一轮，会把主动重启判成崩溃 →
 * 触发回滚 → 顺手把武装态吃掉。恰好发生在我们最需要它安静的时候。
 *
 * 语义与 `arm.mjs` / `arm.json` 的 `expectGracefulExit` 完全一致：
 * 置 true 后，看门狗看到进程消失会走 graceful-exit 分支（不拉起、直接撤防）；
 * 撤防会把 arm.json 移进 disarm/，标记随之消失，不需要另一套清理。
 *
 * 失败一律不阻断重启：拿不到保护只是回到合并前的行为，不该让重启卡住。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 状态目录：插件配置 > OWNSHIELD_DIR > OWNSHIELD_STATE_DIR > `~/.dsh/ownshield`。 */
export function resolveOwnshieldStateDir(options = {}) {
  const explicit = typeof options.ownshieldDir === 'string' ? options.ownshieldDir.trim() : ''
  if (explicit !== '') return explicit
  const fromEnv = String(process.env.OWNSHIELD_DIR || '').trim()
  if (fromEnv !== '') return fromEnv
  const fromLegacy = String(process.env.OWNSHIELD_STATE_DIR || '').trim()
  if (fromLegacy !== '') return fromLegacy
  return path.join(homedir(), '.dsh', 'ownshield')
}

function readJson(file) {
  try {
    if (!existsSync(file)) return { exists: false, value: null }
    const raw = String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')
    return { exists: true, value: JSON.parse(raw) }
  } catch {
    return { exists: true, value: null }
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 标记有效期：只认「刚刚那次主动重启」。
 *
 * 2026-11-22 真机教训：`restart_now` 打了标记，但看门狗那一轮跑的时候新进程已经起来，
 * `resolveBoot` 重建 boot、判 `signals=none`，既没走 graceful-exit，也没撤防——
 * 标记就永久留在 arm.json 里。之后**真崩溃**会被当成正常退出而不救，比不打标记更危险。
 * 所以标记必须自己会过期：超过这个窗口就按普通「进程消失」处理。
 */
export const GRACEFUL_MARK_TTL_MS = 10 * 60 * 1000

/**
 * 标记此刻还算不算数。没写时间戳的一律不认——
 * 人工声明「正常退出」请用 `autoGracefulExit: "no-crash-evidence"`，
 * 那是长期声明；`expectGracefulExit` 只为一次主动重启服务。
 */
export function gracefulMarkValid(arm, now = Date.now()) {
  if (!arm || typeof arm !== 'object' || arm.expectGracefulExit !== true) return false
  const raw = arm.expectGracefulExitAt
  if (typeof raw !== 'string' || raw.trim() === '') return false
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return false
  return now - at <= GRACEFUL_MARK_TTL_MS
}

/**
 * 给 arm.json 打「主动重启」标记。
 * 未武装（没有 arm.json）时什么也不做——那是常态，不是错误。
 *
 * @returns {{armed:boolean, marked:boolean, path:string, previous?:boolean, error?:string}}
 */
export function markGracefulExit(options = {}, now = Date.now()) {
  const file = path.join(resolveOwnshieldStateDir(options), 'arm.json')
  const read = readJson(file)
  if (!read.exists) return { armed: false, marked: false, path: file }
  if (!read.value || typeof read.value !== 'object') {
    return { armed: true, marked: false, path: file, error: 'arm.json 无法解析（可能写了一半），未改动' }
  }
  const previous = read.value.expectGracefulExit === true
  try {
    writeJsonAtomic(file, {
      ...read.value,
      expectGracefulExit: true,
      expectGracefulExitAt: new Date(now).toISOString(),
    })
    return { armed: true, marked: true, path: file, previous }
  } catch (error) {
    return { armed: true, marked: false, path: file, error: error?.message ?? String(error) }
  }
}

/**
 * 调度失败时回滚标记。
 * 不清掉的话，下一次**真崩溃**会被当成正常退出而不救——比不打标记更糟。
 */
export function unmarkGracefulExit(marked) {
  if (!marked || marked.marked !== true) return
  const read = readJson(marked.path)
  if (!read.exists || !read.value || typeof read.value !== 'object') return
  const payload = { ...read.value }
  if (marked.previous === true) {
    payload.expectGracefulExit = true
  } else {
    delete payload.expectGracefulExit
    delete payload.expectGracefulExitAt
  }
  try {
    writeJsonAtomic(marked.path, payload)
  } catch {
    /* 尽力而为：残留标记只会让下一次重启不自动救，不会造成破坏 */
  }
}

/** 供 restart_status 展示：当前是否武装、tag、armedAt 与标记是否仍有效（只读）。 */
export function readArmState(options = {}, now = Date.now()) {
  const file = path.join(resolveOwnshieldStateDir(options), 'arm.json')
  const read = readJson(file)
  if (!read.exists) {
    return { armed: false, path: file, tag: '', armedAt: '', expectGracefulExit: false, markValid: false }
  }
  const value = read.value && typeof read.value === 'object' ? read.value : {}
  return {
    armed: read.value !== null,
    path: file,
    tag: typeof value.tag === 'string' ? value.tag : '',
    armedAt: typeof value.armedAt === 'string' ? value.armedAt : '',
    expectGracefulExit: value.expectGracefulExit === true,
    markValid: gracefulMarkValid(value, now),
  }
}
