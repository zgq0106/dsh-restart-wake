/**
 * The `ownshield_probe` implementation.
 *
 * Checks, always reported in this order:
 *   1. create-session      create a temporary session with the default preset
 *   2. prompt-first-turn   send one short message and wait for the first turn
 *   3. resume-probe-session resume the fixed old probe session
 *   4. tool-inventory      expected tools vs `ctx.tools.definitions()`
 *   5. service-inventory   baseline services still resolvable
 *   6. plugin-heartbeat    plugin heartbeat files fresh
 *   7. auth-gate           凭据存在性 + 近 24h 认证标记（被动、零请求；ok 恒 true，只写 warn）
 *
 * The result file is `~/.dsh/ownshield/probe-<timestamp>.json` with exactly
 * `{ ok, ts, checks, durationMs }`（warning 非空时多一个 `warnings`）。
 * Each check is `{ name, ok, error, detail }`（auth-gate 另有 `warn`）。
 *
 * The probe is deliberately read-only toward DSH: it creates one temporary
 * session per run (the only way to test preset assembly), resumes an existing
 * one, and writes only under the ownshield artifact directory.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { checkAuthGate } from './auth-gate.js'
import {
  clip,
  ensureDir,
  errorText,
  safeTimestamp,
  sleep,
  withTimeout,
  writeJsonAtomic,
} from './util.js'

export const CHECK_NAMES = [
  'create-session',
  'prompt-first-turn',
  'resume-probe-session',
  'tool-inventory',
  'service-inventory',
  'plugin-heartbeat',
  'auth-gate',
]

const EVENTS_TIMEOUT_MS = 15000

function blankCheck(name) {
  return { name, ok: false, error: '', detail: '' }
}

function signalOf() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(EVENTS_TIMEOUT_MS)
  }
  return new AbortController().signal
}

/** Read the newest page of durable Session events. */
async function readEvents(controller, sessionId, maxMessages = 200) {
  if (typeof controller.events === 'function') {
    const page = await controller.events(
      { address: { kind: 'session', sessionId }, maxMessages },
      signalOf(),
    )
    const records = Array.isArray(page?.records) ? page.records : []
    return records
      .map((record) => (record?.type === 'event' ? record.event : record?.seq !== undefined ? record : undefined))
      .filter((event) => event && typeof event === 'object')
  }
  if (typeof controller.inspect === 'function') {
    const inspection = await controller.inspect(sessionId, signalOf())
    return Array.isArray(inspection?.events) ? inspection.events : []
  }
  throw new Error('sessionController 缺少 events/inspect 冷读入口，无法读取会话日志')
}

function maxSeq(events) {
  let max = -1
  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq > max) max = event.seq
  }
  return max
}

function messageText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function turnReason(event) {
  const reason = event?.data?.reason
  return typeof reason === 'string' ? reason : ''
}

async function checkCreate(controller, options, check) {
  if (typeof controller.create !== 'function') {
    check.error = 'sessionController.create() 不可用'
    return { sessionId: '', cwd: '' }
  }

  let cwd
  try {
    ensureDir(options.tmpBase)
    cwd = mkdtempSync(path.join(options.tmpBase, 'ownshield-probe-'))
    const created = await withTimeout(
      controller.create({ cwd }),
      options.probeTimeoutMs,
      '创建临时会话',
    )
    const sessionId = created?.sessionId
    if (!sessionId) throw new Error('session.create 未返回 sessionId')
    check.ok = true
    check.detail = [
      `sessionId=${sessionId}`,
      `preset=${created.agentPreset ? String(created.agentPreset) : 'default'}`,
      `cwd=${cwd}`,
      '（预设插件树装配失败会在这里以 agent-preset/* 抛出）',
    ].join(' ')
    // 把 cwd 一并带出去：探针结束时按这两个值清理（会话归档 + 删临时目录）。
    return { sessionId: String(sessionId), cwd }
  } catch (error) {
    check.ok = false
    check.error = errorText(error)
    check.detail = cwd ? `cwd=${cwd}` : ''
    return { sessionId: '', cwd: cwd || '' }
  }
}

async function waitForSettled(ctx, controller, sessionId, baselineSeq, deadline, options) {
  let lastTypes = []
  let reply = ''
  let turnEndReason = ''

  for (;;) {
    let events = []
    try {
      events = await readEvents(controller, sessionId)
    } catch (error) {
      // A transient read failure should not shorten the 60s budget; remember it
      // for the timeout message instead.
      lastTypes = [`read-error:${errorText(error)}`]
    }

    const fresh = events.filter(
      (event) => typeof event.seq === 'number' && event.seq > baselineSeq,
    )
    if (fresh.length > 0) lastTypes = fresh.map((event) => event.type)

    const turnEnd = fresh.find((event) => event.type === 'turn/end')
    if (turnEnd) turnEndReason = turnReason(turnEnd)
    const assistant = [...fresh]
      .reverse()
      .find((event) => event.type === 'assistant/message' && messageText(event) !== '')
    if (assistant) reply = messageText(assistant)

    const agent = safeAgent(ctx, sessionId)
    const running = agent?.status === 'running'

    if (turnEnd || (assistant && !running)) {
      return { reply, turnEndReason, eventTypes: lastTypes, agentStatus: agent?.status ?? '' }
    }

    if (Date.now() >= deadline) {
      const observed = lastTypes.length > 0 ? lastTypes.slice(-8).join(', ') : '(无)'
      throw new Error(
        `首轮未在 ${options.probeTimeoutMs}ms 内 settled；观察到的事件类型：${observed}`,
      )
    }

    await sleep(options.probePollMs)
  }
}

function safeAgent(ctx, sessionId) {
  try {
    const agents = ctx.get('agents')
    return agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    return undefined
  }
}

async function checkPrompt(ctx, controller, options, sessionId, check) {
  if (typeof controller.prompt !== 'function') {
    check.error = 'sessionController.prompt() 不可用'
    return
  }

  const started = Date.now()
  try {
    let baselineSeq = -1
    try {
      baselineSeq = maxSeq(await readEvents(controller, sessionId))
    } catch {
      // The session is brand new; a log read failure is not fatal here because
      // the settle loop will report it if it persists.
    }

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), options.probeTimeoutMs)
    try {
      const admitted = await controller.prompt(
        {
          requestId: `ownshield-probe-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: options.probeMessage }],
          clientTimeZone: options.timeZone,
        },
        abort.signal,
      )
      if (admitted?.accepted !== true) {
        throw new Error('prompt 未被接受（accepted !== true）')
      }
    } finally {
      clearTimeout(timer)
    }

    const settled = await waitForSettled(
      ctx,
      controller,
      sessionId,
      baselineSeq,
      started + options.probeTimeoutMs,
      options,
    )
    check.ok = true
    check.detail = [
      `sessionId=${sessionId}`,
      `settledMs=${Date.now() - started}`,
      settled.agentStatus ? `agent=${settled.agentStatus}` : '',
      settled.turnEndReason ? `turnEnd=${settled.turnEndReason}` : '',
      settled.reply ? `reply=${clip(settled.reply, 160)}` : 'reply=(空)',
    ]
      .filter(Boolean)
      .join(' ')
  } catch (error) {
    check.ok = false
    const aborted =
      error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''))
    check.error = aborted
      ? `prompt 投递超时（${options.probeTimeoutMs}ms）`
      : errorText(error)
    check.detail = `sessionId=${sessionId} elapsedMs=${Date.now() - started}`
  }
}

function readProbeSession(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : ''
    if (sessionId === '') return undefined
    return { ...parsed, sessionId }
  } catch {
    return undefined
  }
}

function writeProbeSession(filePath, sessionId) {
  writeJsonAtomic(filePath, { sessionId, createdAt: new Date().toISOString() })
}

/**
 * Resume the fixed probe session.
 *
 * `sessionController.resolveAgent()` is the Host-side resume entry: it opens a
 * cold Session (log validation, writer lock) and returns either `{ agent }` or
 * `{ error }` with codes such as `session/not-found` or `session/writer-held`.
 * Older versions without it fall back to a cold log read.
 */
async function checkResume(ctx, controller, options, check, fallbackSessionId) {
  let stored = readProbeSession(options.probeSessionPath)
  const notes = []

  if (!stored) {
    if (!fallbackSessionId) {
      check.error = '既没有 probe-session.json，也没有可用的新建会话，无法执行 resume'
      return
    }
    stored = { sessionId: fallbackSessionId }
    writeProbeSession(options.probeSessionPath, stored.sessionId)
    notes.push('首次运行：已把本次新建会话登记为固定探针会话')
  }

  const liveBefore = Boolean(safeAgent(ctx, stored.sessionId))

  if (typeof controller.resolveAgent === 'function') {
    let result
    try {
      result = await withTimeout(
        controller.resolveAgent(stored.sessionId),
        options.resumeTimeoutMs,
        'resume 探针',
      )
    } catch (error) {
      check.error = errorText(error)
      return
    }

    if (result?.error) {
      const code = String(result.error.code ?? '')
      const canRebase =
        code === 'session/not-found' &&
        typeof fallbackSessionId === 'string' &&
        fallbackSessionId !== '' &&
        fallbackSessionId !== stored.sessionId

      if (!canRebase) {
        check.error = errorText(result.error)
        return
      }

      stored = { sessionId: fallbackSessionId }
      writeProbeSession(options.probeSessionPath, stored.sessionId)
      notes.push(`原固定探针会话不存在，已重绑到 ${fallbackSessionId}`)

      try {
        result = await withTimeout(
          controller.resolveAgent(stored.sessionId),
          options.resumeTimeoutMs,
          'resume 探针（重绑后）',
        )
      } catch (error) {
        check.error = errorText(error)
        return
      }
      if (result?.error) {
        check.error = `重绑后 resume 仍失败：${errorText(result.error)}`
        return
      }
    }

    if (!result?.agent) {
      check.error = 'resolveAgent 未返回 agent，也未返回 error'
      return
    }

    check.ok = true
    check.detail = [
      `sessionId=${stored.sessionId}`,
      `liveBefore=${liveBefore}`,
      `status=${result.agent.status ?? 'unknown'}`,
      ...notes,
    ].join(' ')
    return
  }

  if (typeof controller.events === 'function' || typeof controller.inspect === 'function') {
    try {
      const events = await readEvents(controller, stored.sessionId)
      check.ok = true
      check.detail = [
        `sessionId=${stored.sessionId}`,
        `events=${events.length}`,
        '无 resolveAgent，用冷读替代 resume',
        ...notes,
      ].join(' ')
    } catch (error) {
      check.error = errorText(error)
    }
    return
  }

  check.error = 'sessionController 没有 resolveAgent / events 入口，无法验证 resume'
}

function readBaseline(filePath) {
  if (!existsSync(filePath)) return null
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.tools)
      ? parsed.tools
      : undefined
  if (list === undefined) {
    throw new Error(`基线格式无效（应为字符串数组或 { "tools": [...] }）：${filePath}`)
  }
  return [...new Set(list.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))]
}

function actualToolNames(ctx, agent) {
  const registry = ctx.get('tools')
  if (!registry) throw new Error('ctx.get("tools") 不可用，无法读取已注册工具')
  let definitions
  if (typeof registry.definitions === 'function') definitions = registry.definitions(agent)
  else if (Array.isArray(registry.definitions)) definitions = registry.definitions
  else throw new Error('tools.definitions() 不可用：当前 DSH 版本无法枚举已注册工具')

  if (!Array.isArray(definitions)) throw new Error('tools.definitions() 未返回数组')
  return definitions
    .map((definition) => (typeof definition === 'string' ? definition : definition?.name))
    .filter((name) => typeof name === 'string' && name !== '')
}

function checkInventory(ctx, options, check, agent) {
  let expected
  try {
    expected = readBaseline(options.baselinePath)
  } catch (error) {
    check.error = errorText(error)
    return
  }

  if (expected === null) {
    check.ok = true
    check.detail = `基线文件不存在，跳过：${options.baselinePath}`
    return
  }

  let actual
  try {
    actual = actualToolNames(ctx, agent)
  } catch (error) {
    check.error = errorText(error)
    return
  }

  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !actualSet.has(name))
  const extra = actual.filter((name) => !expectedSet.has(name))

  check.ok = missing.length === 0
  check.error =
    missing.length === 0
      ? ''
      : `缺少预期工具：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` …(+${missing.length - 20})` : ''}`
  check.detail = [
    `expected=${expected.length}`,
    `actual=${actualSet.size}`,
    `missing=${missing.length}`,
    `extra=${extra.length}`,
    extra.length > 0
      ? `（多出：${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ' …' : ''}）`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Expected services vs `ctx.get(name)`.
 *
 * Covers plugins that register a Service instead of tools. A plugin whose
 * `apply()` throws never registers its service, so the key stops resolving —
 * that is the observable signal. Tools alone miss these plugins entirely.
 */
function readServiceBaseline(filePath) {
  if (!existsSync(filePath)) return null
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.services)
      ? parsed.services
      : undefined
  if (list === undefined) {
    throw new Error(`服务基线格式无效（应为字符串数组或 { "services": [...] }）：${filePath}`)
  }
  return [
    ...new Set(
      list
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim()),
    ),
  ]
}

function checkServiceInventory(ctx, options, check) {
  let expected
  try {
    expected = readServiceBaseline(options.serviceBaselinePath)
  } catch (error) {
    check.error = errorText(error)
    return
  }

  if (expected === null) {
    check.ok = true
    check.detail = `基线文件不存在，跳过：${options.serviceBaselinePath}`
    return
  }

  const missing = []
  for (const key of expected) {
    let present = false
    try {
      present = ctx.get(key) != null
    } catch {
      present = false
    }
    if (!present) missing.push(key)
  }

  check.ok = missing.length === 0
  check.error =
    missing.length === 0
      ? ''
      : `缺少预期服务：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` …(+${missing.length - 20})` : ''}`
  check.detail = `expected=${expected.length} missing=${missing.length}${
    missing.length > 0 ? ` missingKeys=${missing.join(',')}` : ''
  }`
}

/**
 * Plugin heartbeats: covers plugins that register neither tools nor services.
 *
 * A script-only plugin (for example a tool-result post-processor) leaves no
 * trace in either inventory. It proves itself by writing a heartbeat carrying
 * `process.pid` at the end of `apply()`. A heartbeat from a different pid means
 * the plugin did not mount during this boot.
 */
function checkHeartbeats(options, check) {
  const dir = options.heartbeatDir
  let files = []
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
  } catch {
    files = []
  }

  if (files.length === 0) {
    check.ok = true
    check.detail = `没有插件心跳（${dir}），跳过`
    return
  }

  const alive = []
  const stale = []
  for (const file of files) {
    let payload
    try {
      payload = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      stale.push(`${file}（不可解析）`)
      continue
    }
    const label = typeof payload?.name === 'string' && payload.name !== '' ? payload.name : file
    if (Number(payload?.pid) === process.pid) alive.push(label)
    else stale.push(`${label}(pid=${payload?.pid ?? '?'})`)
  }

  check.ok = stale.length === 0
  check.error =
    stale.length === 0
      ? ''
      : `这些插件的心跳来自其它进程，本次启动未挂载：${stale.join(', ')}`
  check.detail = `alive=${alive.length} stale=${stale.length} pid=${process.pid}${
    alive.length > 0 ? ` aliveNames=${alive.join(',')}` : ''
  }`
}

function writeProbeResult(options, result) {
  const fileName = `probe-${safeTimestamp(result.ts)}.json`
  const filePath = path.join(options.ownshieldDir, fileName)
  writeJsonAtomic(filePath, {
    ok: result.ok,
    ts: result.ts,
    checks: result.checks,
    durationMs: result.durationMs,
    // 只告警类检查（当前是 auth-gate）的提示，非空才写，避免污染既有字段。
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    // 用完即清的实况：会话是否已归档、临时目录是否已删。事后可查「有没有真清干净」。
    ...(result.cleanup ? { cleanup: result.cleanup } : {}),
  })
  return filePath
}

/**
 * 探针用完即清：小用户不该在侧栏看到自检留下的会话，也不该让临时目录堆积。
 *
 * DSH 没有「删除会话」的 Host API，能用的隐藏手段是归档——`archiveSession`
 * 把会话放进 `archivedSessionIds`，侧栏默认不显示。再加删掉 mkdtemp 出来的 cwd。
 * 任何一步失败都只记进 `cleanup.errors`，绝不影响探针结论（探测是主职，清洁是附带）。
 */
export async function cleanupProbeSession(ctx, { sessionId, cwd }) {
  const cleanup = { sessionId: sessionId || '', archived: false, tmpRemoved: false, errors: [] }

  if (sessionId) {
    let registry = null
    try {
      registry = ctx.get('workspaceRegistry') || ctx.get('workspaceController')
    } catch {
      registry = null
    }
    if (!registry || typeof registry.archiveSession !== 'function') {
      cleanup.errors.push('archive: workspaceRegistry.archiveSession 不可用')
    } else {
      try {
        // 兼容两种签名：registry 层 (sessionId, opts) 与 controller 层 (request)。
        await registry.archiveSession(sessionId, { stopActivity: true })
        cleanup.archived = true
      } catch (first) {
        try {
          await registry.archiveSession({ sessionId, stopActivity: true })
          cleanup.archived = true
        } catch (second) {
          cleanup.errors.push(`archive: ${errorText(second)}`)
        }
      }
    }
  }

  if (cwd) {
    try {
      rmSync(cwd, { recursive: true, force: true })
      cleanup.tmpRemoved = true
    } catch (error) {
      cleanup.errors.push(`tmp: ${errorText(error)}`)
    }
  }

  return cleanup
}

/**
 * Run all four checks and write one probe artifact.
 *
 * Throws only when the probe cannot run at all (the session controller service
 * is missing). Check-level failures are recorded in the artifact instead.
 *
 * @param ctx Cordis plugin context.
 * @param options Resolved plugin options.
 * @param agent Optional calling Agent; scopes the tool-inventory view so preset
 *   tools are visible instead of only root-registered definitions.
 */
export async function runProbe(ctx, options, agent) {
  const started = Date.now()
  const ts = new Date().toISOString()

  const controller = ctx.get('sessionController')
  if (!controller) {
    throw new Error(
      'sessionController 不可用：当前 profile 未组合 @deepseek-ai/dsh-api-session-controller，无法创建或恢复会话',
    )
  }

  const checks = []
  let created = { sessionId: '', cwd: '' }

  try {
    const createCheck = blankCheck('create-session')
    checks.push(createCheck)
    created = await checkCreate(controller, options, createCheck)
    const sessionId = created.sessionId

    const promptCheck = blankCheck('prompt-first-turn')
    checks.push(promptCheck)
    if (sessionId) {
      await checkPrompt(ctx, controller, options, sessionId, promptCheck)
    } else {
      promptCheck.error = '跳过：临时会话创建失败'
      promptCheck.detail = ''
    }

    const resumeCheck = blankCheck('resume-probe-session')
    checks.push(resumeCheck)
    await checkResume(ctx, controller, options, resumeCheck, sessionId)

    const inventoryCheck = blankCheck('tool-inventory')
    checks.push(inventoryCheck)
    checkInventory(ctx, options, inventoryCheck, agent)

    const serviceCheck = blankCheck('service-inventory')
    checks.push(serviceCheck)
    checkServiceInventory(ctx, options, serviceCheck)

    const heartbeatCheck = blankCheck('plugin-heartbeat')
    checks.push(heartbeatCheck)
    checkHeartbeats(options, heartbeatCheck)

    // 第 7 项：认证门（被动、零请求）。ok 恒 true，异常只进 warn——C 类不触发回滚。
    const authCheck = blankCheck('auth-gate')
    checks.push(authCheck)
    checkAuthGate(options, authCheck)

    // 先清理再落盘：结果文件里带上 cleanup，事后能查「到底有没有清干净」。
    const cleanup = await cleanupProbeSession(ctx, created)

    const durationMs = Date.now() - started
    const ok = checks.every((check) => check.ok)
    const warnings = checks
      .filter((check) => typeof check.warn === 'string' && check.warn.trim() !== '')
      .map((check) => `${check.name}: ${check.warn}`)
    const filePath = writeProbeResult(options, { ok, ts, checks, durationMs, warnings, cleanup })

    try {
      ctx.logger?.info?.(
        `dsh-ownshield: probe ${ok ? 'ok' : 'failed'} -> ${filePath} (${durationMs}ms)`,
      )
    } catch {
      /* logging is best effort */
    }

    const value = { ok, ts, durationMs, path: filePath, checks, cleanup }
    if (sessionId) value.sessionId = sessionId
    return value
  } catch (error) {
    // 中途抛错也要清：别把临时会话和被占用的临时目录留给用户。
    await cleanupProbeSession(ctx, created)
    throw error
  }
}
