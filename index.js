/**
 * dsh-restart-wake 2.0 — Host half（重启/唤醒 + 本体自愈 + 故障回注三合一）.
 *
 * 2.0 把三个包并成一个：dsh-restart-wake（重启/唤醒/cookie）+ dsh-ownshield
 * （自愈工具与自愈提示）+ dsh-ownshield-inject（故障回注/探针闸/请求失败注入）。
 * 三条启动通道保持各自独立，只是入口并到这一个文件：
 *   1. startWakeLoop   —— 启动后投递唤醒登记，冷会话经 sessionController.prompt 恢复；
 *   2. startInjectLoop —— 扫描 inject-pending / wake-pending，把故障现场投回原会话；
 *   3. startProbeGate / startRequestWatch —— 限流触发本体探针、请求失败即注入。
 *
 * 另外注册一段内置提示（重启/唤醒 + 本体自愈两个小节）和 11 个 Agent 工具：
 *   restart_now / wake_register / wake_list / wake_cancel / restart_status / cookie_status
 *   ownshield_probe / ownshield_snapshot / ownshield_arm / ownshield_disarm / ownshield_status
 *
 * 三份 options 刻意不合并（lib/config.js、lib/config-ownshield.js、lib/config-inject.js 并存）：
 * 字段同名同义处各自读同一个 Loader 字段，天然一致；`pendingDir` / `logPath` / `promptEnabled`
 * 三处曾经的语义冲突按各 config 顶部的注释改名处理。
 *
 * 没有 Client 半边。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './lib/config.js'
import { resolveOwnshieldConfig } from './lib/config-ownshield.js'
import { resolveInjectConfig } from './lib/config-inject.js'
import { startInjectLoop } from './lib/inject.js'
import { runProbeGate } from './lib/probe-gate.js'
import { registerPrompt } from './lib/prompt.js'
import { startRequestWatch } from './lib/request-watch.js'
import { createTools } from './lib/tools.js'
import { createOwnshieldTools } from './lib/tools-ownshield.js'
import { startWakeLoop } from './lib/wake.js'

export const name = 'dsh-restart-wake'

/** `ctx.tools` must exist before the tools can be registered. */
export const inject = ['tools']

/** 探针 pending 用固定文件名：与「故障回注」的 inject-pending.json 互不覆盖。 */
const PROBE_PENDING = 'inject-pending-probe.json'

/** 读 `~/.dsh/ownshield/arm.json` 里的 notifySessionId（看门狗 A2 新增字段）。 */
function notifySessionFromArm(dir) {
  try {
    const file = path.join(dir, 'arm.json')
    if (!existsSync(file)) return ''
    const raw = JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
    const id = raw?.notifySessionId
    return typeof id === 'string' ? id.trim() : ''
  } catch {
    return ''
  }
}

/** 写一条「请跑探针」的 pending；已存在且未过期时不覆盖。 */
export function writeProbeRequest(dir, { sessionId, prompt, now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, PROBE_PENDING)
  const body = {
    sessionId: String(sessionId),
    prompt: String(prompt),
    createdAt: now.toISOString(),
    source: 'dsh-restart-wake.probe-gate',
    level: 'probe',
  }
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/**
 * @param ctx Cordis 插件上下文。
 * @param {Record<string, unknown>} [config] Loader 行配置，全部字段可选。
 */
export function apply(ctx, config = {}) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const given = config && typeof config === 'object' ? config : {}

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`${name}: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }
  /** 每块独立隔离：任何一块抛错只 warn，不阻断其余块与工具注册。 */
  const block = (label, run) => {
    try {
      run()
    } catch (error) {
      warn(`${label}启动失败：${error?.message ?? error}`)
    }
  }

  /* 1. 三份 options（不合并，各自的 resolve 读同一个 Loader config） */
  const restart = resolveConfig(pluginDir, given)
  const ownshield = resolveOwnshieldConfig(pluginDir, given)
  const injectLoop = resolveInjectConfig(pluginDir, given)

  /* 2. 跨模块共享：进程名驱动看门狗脚本，时区三份对齐 */
  ownshield.processName = restart.processName
  ownshield.timeZone = restart.timeZone
  injectLoop.timeZone = restart.timeZone
  // 2.0 合包后的状态桥：restart_now 要知道自愈状态目录，才能在看护期间
  // 先声明「这次重启是预期的」，否则看门狗会把它判成崩溃并回滚。
  restart.ownshieldDir = ownshield.ownshieldDir

  /* 3. 环境自检：沿用重启侧三条 + 自愈脚本一条 */
  if (process.platform !== 'win32') {
    warn('自动重启目前只支持 Windows；唤醒、登记与状态查询仍可用。')
  }
  if (restart.exePath === '' || !existsSync(restart.exePath)) {
    warn(
      `未能定位 Harness 可执行文件（${restart.exePath || '空'}）。restart_now 会拒绝执行；请在插件配置里设置 exePath。`,
    )
  }
  if (!existsSync(restart.scriptPath)) {
    warn(`重启脚本缺失：${restart.scriptPath}`)
  }
  if (!existsSync(ownshield.armScriptPath)) {
    warn(
      `自愈脚本缺失：${ownshield.armScriptPath}。ownshield_* 工具会报「脚本缺失」；开发环境请把 scriptsDir 指向 <repo>/tools/ownshield。`,
    )
  }

  info(
    `probes write to ${ownshield.ownshieldDir}; inject dir=${injectLoop.injectDir} ` +
      `startupDelayMs=${injectLoop.startupDelayMs} requestWatch=${
        injectLoop.requestWatchEnabled === false ? 'off' : `on/${injectLoop.requestWatchCooldownMs}ms`
      }`,
  )

  /* 4–7. 启动钩子：先跑钩子，再注册工具（与原两个包各自的顺序一致） */
  block('唤醒循环', () => startWakeLoop(ctx, restart))
  block('故障回注', () => startInjectLoop(ctx, injectLoop))
  block('探针闸', () => startProbeGate(ctx, injectLoop))
  block('请求失败注入', () => startRequestWatch(ctx, injectLoop))
  block('注入日志', () => logArmed(injectLoop))

  /* 8. 提示合并成一次注册；两个开关都关时不注册 */
  const restartPromptEnabled =
    restart.promptEnabled !== false && given.restartPromptEnabled !== false
  const ownshieldPromptEnabled =
    ownshield.promptEnabled !== false && given.ownshieldPromptEnabled !== false

  block('内置提示', () => {
    if (!registerPrompt(ctx, { restartPromptEnabled, ownshieldPromptEnabled })) {
      warn('systemPrompt 不可用或已关闭：跳过内置协议提示，工具仍可用。')
    }
  })

  /* 9. 11 个工具：两个 createTools 的结果 concat 后统一 effect 注册 */
  block('Agent 工具注册', () => {
    const tools = [...createTools(ctx, restart), ...createOwnshieldTools(ctx, ownshield)]
    for (const tool of tools) {
      const register = () => ctx.tools.register(tool)
      if (typeof ctx.effect === 'function') {
        ctx.effect(register, `${name}.tool.${tool.name}()`)
      } else {
        register()
      }
    }
  })
}

/**
 * 把「触发器已挂载」写进 inject.log。
 * 宿主日志位置不固定，靠 logger 证明不了行为；这行是重启后可直接 grep 的证据。
 */
function logArmed(options) {
  try {
    const state =
      options.requestWatchEnabled === false
        ? 'request-watch=off'
        : `request-watch=armed cooldown=${options.requestWatchCooldownMs}ms`
    mkdirSync(options.injectDir, { recursive: true })
    appendFileSync(
      options.injectLogPath,
      `${new Date().toISOString()} ${name}: ${state}\n`,
      'utf8',
    )
  } catch {
    /* 日志失败不影响加载 */
  }
}

/**
 * 探针生产者的启动钩子。任何异常都吞掉：探针是增值功能，绝不能影响注入主流程。
 * @param ctx Cordis 插件上下文。
 * @param {object} options resolveConfig 的结果。
 */
export function startProbeGate(ctx, options) {
  if (options.probeGateEnabled === false) return
  const run = () => {
    try {
      void runProbeGate({
        dir: options.injectDir,
        probeSessionId: options.probeSessionId || notifySessionFromArm(options.injectDir),
        intervalMs: options.probeIntervalMs,
        probeTimeoutMs: options.probeTimeoutMs,
        requestProbe: (args) => writeProbeRequest(options.injectDir, args),
        log: (message) => {
          try {
            ctx.logger?.info?.(`ownshield-inject: ${message}`)
          } catch {
            /* 日志失败不影响判定 */
          }
        },
      }).catch(() => {})
    } catch {
      /* 同：探针不影响注入 */
    }
  }
  const delay = Number.isFinite(options.probeStartDelayMs) ? options.probeStartDelayMs : 45_000
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setTimeout(run, delay)
      return () => clearTimeout(timer)
    }, 'ownshield-inject.probeGate()')
  } else {
    setTimeout(run, delay)
  }
}
