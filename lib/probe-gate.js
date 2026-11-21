/**
 * `probe-failure` 生产者：启动后按条件触发探针，并把「结构性失败」写成硬信号。
 *
 * 背景（2026-11-21 ownshield 余项）：
 *   四类硬信号里 `process-gone` / `new-crash-log` / `heartbeat-stale` 都有生产者，
 *   只有 `probe-failure` 没有——注入器全文不调探针，watch.mjs 的 verify 只查
 *   process+crash（跑不完一次探针）。结果是「DSH 起来了但会话跑不动」这类故障
 *   仍然只能靠人发现。
 *
 * 这里做三件事，全部离线可测：
 *   1. 限流：距上次探针 > 6 小时才触发一次（避免每次重启都烧 token）；
 *   2. 分流：结构性失败（agent-preset/invalid、Duplicate tool group、resume failed、
 *      session/not-found、工具/服务清单缺失）→ 写 `probe-failure.json`，供看门狗下一轮
 *      判硬信号；网络 / 5xx / 超时 → 只记日志，绝不产硬信号（避免把网络抖动当成本体坏了）；
 *   3. 触发方式：优先直调；拿不到 agent 绑定就退化为投递 pending 让会话跑。
 *
 * 为什么默认走 pending 而不是直调（写清楚，免得后面有人以为是偷懒）：
 *   探针实现是 `dsh-ownshield/lib/probe.js` 的 `runProbe(ctx, options, agent)`，第三个参数
 *   `agent` 由 DSH 的工具调用方在 `execute(rawArgs, exec)` 里注入（`exec?.agent`）；
 *   dsh-ownshield-inject 是 Host 侧插件，既没有工具注册表里的调用上下文，拿不到 agent 绑定，
 *   而且 dsh-ownshield 的 `package.json#exports` 只暴露 `.` / `./cordis.patch.yml` /
 *   `./locale/*.json` / `./icon` / `./package.json`，深引 `lib/probe.js` 会被 Node 的 exports
 *   约束挡掉。所以在 Host 侧「直调探针」需要伪造 agent 或改对方包导出，两条都比投递一条
 *   pending 更危险。投递不额外烧 token 之外的成本：会话用现成的 `ownshield_probe` 工具跑一次，
 *   产物照旧落在 `~/.dsh/ownshield/probe-<ts>.json`，本模块下一轮读它做分流。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 两次探针之间的最小间隔：6 小时。 */
export const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 默认起跑延迟：给 Host 与工具注册表留出装配时间。 */
export const PROBE_START_DELAY_MS = 45_000

/** 结构性失败的特征（判定只看失败检查项的 name/error/detail 文本）。 */
export const STRUCTURAL_PATTERNS = [
  { reason: 'agent-preset/invalid', re: /agent-preset\/(invalid|not-found)/i },
  { reason: 'duplicate-tool-group', re: /duplicate tool group/i },
  { reason: 'resume-failed', re: /resume failed|resume\s*失败/i },
  { reason: 'session-not-found', re: /session\/not-found/i },
]

/** 网络/限流/超时的特征：只记日志，不产硬信号。 */
const TRANSIENT_PATTERNS = [
  { kind: 'timeout', re: /timed?\s*out|timeout|ETIMEDOUT|AbortError/i },
  { kind: 'network', re: /ECONN|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|network/i },
  { kind: 'http-5xx', re: /\b5\d\d\b|server error|bad gateway|service unavailable/i },
  { kind: 'rate-limit', re: /rate.?limit|429|too many requests/i },
]

const INVENTORY_NAMES = new Set(['tool-inventory', 'service-inventory'])

export function probeStatePath(dir) {
  return join(dir, 'probe-gate.json')
}

export function probeFailurePath(dir) {
  return join(dir, 'probe-failure.json')
}

function safeReadJson(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function atomicWriteJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 读 `probe-gate.json`：{ lastProbeAt, lastOutcome, lastReasons }。 */
export function readProbeState(dir) {
  const raw = safeReadJson(probeStatePath(dir))
  const lastProbeAt = Date.parse(String(raw?.lastProbeAt ?? ''))
  return {
    exists: raw !== null,
    lastProbeAt: Number.isFinite(lastProbeAt) ? lastProbeAt : null,
    lastOutcome: typeof raw?.lastOutcome === 'string' ? raw.lastOutcome : '',
    lastReasons: Array.isArray(raw?.lastReasons) ? raw.lastReasons : [],
  }
}

export function writeProbeState(dir, { now = Date.now(), outcome = '', reasons = [] } = {}) {
  const payload = {
    lastProbeAt: new Date(now).toISOString(),
    lastOutcome: outcome,
    lastReasons: reasons,
    updatedBy: 'dsh-ownshield-inject',
  }
  atomicWriteJson(probeStatePath(dir), payload)
  return payload
}

/** 限流判定：没有记录 / 时间戳解析不了 / 距上次超过 interval → 允许触发。 */
export function shouldProbe(state, { now = Date.now(), intervalMs = PROBE_INTERVAL_MS } = {}) {
  const last = Number.isFinite(state?.lastProbeAt) ? state.lastProbeAt : null
  if (last === null) return { probe: true, reason: 'no-history' }
  const gap = now - last
  if (gap > intervalMs) return { probe: true, reason: `gap>${Math.round(intervalMs / 3600000)}h` }
  return {
    probe: false,
    reason: 'rate-limited',
    nextAt: new Date(last + intervalMs).toISOString(),
    gapMs: gap,
  }
}

/** 目录里最新的 `probe-*.json`（按文件名时间戳、再按 mtime 兜底）。 */
export function latestProbeArtifact(dir, { since = 0 } = {}) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const rows = []
  for (const name of names) {
    if (!/^probe-.*\.json$/i.test(name)) continue
    const file = join(dir, name)
    const artifact = safeReadJson(file)
    if (!artifact || typeof artifact !== 'object') continue
    const ts = Date.parse(String(artifact.ts ?? artifact.at ?? ''))
    const fileMatch = /^probe-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(name)
    const fromName = fileMatch
      ? Date.parse(fileMatch[1].replace(/-(\d{3})Z$/, '.$1Z'))
      : NaN
    const effective = Number.isFinite(ts) ? ts : Number.isFinite(fromName) ? fromName : 0
    if (effective < since) continue
    rows.push({ name, file, ts: effective, artifact })
  }
  rows.sort((a, b) => b.ts - a.ts)
  return rows[0] ?? null
}

/**
 * 分流：把一份探针产物归成 ok / structural / transient / timeout。
 * 结构性失败的判据与 watch.mjs 的 classifyProbe 保持同一套关键词，避免两边结论打架。
 */
export function classifyProbeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return { kind: 'unknown', structural: false, reasons: [] }
  }
  if (artifact.timedOut === true || artifact.timeout === true) {
    return { kind: 'timeout', structural: false, reasons: ['timeout'] }
  }
  const checks = Array.isArray(artifact.checks) ? artifact.checks : []
  const failed = checks.filter((check) => check && check.ok === false)
  const text = failed
    .map((check) => `${check.name ?? ''} ${check.error ?? ''} ${check.detail ?? ''}`)
    .join('\n')

  const reasons = []
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.re.test(text)) reasons.push(pattern.reason)
  }
  if (failed.some((check) => INVENTORY_NAMES.has(String(check.name ?? '')))) {
    reasons.push('inventory-missing')
  }
  if (reasons.length > 0) return { kind: 'structural', structural: true, reasons }

  if (artifact.ok === true) return { kind: 'ok', structural: false, reasons: [] }
  if (artifact.ok !== false) return { kind: 'unknown', structural: false, reasons: [] }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.re.test(text)) return { kind: pattern.kind, structural: false, reasons: [pattern.kind] }
  }
  return { kind: 'transient', structural: false, reasons: ['transient'] }
}

/**
 * 写 `probe-failure.json`。只在结构性失败时调用；网络/超时永远不写。
 * 内容带 artifact 名字与 reasons，watch.mjs 下一轮据此判 `probe-failure` 硬信号。
 */
export function writeProbeFailure(dir, { artifact, classification, now = Date.now() } = {}) {
  const payload = {
    ts: new Date(now).toISOString(),
    ok: false,
    structural: true,
    source: 'dsh-ownshield-inject',
    reasons: classification?.reasons ?? [],
    artifact: {
      name: artifact?.name ?? '',
      ts: artifact?.artifact?.ts ?? '',
      ok: artifact?.artifact?.ok ?? null,
    },
    checks: Array.isArray(artifact?.artifact?.checks)
      ? artifact.artifact.checks
          .filter((check) => check && check.ok === false)
          .map((check) => ({
            name: String(check.name ?? ''),
            error: String(check.error ?? ''),
            detail: String(check.detail ?? ''),
          }))
      : [],
  }
  atomicWriteJson(probeFailurePath(dir), payload)
  return payload
}

/**
 * 启动后的决策核心（纯函数，测试直接调）。
 * @returns {{action:'skip'|'idle'|'classify'|'request'|'direct', ...}}
 */
export function planStartupProbe({ state, latest, now = Date.now(), intervalMs = PROBE_INTERVAL_MS, probeSessionId = '', hasDirect = false }) {
  const gate = shouldProbe(state, { now, intervalMs })
  if (!gate.probe) return { action: 'skip', reason: gate.reason, nextAt: gate.nextAt }

  // 上次限流窗口之后已经有会话跑过探针 → 先分流，不再重复触发。
  const lastProbeAt = Number.isFinite(state?.lastProbeAt) ? state.lastProbeAt : 0
  if (latest && latest.ts > lastProbeAt) {
    const classification = classifyProbeArtifact(latest.artifact)
    return { action: 'classify', reason: 'fresh-artifact', artifact: latest, classification }
  }

  if (hasDirect) return { action: 'direct', reason: 'direct-call' }
  if (probeSessionId) return { action: 'request', reason: 'pending-request', sessionId: probeSessionId }
  return { action: 'idle', reason: 'no-direct-call-and-no-session' }
}

/**
 * 启动时跑一遍。所有副作用通过 `deps` 注入，测试不碰真实磁盘。
 *
 * @param {object} args
 * @param {string} args.dir ownshield 状态目录
 * @param {(msg:string)=>void} [args.log]
 * @param {string} [args.probeSessionId] 投递 pending 的目标会话（arm.notifySessionId 或配置）
 * @param {()=>Promise<object>} [args.probeFn] 直调探针（拿得到 agent 绑定时才传）
 * @param {number} [args.probeTimeoutMs]
 */
export async function runProbeGate({
  dir,
  log = () => {},
  probeSessionId = '',
  probeFn = null,
  probeTimeoutMs = 120_000,
  now = Date.now(),
  intervalMs = PROBE_INTERVAL_MS,
  deps = {},
} = {}) {
  const io = {
    readState: deps.readState ?? (() => readProbeState(dir)),
    writeState: deps.writeState ?? ((payload) => writeProbeState(dir, payload)),
    latest: deps.latest ?? (() => latestProbeArtifact(dir, { since: 0 })),
    writeFailure: deps.writeFailure ?? ((args) => writeProbeFailure(dir, args)),
    requestProbe:
      deps.requestProbe ??
      ((args) => {
        throw new Error('requestProbe 未注入')
      }),
  }

  const state = io.readState()
  const plan = planStartupProbe({
    state,
    latest: io.latest(),
    now,
    intervalMs,
    probeSessionId,
    hasDirect: typeof probeFn === 'function',
  })

  if (plan.action === 'skip') {
    log(`probe-skip rate-limited nextAt=${plan.nextAt ?? '-'}`)
    return { ok: true, action: 'skip', ...plan }
  }
  if (plan.action === 'idle') {
    log('probe-idle 既拿不到 agent 绑定，也没有可投递的会话，跳过本轮（不产硬信号）')
    return { ok: true, action: 'idle', ...plan }
  }

  if (plan.action === 'classify') {
    if (plan.classification.structural) {
      io.writeFailure({ artifact: plan.artifact, classification: plan.classification, now })
      io.writeState({ now, outcome: 'structural', reasons: plan.classification.reasons })
      log(`probe-structural artifact=${plan.artifact.name} reasons=${plan.classification.reasons.join(',')}`)
      return { ok: false, action: 'classify', structural: true, reasons: plan.classification.reasons, artifact: plan.artifact.name }
    }
    io.writeState({ now, outcome: plan.classification.kind, reasons: plan.classification.reasons })
    log(`probe-not-structural artifact=${plan.artifact.name} kind=${plan.classification.kind}`)
    return { ok: true, action: 'classify', structural: false, kind: plan.classification.kind }
  }

  if (plan.action === 'request') {
    io.requestProbe({
      sessionId: plan.sessionId,
      reason: 'rate-limit-window-open',
      prompt: '请调用 ownshield_probe 工具（无参数）跑一次本体探针，结果会落在 ~/.dsh/ownshield/probe-<时间戳>.json。这是定时自检，不需要额外解释。',
    })
    io.writeState({ now, outcome: 'requested', reasons: [] })
    log(`probe-requested session=${plan.sessionId}`)
    return { ok: true, action: 'request', sessionId: plan.sessionId }
  }

  // action === 'direct'
  try {
    const result = await withTimeout(probeFn, probeTimeoutMs)
    const classification = classifyProbeArtifact({ ...result, timedOut: false })
    if (classification.structural) {
      io.writeFailure({ artifact: { name: 'direct', artifact: result }, classification, now })
      io.writeState({ now, outcome: 'structural', reasons: classification.reasons })
      log(`probe-structural source=direct reasons=${classification.reasons.join(',')}`)
      return { ok: false, action: 'direct', structural: true, reasons: classification.reasons }
    }
    io.writeState({ now, outcome: classification.kind, reasons: classification.reasons })
    log(`probe-ok source=direct kind=${classification.kind}`)
    return { ok: true, action: 'direct', structural: false, kind: classification.kind }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const classification = classifyProbeArtifact({ ok: false, timedOut: /timeout|timed out|AbortError/i.test(message), checks: [{ name: 'probe', ok: false, error: message }] })
    io.writeState({ now, outcome: classification.kind, reasons: classification.reasons })
    log(`probe-transient source=direct kind=${classification.kind} error=${message}`)
    return { ok: false, action: 'direct', structural: false, kind: classification.kind }
  }
}

function withTimeout(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}
