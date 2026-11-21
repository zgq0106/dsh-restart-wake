/**
 * 插件配置（故障回注半边，搬自 `dsh-ownshield-inject`）。
 *
 * 2.0 合并要点：
 *   - 导出名改为 `resolveInjectConfig` / `INJECT_DEFAULTS`；
 *   - `pendingDir` → `injectDir`，`logPath` → `injectLogPath`，避免与 `lib/config.js` 撞名；
 *   - 与 `lib/config.js` 共享的字段（timeZone / startupDelayMs / readyTimeoutMs /
 *     deliverTimeoutMs / maxAttempts / retryDelayMs / maxAgeMs / maxLogBytes）**必须同默认值**，
 *     三份 config 并存、各自读同一个 Loader 字段，改一处默认值要三处一起改。
 *
 * 默认值面向本机 ownshield 约定：状态都在 `~/.dsh/ownshield/`，
 * 与 T4 看门狗写的 `arm.json` / `recovery.log` 同目录。
 * 所有字段都可以在 Loader 行的 `config` 里覆盖（测试也走这里）。
 */

import { homedir } from 'node:os'
import path from 'node:path'

export const INJECT_DEFAULTS = {
  /** Host 启动后延迟多久开始扫描，给 sessionController 留出装配时间。 */
  startupDelayMs: 3000,
  /** 等待 sessionController 可用的上限。 */
  readyTimeoutMs: 60000,
  /** 单次投递超时（AbortSignal）。 */
  deliverTimeoutMs: 30000,
  /** 单条 pending 的投递尝试次数。 */
  maxAttempts: 3,
  /** 重试间隔。 */
  retryDelayMs: 15000,
  /** 超过这个年龄的 pending 不再投递，直接移进 inject-failed/。 */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** 注入消息里最多保留的错误尾部行数（任务规定 20 行）。 */
  maxErrorLines: 20,
  /** 注入消息总长度上限，防止把超大日志灌进会话。 */
  maxMessageChars: 6000,
  /** 日志轮转阈值。 */
  maxLogBytes: 256 * 1024,
  /** 投递时附带的时区。 */
  timeZone: 'Asia/Shanghai',
  /**
   * 探针生产者（A1）。默认开；关掉后启动时不再碰探针。
   * 限流 6 小时：每次重启都跑探针会白烧 token。
   */
  probeGateEnabled: true,
  probeIntervalMs: 6 * 60 * 60 * 1000,
  /** 起跑延迟，给工具注册表与 Host 装配留时间。 */
  probeStartDelayMs: 45_000,
  /** 单次探针上限（直调时用）。 */
  probeTimeoutMs: 120_000,
  /** 直调拿不到 agent 绑定时，投递 pending 的目标会话；空则读 arm.json 的 notifySessionId。 */
  probeSessionId: '',
  /**
   * 启动扫描之后的重扫间隔（2026-11-21 新增）。
   * 旧实现只在启动时扫一次，导致「运行中写下的 pending」必须等下一次重启才被投递；
   * 探针生产者、熔断通知都写在运行期，等重启等于迟到一整天。设 0 可退回只扫一次。
   */
  scanIntervalMs: 5 * 60 * 1000,
  /**
   * 触发器（2026-11-21 新增）：模型请求失败时，立刻把这条信息注入回会话。
   * 不是轮询、不是通知系统——`agent/request-error` 发生即注入一轮，让模型自己看见并告知主人。
   * 关闭后完全不挂监听。
   */
  requestWatchEnabled: true,
  /** 同一 agent + 同一失败码的注入冷却，防止 401 循环把会话刷爆。 */
  requestWatchCooldownMs: 10 * 60 * 1000,
}

/**
 * @param {string} pluginDir 插件包目录（保留给将来扩展，不参与默认路径）。
 * @param {Record<string, unknown>} [override] Loader 行配置。
 */
export function resolveInjectConfig(pluginDir, override = {}) {
  const given = override && typeof override === 'object' ? override : {}

  const pickString = (key, fallback) => {
    const value = given[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  const pickNumber = (key, fallback) => {
    const value = Number(given[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const home = pickString('home', path.join(homedir(), '.dsh'))
  const injectDir = pickString('injectDir', path.join(home, 'ownshield'))

  return {
    ...INJECT_DEFAULTS,
    pluginDir,
    home,
    /**
     * 2.0 合并：原字段名 `pendingDir`（语义与重启侧的 `~/.dsh/restart-wake` 撞车），
     * 改名 `injectDir`；状态目录仍是 `~/.dsh/ownshield`，老用户历史文件原地可读。
     */
    injectDir,
    doneDir: pickString('doneDir', path.join(injectDir, 'inject-done')),
    failedDir: pickString('failedDir', path.join(injectDir, 'inject-failed')),
    /** 2.0 合并：原 `logPath` 改名 `injectLogPath`（重启侧 `logPath` 指向 wake.log）。 */
    injectLogPath: pickString('injectLogPath', path.join(injectDir, 'inject.log')),
    startupDelayMs: pickNumber('startupDelayMs', INJECT_DEFAULTS.startupDelayMs),
    readyTimeoutMs: pickNumber('readyTimeoutMs', INJECT_DEFAULTS.readyTimeoutMs),
    deliverTimeoutMs: pickNumber('deliverTimeoutMs', INJECT_DEFAULTS.deliverTimeoutMs),
    maxAttempts: pickNumber('maxAttempts', INJECT_DEFAULTS.maxAttempts),
    retryDelayMs: pickNumber('retryDelayMs', INJECT_DEFAULTS.retryDelayMs),
    maxAgeMs: pickNumber('maxAgeMs', INJECT_DEFAULTS.maxAgeMs),
    maxErrorLines: pickNumber('maxErrorLines', INJECT_DEFAULTS.maxErrorLines),
    maxMessageChars: pickNumber('maxMessageChars', INJECT_DEFAULTS.maxMessageChars),
    maxLogBytes: pickNumber('maxLogBytes', INJECT_DEFAULTS.maxLogBytes),
    timeZone: pickString('timeZone', INJECT_DEFAULTS.timeZone),
    probeGateEnabled: given.probeGateEnabled === false ? false : INJECT_DEFAULTS.probeGateEnabled,
    probeIntervalMs: pickNumber('probeIntervalMs', INJECT_DEFAULTS.probeIntervalMs),
    probeStartDelayMs: pickNumber('probeStartDelayMs', INJECT_DEFAULTS.probeStartDelayMs),
    probeTimeoutMs: pickNumber('probeTimeoutMs', INJECT_DEFAULTS.probeTimeoutMs),
    probeSessionId: pickString('probeSessionId', INJECT_DEFAULTS.probeSessionId),
    scanIntervalMs:
      given.scanIntervalMs === 0 ? 0 : pickNumber('scanIntervalMs', INJECT_DEFAULTS.scanIntervalMs),
    requestWatchEnabled:
      given.requestWatchEnabled === false ? false : INJECT_DEFAULTS.requestWatchEnabled,
    requestWatchCooldownMs: pickNumber(
      'requestWatchCooldownMs',
      INJECT_DEFAULTS.requestWatchCooldownMs,
    ),
  }
}
