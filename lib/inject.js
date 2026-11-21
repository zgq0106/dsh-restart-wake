/**
 * 启动扫描与投递。
 *
 * 投递代码照搬 dsh-restart-wake 0.1.6 `lib/wake.js` 的做法：
 * `sessionController.prompt(request, signal)` 必须带 AbortSignal（实现会立即调用
 * `signal.throwIfAborted()`），`mode: 'queue'` 会显式恢复冷会话。
 *
 * 与 wake.js 的差异只在归档：成功 → `inject-done/`，失败/过期/重复 →
 * `inject-failed/`，全部 move，不删除。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ensureDir,
  isExpired,
  listPending,
  moveTo,
  readTask,
} from './pending-inject.js'
import { buildInjectMessage } from './message.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** wake.log 式轮转：超过 maxBytes 时只保留一份 .1。 */
function rotateLog(logPath, maxBytes) {
  try {
    if (!existsSync(logPath)) return
    if (statSync(logPath).size < maxBytes) return
    const previous = `${logPath}.1`
    rmSync(previous, { force: true })
    renameSync(logPath, previous)
  } catch {
    /* 轮转绝不能影响投递 */
  }
}

/** 追加写日志 + Host logger；任何日志故障都不影响主流程。 */
export function createLogger(ctx, options) {
  return (message) => {
    try {
      ensureDir(dirname(options.injectLogPath))
      rotateLog(options.injectLogPath, options.maxLogBytes)
      appendFileSync(options.injectLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
      /* best effort */
    }
    try {
      ctx.logger?.info?.(`ownshield-inject: ${message}`)
    } catch {
      /* same */
    }
  }
}

/**
 * 投递一条。request 的形状与 dsh-restart-wake 完全一致。
 * @returns {Promise<unknown>}
 */
export async function deliver(service, task, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.deliverTimeoutMs)
  try {
    return await service.prompt(
      {
        requestId: randomUUID(),
        sessionId: task.sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: buildInjectMessage(task, {
              maxErrorLines: options.maxErrorLines,
              maxMessageChars: options.maxMessageChars,
            }),
          },
        ],
        clientTimeZone: options.timeZone,
      },
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** 等 sessionController 装配好；返回 undefined 表示超时（pending 原样保留）。 */
export async function waitForController(ctx, options) {
  const deadline = Date.now() + options.readyTimeoutMs
  while (Date.now() < deadline) {
    const service = ctx.get('sessionController')
    if (service && typeof service.prompt === 'function') return service
    await sleep(500)
  }
  return undefined
}

async function handleEntry(service, entry, options, log, seen) {
  const label = entry.file.split(/[\\/]/).pop() ?? entry.file

  let task
  try {
    task = entry.task ?? readTask(entry.file)
  } catch (error) {
    log(`pending-unreadable file=${label} ${errorText(error)}`)
    const target = moveTo(options.failedDir, entry.file)
    log(`moved-failed file=${label} to=${target ?? '(move-failed)'}`)
    return { delivered: false, moved: target, reason: 'unreadable' }
  }

  if (isExpired(task, options.maxAgeMs)) {
    log(`expired session=${task.sessionId} createdAt=${task.createdAt ?? '-'} file=${label}`)
    const target = moveTo(options.failedDir, entry.file)
    log(`moved-failed file=${label} to=${target ?? '(move-failed)'}`)
    return { delivered: false, moved: target, reason: 'expired' }
  }

  if (seen.has(task.sessionId)) {
    log(`duplicate session=${task.sessionId} file=${label}`)
    const target = moveTo(options.failedDir, entry.file)
    log(`moved-failed file=${label} to=${target ?? '(move-failed)'}`)
    return { delivered: false, moved: target, reason: 'duplicate' }
  }
  seen.add(task.sessionId)

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await deliver(service, task, options)
      const target = moveTo(options.doneDir, entry.file)
      log(
        `delivered session=${task.sessionId} attempt=${attempt} file=${label} done=${target ?? '(move-failed)'}`,
      )
      return { delivered: true, moved: target, reason: 'delivered' }
    } catch (error) {
      const code = error && typeof error.code === 'string' ? ` code=${error.code}` : ''
      log(`deliver-failed session=${task.sessionId} attempt=${attempt}${code} ${errorText(error)}`)
      if (attempt < options.maxAttempts) await sleep(options.retryDelayMs)
    }
  }

  log(`gave-up session=${task.sessionId} after ${options.maxAttempts} attempts file=${label}`)
  const target = moveTo(options.failedDir, entry.file)
  log(`moved-failed file=${label} to=${target ?? '(move-failed)'}`)
  return { delivered: false, moved: target, reason: 'gave-up' }
}

/**
 * 一次扫描（启动时调用一次；测试直接调它）。
 * @param {object} ctx Cordis 上下文（测试用 fake）
 * @param {object} options resolveConfig 的结果
 * @param {(message:string)=>void} [logger]
 */
export async function runOnce(ctx, options, logger) {
  const log = logger ?? createLogger(ctx, options)
  const entries = listPending(options.injectDir)
  const summary = { entries: entries.length, delivered: 0, failed: 0, results: [] }
  if (entries.length === 0) {
    log('no-pending')
    return summary
  }

  const service = await waitForController(ctx, options)
  if (service === undefined) {
    // 文件原样保留，下次启动再试；绝不能为了「清理」把它们丢掉。
    log(`controller-unavailable timeoutMs=${options.readyTimeoutMs} entries=${entries.length}`)
    summary.results.push({ reason: 'controller-unavailable' })
    return summary
  }

  const seen = new Set()
  for (const entry of entries) {
    const result = await handleEntry(service, entry, options, log, seen)
    if (result.delivered) summary.delivered += 1
    else summary.failed += 1
    summary.results.push(result)
  }
  log(`scan-complete entries=${summary.entries} delivered=${summary.delivered} failed=${summary.failed}`)
  return summary
}

/**
 * Host 启动后延迟执行一次。每个 Host 进程只跑一遍；没有 pending 时静默退出。
 * @param {object} ctx Cordis 插件上下文
 * @param {object} options resolveConfig 的结果
 */
export function startInjectLoop(ctx, options) {
  const log = createLogger(ctx, options)
  const interval = Number.isFinite(options.scanIntervalMs) ? options.scanIntervalMs : 0
  const tick = () => {
    void runOnce(ctx, options, log).catch((error) => log(`crashed ${errorText(error)}`))
  }
  /** 启动时先扫一次；间隔 > 0 时再挂周期重扫，返回清理函数。 */
  const start = () => {
    tick()
    if (interval <= 0) return () => {}
    const timer = setInterval(tick, interval)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }
  if (typeof ctx.effect === 'function') {
    let stopTicking = () => {}
    ctx.effect(() => {
      const timer = setTimeout(() => {
        stopTicking = start()
      }, options.startupDelayMs)
      return () => {
        clearTimeout(timer)
        stopTicking()
      }
    }, 'ownshield-inject.startup()')
  } else {
    setTimeout(start, options.startupDelayMs)
  }
}
