/**
 * 探针换思路：不造流量，读真实工作痕迹。
 *
 * 模型在工作中每一次工具调用、每一轮 turn、每一次请求失败，DSH 都会派发会话事件
 * （`session/event`）。这些「纸条」比专门建一个 probe 会话更可信：
 *   - 测的是用户真实在用的预设与工具集（probe 会话用的是默认预设）；
 *   - 零额外会话、零额外 token、用户完全无感；
 *   - 有问题时不必等到下一个探针窗口，模型当场就在报错。
 *
 * 本模块只做采集：把最近窗口内的成功/失败落到 `activity.json`。
 * 判定由看门狗（watch.mjs）做，采集本身不判定、不注入、不阻塞主流程。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 只保留最近这么多条，文件不会随时间膨胀。 */
export const MAX_RECENT = 50

/** 默认观察窗口：10 分钟。 */
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000

/** 判定为「坏了」的最少连续失败条数。 */
export const DEFAULT_FAILURE_THRESHOLD = 3

export function activityPath(dir) {
  return path.join(dir, 'activity.json')
}

export function emptyActivity(now = Date.now()) {
  return { version: 1, updatedAt: new Date(now).toISOString(), recent: [] }
}

/** 工具结果是失败吗？结构可能变，宁可漏判也不误判。 */
export function toolResultFailed(data) {
  if (!data || typeof data !== 'object') return false
  if (data.ok === false || data.isError === true || data.error === true) return true
  const err = data.error ?? data.errorText ?? data.failure ?? data.errorMessage
  if (typeof err === 'string' && err.trim() !== '') return true
  if (err && typeof err === 'object') return true
  return false
}

/** 从一次事件里提炼「纸条」；不关心的类型返回 null。 */
export function classifyEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : ''
  if (type === 'tool/result') {
    return {
      kind: 'tool',
      ok: !toolResultFailed(event?.data),
      text: String(event?.data?.name ?? event?.data?.tool ?? ''),
    }
  }
  if (type === 'assistant/message') return { kind: 'turn', ok: true, text: '' }
  if (type === 'turn/end') {
    const reason = String(event?.data?.reason ?? '').toLowerCase()
    const bad = reason === 'error' || reason === 'aborted' || reason === 'failed'
    return { kind: 'turn', ok: !bad, text: reason }
  }
  return null
}

/** 追加一条记录，截断到 MAX_RECENT。返回新对象，不改入参。 */
export function recordActivity(state, entry, { now = Date.now() } = {}) {
  const base = state && Array.isArray(state.recent) ? state : emptyActivity(now)
  const rows = [...base.recent, { ...entry, at: new Date(now).toISOString() }]
  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    recent: rows.slice(-MAX_RECENT),
  }
}

/**
 * 纯函数判定：窗口内有没有成功、失败是不是已经成串。
 * @returns {{ verdict: 'alive'|'failing'|'idle', successes: number, failures: number, lastSuccessAt: string, lastErrorAt: string, lastErrorText: string }}
 */
export function summarizeActivity(
  state,
  { now = Date.now(), windowMs = DEFAULT_WINDOW_MS, failureThreshold = DEFAULT_FAILURE_THRESHOLD } = {},
) {
  const rows = (Array.isArray(state?.recent) ? state.recent : []).filter((row) => {
    const at = Date.parse(String(row?.at ?? ''))
    return Number.isFinite(at) && now - at <= windowMs
  })
  const successes = rows.filter((row) => row?.ok === true).length
  const failureRows = rows.filter((row) => row?.ok === false)
  const lastSuccess = [...rows].reverse().find((row) => row?.ok === true)
  const lastError = [...rows].reverse().find((row) => row?.ok === false)

  const common = {
    successes,
    failures: failureRows.length,
    lastSuccessAt: lastSuccess?.at ?? '',
    lastErrorAt: lastError?.at ?? '',
    lastErrorText: String(lastError?.text ?? ''),
  }

  // 窗口内有成功 = 模型确实在用且能用。单次工具报错不代表本体坏了。
  if (successes > 0) return { verdict: 'alive', ...common }
  // 全失败且成串：这才是「纸条在报警」。
  if (failureRows.length >= failureThreshold) return { verdict: 'failing', ...common }
  // 没流量（或零星失败，可能只是参数写错）：不下结论。
  return { verdict: 'idle', ...common }
}

export function readActivity(dir) {
  const file = activityPath(dir)
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

export function writeActivity(dir, state) {
  try {
    mkdirSync(dir, { recursive: true })
    const file = activityPath(dir)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 挂监听，采集真实事件。返回卸载函数；任何异常都吞掉，采集绝不能影响主流程。
 *
 * @param ctx Cordis 插件上下文
 * @param {{ dir: string }} options 状态目录
 * @param {{ now?: () => number, log?: (msg: string) => void, flushMs?: number }} [deps]
 */
export function startActivityWatch(ctx, options = {}, deps = {}) {
  const dir = options.dir
  if (!dir || typeof ctx?.on !== 'function') return () => {}

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const log = (message) => {
    try {
      if (typeof deps.log === 'function') deps.log(message)
      else ctx.logger?.info?.(`ownshield: ${message}`)
    } catch {
      /* 日志失败不影响采集 */
    }
  }

  let state = readActivity(dir) ?? emptyActivity(now())
  let dirty = false
  let timer = null

  const flush = () => {
    if (!dirty) return
    dirty = false
    if (!writeActivity(dir, state)) log('activity: 写入失败（下次事件再试）')
  }

  const push = (entry) => {
    state = recordActivity(state, entry, { now: now() })
    dirty = true
    if (timer === null) {
      const flushMs = Number.isFinite(deps.flushMs) ? deps.flushMs : 5000
      timer = setTimeout(() => {
        timer = null
        flush()
      }, flushMs)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }

  const offCreated = ctx.on('agent/created', ({ agent } = {}) => {
    try {
      if (!agent?.ctx || typeof agent.ctx.on !== 'function') return
      const offEvent = agent.ctx.on('session/event', (_subject, event) => {
        try {
          const entry = classifyEvent(event)
          if (entry) push(entry)
        } catch {
          /* 采集失败不影响主流程 */
        }
      })
      const offError = agent.ctx.on('agent/request-error', (payload, next) => {
        try {
          const failure = payload?.failure ?? {}
          push({
            kind: 'request',
            ok: false,
            text: String(failure?.code ?? failure?.message ?? 'request-error'),
          })
        } catch {
          /* 同上 */
        }
        return next()
      })
      return () => {
        try {
          offEvent?.()
          offError?.()
        } catch {
          /* 卸载失败忽略 */
        }
      }
    } catch {
      return
    }
  })

  return () => {
    try {
      offCreated?.()
      if (timer !== null) clearTimeout(timer)
      timer = null
      flush()
    } catch {
      /* 卸载失败忽略 */
    }
  }
}
