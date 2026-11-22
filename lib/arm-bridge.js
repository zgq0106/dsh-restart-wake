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
 * 给 arm.json 打「主动重启」标记。
 * 未武装（没有 arm.json）时什么也不做——那是常态，不是错误。
 *
 * @returns {{armed:boolean, marked:boolean, path:string, previous?:boolean, error?:string}}
 */
export function markGracefulExit(options = {}) {
  const file = path.join(resolveOwnshieldStateDir(options), 'arm.json')
  const read = readJson(file)
  if (!read.exists) return { armed: false, marked: false, path: file }
  if (!read.value || typeof read.value !== 'object') {
    return { armed: true, marked: false, path: file, error: 'arm.json 无法解析（可能写了一半），未改动' }
  }
  const previous = read.value.expectGracefulExit === true
  try {
    writeJsonAtomic(file, { ...read.value, expectGracefulExit: true })
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
  if (marked.previous === true) payload.expectGracefulExit = true
  else delete payload.expectGracefulExit
  try {
    writeJsonAtomic(marked.path, payload)
  } catch {
    /* 尽力而为：残留标记只会让下一次重启不自动救，不会造成破坏 */
  }
}

/** 供 restart_status 展示：当前是否武装、tag 与 armedAt（只读）。 */
export function readArmState(options = {}) {
  const file = path.join(resolveOwnshieldStateDir(options), 'arm.json')
  const read = readJson(file)
  if (!read.exists) return { armed: false, path: file, tag: '', armedAt: '', expectGracefulExit: false }
  const value = read.value && typeof read.value === 'object' ? read.value : {}
  return {
    armed: read.value !== null,
    path: file,
    tag: typeof value.tag === 'string' ? value.tag : '',
    armedAt: typeof value.armedAt === 'string' ? value.armedAt : '',
    expectGracefulExit: value.expectGracefulExit === true,
  }
}
