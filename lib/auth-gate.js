/**
 * 第 7 项：auth-gate —— 认证门被动检查（2026-11-21 补）
 *
 * 起因：11-19 12:32 主人要求「401 这类模型不可用也纳入探针」。落地时只做成
 * `tools/ownshield/authprobe.mjs` + `probe-matrix.mjs` 的独立脚本，**没有任何自动链路
 * 调用它们**——日常无人值守时，401 不会被发现。这里把它接进 ownshield_probe。
 *
 * 安全红线（沿用 authprobe 的结论）：一次 401 会让 `dsh-llm-deepseek` 执行 `rejectToken`，
 * 删掉本地登录凭据并登出。所以本项**只读、绝不发任何模型请求**：
 *   ① 凭据文档是否存在（只看 stat，不解析、不打印值）
 *   ② 最近 24 小时的日志与崩溃日志里有没有认证失败标记（401/402/429/rejectToken/
 *      model-discovery-rejected）
 *
 * C 类（Key / 网络 / 磁盘）回滚 asar 没有意义（见 `docs/DSH本体自愈-预研-2026-11-17.md`），
 * 所以本项 **ok 恒为 true**，异常只写 `warn`：不参与总判定，不构成 `probe-failure` 硬信号，
 * 也就不会误触发看门狗回滚。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUTH_MARKERS = ['401', '402', '429', 'rejectToken', 'model-discovery-rejected']
const LOOKBACK_MS = 24 * 60 * 60 * 1000
const MAX_BYTES_PER_FILE = 512 * 1024
const MAX_FILES = 40

/** DSH 家目录：$DSH_HOME，否则 ~/.dsh（与 authprobe 一致）。 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/** 凭据文档默认位置：<DSH_HOME>/.credentials.yaml。 */
export function defaultCredentialPath(home = resolveDshHome()) {
  return path.join(home, '.credentials.yaml')
}

/** 日志目录：桌面 app 的 logs + DSH 自己的 logs。 */
export function defaultLogDirs(env = process.env, home = resolveDshHome(env)) {
  const dirs = []
  const appData = env.APPDATA || process.env.APPDATA
  if (appData) dirs.push(path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'))
  dirs.push(path.join(home, 'logs'))
  return dirs
}

function recentFiles(dir, sinceMs) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    try {
      const st = statSync(full)
      if (st.mtimeMs >= sinceMs) out.push({ path: full, name: entry.name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      /* 读不到就跳过，不因为日志不可读判失败 */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_FILES)
}

function scanAuthMarkers(file) {
  let text = ''
  try {
    const buf = readFileSync(file.path)
    const slice = buf.length > MAX_BYTES_PER_FILE ? buf.subarray(buf.length - MAX_BYTES_PER_FILE) : buf
    text = slice.toString('utf8')
  } catch {
    return null
  }
  const hits = []
  for (const marker of AUTH_MARKERS) {
    if (marker === '401' || marker === '402' || marker === '429') {
      if (new RegExp(`(^|\\D)${marker}(\\D|$)`).test(text)) hits.push(marker)
    } else if (text.includes(marker)) {
      hits.push(marker)
    }
  }
  return hits.length > 0 ? hits : null
}

const HOST_LOG_PARTS = ['logs', 'ds-harness-remote', 'host.log']
const HOST_LOG_IDLE_MS = 30 * 60 * 1000
const HOST_LOG_TAIL_BYTES = 512 * 1024

function parseLineTimestamp(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(line)
  if (!match) return undefined
  const at = Date.parse(match[1])
  return Number.isFinite(at) ? at : undefined
}

/**
 * 从 profile 补丁里读 `connection.cookieMaxAgeDays`。没有显式配置就返回 undefined——
 * 不去猜 DSH 的默认值，宁可跳过也不误报。
 */
export function resolveCookieMaxAgeDays(env = process.env, home = resolveDshHome(env)) {
  const profilesDir = path.join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  for (const name of names) {
    let text = ''
    try {
      text = readFileSync(path.join(profilesDir, name, 'cordis.patch.yml'), 'utf8')
    } catch {
      continue
    }
    const match = /cookieMaxAgeDays:\s*([0-9]+(?:\.[0-9]+)?)/.exec(text)
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return undefined
}

/**
 * 本地 Web 登录 cookie 寿命检查（2026-11-21 补，11-19 那次 401 的真因）。
 *
 * 机制：`client-connection` 用启动 token 换 `dsh-auth-<端口>` cookie，`cookieMaxAgeDays`
 * 限制其寿命，过期后每个请求都 401。这类 401 既不进会话事件、也不写 DSH 日志，
 * 所以模型侧的事件监听与日志扫描都够不着——只能从「进程年龄 vs cookie 寿命」静态推断。
 *
 * 进程启动时间取 `host.log` 里最后一次 `host identity ready`。这是**近似**：cookie 实际
 * 在页面首次打开时签发，所以只有「页面长时间没刷新」时进程年龄才等于 cookie 年龄。
 * 因此本项只告警、不构成硬信号。
 */
export function checkWebCookieAge({ env = process.env, home = resolveDshHome(env), now = Date.now() } = {}) {
  const hostLog = path.join(home, ...HOST_LOG_PARTS)
  if (!existsSync(hostLog)) return { state: 'no-log', detail: '没有 host.log，跳过本地 Web cookie 寿命推断' }
  let text = ''
  try {
    const buf = readFileSync(hostLog)
    text = buf.subarray(Math.max(0, buf.length - HOST_LOG_TAIL_BYTES)).toString('utf8')
  } catch {
    return { state: 'unreadable', detail: 'host.log 读取失败，跳过本地 Web cookie 寿命推断' }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  let lastStart
  let lastTime
  for (const line of lines) {
    const at = parseLineTimestamp(line)
    if (at !== undefined) lastTime = at
    if (line.includes('host identity ready')) {
      const started = parseLineTimestamp(line)
      if (started !== undefined) lastStart = started
    }
  }
  if (lastTime === undefined || now - lastTime > HOST_LOG_IDLE_MS) {
    return { state: 'idle', detail: 'host.log 不活跃，跳过本地 Web cookie 寿命推断' }
  }
  if (lastStart === undefined) {
    return { state: 'unknown', detail: 'host.log 里没有 host identity ready，无法确定进程启动时间' }
  }
  const limitDays = resolveCookieMaxAgeDays(env, home)
  if (limitDays === undefined) {
    return { state: 'unconfigured', detail: 'profile 未显式配置 cookieMaxAgeDays，跳过过期推断' }
  }
  const ageHours = (now - lastStart) / 3_600_000
  const limitHours = limitDays * 24
  if (ageHours <= limitHours) {
    return { state: 'ok', ageHours, limitHours, detail: `进程已运行 ${ageHours.toFixed(1)}h，cookie 寿命 ${limitHours}h，未过期` }
  }
  return {
    state: 'stale',
    ageHours,
    limitHours,
    detail: `进程已连续运行 ${ageHours.toFixed(1)}h，超过 dsh-auth cookie 寿命 ${limitHours}h（按进程年龄近似）；此时刷新页面会 401，处置是重启（重启窗口会清理 dsh-auth-* 残留），回滚 asar 无效`,
  }
}

/**
 * @param {object} options 插件选项（只用于取 env，不写文件）
 * @param {{name:string, ok:boolean, error:string, detail:string, warn?:string}} check
 */
export function checkAuthGate(options, check) {
  const env = options?.env && typeof options.env === 'object' ? options.env : process.env
  const home = resolveDshHome(env)
  const credentialPath = defaultCredentialPath(home)
  const now = Date.now()
  const notes = []
  const warnings = []

  if (existsSync(credentialPath)) {
    let mtime = ''
    try {
      mtime = new Date(statSync(credentialPath).mtimeMs).toISOString()
    } catch {
      /* stat 失败就当未知，不判失败 */
    }
    notes.push(`凭据文档存在${mtime ? `（更新于 ${mtime}）` : ''}`)
  } else {
    // 缺凭据 = 需要人重新登录，回滚 asar 没用（C 类），只告警。
    warnings.push('未找到凭据文档，若会话报 unauthorized 需要主人重新登录')
  }

  const cookie = checkWebCookieAge({ env, home, now })
  if (cookie.state === 'stale') {
    warnings.push(cookie.detail)
    // 结构化信号：watch 只认这个字段，不靠文案匹配。
    check.cookieStale = true
  } else {
    notes.push(cookie.detail)
  }

  const since = now - LOOKBACK_MS
  let scanned = 0
  for (const dir of defaultLogDirs(env, home)) {
    for (const file of recentFiles(dir, since)) {
      scanned += 1
      const hits = scanAuthMarkers(file)
      if (hits) warnings.push(`${file.name} 近 24h 出现 ${[...new Set(hits)].join('/')}`)
    }
  }
  notes.push(scanned > 0 ? `近 24h 扫过 ${scanned} 个日志文件` : '近 24h 无可读日志')

  check.ok = true // C 类只告警：绝不因认证问题触发回滚
  check.error = ''
  check.detail = notes.join('；')
  check.warn = warnings.join('；')
  return check
}
