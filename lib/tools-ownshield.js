/**
 * The Agent tools: `ownshield_probe` plus the P1 tool face —
 * `ownshield_snapshot`, `ownshield_arm`, `ownshield_disarm`, `ownshield_status`.
 *
 * Every tool must declare both `output.schema` and `output.render`. Missing
 * either one fails the whole registration batch, so this file keeps them
 * together with `parameters` and `execute`.
 *
 * Subprocess output is captured through file descriptors (`stdio: ['ignore',
 * outFd, errFd]`), never pipes: under the DSH sandbox a piped stdio raises
 * EPERM and the caller sees empty output.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveNodeRuntime } from './node-runtime.js'
import { runProbe } from './probe.js'

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
    detail: { type: 'string' },
    // 只告警类检查（当前是 auth-gate）：不参与 ok 判定，不会触发回滚。
    warn: { type: 'string' },
    // 结构化标记：本地 Web 登录 cookie 已过寿命。watch 靠它决定「只重启、不回滚」。
    cookieStale: { type: 'boolean' },
  },
  required: ['name', 'ok', 'error', 'detail'],
  additionalProperties: false,
}

function probeTool(ctx, options) {
  return {
    name: 'ownshield_probe',
    description:
      '运行 DSH 本体功能探针（只检测、不修复）：用默认预设创建临时会话并发一条 probe、等首轮 settled（默认 60 秒），对固定探针会话执行一次 resume，再把预期工具清单（~/.dsh/ownshield/tool-baseline.json，不存在则跳过）和实际注册工具比对。结果写入 ~/.dsh/ownshield/probe-<时间戳>.json，返回 ok、各检查项、耗时与文件路径。用于发现「DSH 启动了但会话跑不动 / 工具静默消失」这类不写 crash log 的故障。',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description:
            '单步超时：创建会话与等待首轮 settled 的上限，默认 60000，范围 5000-300000。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          ts: { type: 'string' },
          durationMs: { type: 'number' },
          path: { type: 'string' },
          sessionId: { type: 'string' },
          checks: {
            type: 'array',
            items: CHECK_SCHEMA,
          },
        },
        required: ['ok', 'ts', 'durationMs', 'path', 'checks'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [
          `ownshield 探针${value.ok ? '通过' : '失败'}（${value.durationMs}ms）`,
        ]
        for (const check of value.checks ?? []) {
          const mark = check.ok ? '✓' : '✗'
          const notes = [check.error, check.detail].filter(Boolean).join('；')
          const warn = typeof check.warn === 'string' && check.warn.trim() !== '' ? `（告警：${check.warn}）` : ''
          lines.push(`${mark} ${check.name}${notes ? `：${notes}` : ''}${warn}`)
        }
        lines.push(`结果文件：${value.path}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const timeoutMs = clamp(args.timeoutMs, 5000, 300000, options.probeTimeoutMs)
      const effective =
        timeoutMs === options.probeTimeoutMs
          ? options
          : {
              ...options,
              probeTimeoutMs: timeoutMs,
              resumeTimeoutMs: Math.min(options.resumeTimeoutMs, timeoutMs),
            }

      return runProbe(ctx, effective, exec?.agent)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* P1 tool face: snapshot / arm / disarm / status                             */
/* -------------------------------------------------------------------------- */

const TMP_DIR = path.join(os.tmpdir(), 'ownshield-tool')

function scriptPath(options, name) {
  const dir =
    typeof options.scriptsDir === 'string' && options.scriptsDir !== ''
      ? options.scriptsDir
      : path.join(options.pluginDir, 'scripts', 'ownshield')
  return path.join(dir, name)
}

/** Run one recovery-chain script and parse its JSON stdout. */
function runScript(options, name, args, timeoutMs) {
  const script = scriptPath(options, name)
  if (!fs.existsSync(script)) {
    throw new Error(
      `ownshield 脚本缺失：${script}。当前 scriptsDir="${options.scriptsDir || ''}"；开发环境请把它指向 <repo>/tools/ownshield。`,
    )
  }
  const runtime = resolveNodeRuntime()
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const base = path.join(TMP_DIR, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const outFile = `${base}.out`
  const errFile = `${base}.err`
  const outFd = fs.openSync(outFile, 'w')
  const errFd = fs.openSync(errFile, 'w')
  // 2.0 合并：看门狗脚本只认环境变量 OWNSHIELD_PROC_NAME（arm/watch/snapshot 都是），
  // processName 则由重启侧配置驱动。合并后在这里把启动方进程名注入给脚本，脚本零改。
  const procName = typeof options.processName === 'string' ? options.processName.trim() : ''
  const env = { ...process.env, ...runtime.env }
  if (procName !== '') env.OWNSHIELD_PROC_NAME = procName
  let result
  try {
    result = spawnSync(runtime.file, [script, ...args], {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs,
      windowsHide: true,
      env,
    })
  } finally {
    fs.closeSync(outFd)
    fs.closeSync(errFd)
  }
  let stdout = ''
  let stderr = ''
  try {
    stdout = fs.readFileSync(outFile, 'utf8')
    stderr = fs.readFileSync(errFile, 'utf8')
  } catch {
    /* unreadable capture is reported as empty output below */
  }
  try {
    fs.unlinkSync(outFile)
    fs.unlinkSync(errFile)
  } catch {
    /* temp cleanup must never hide the result */
  }
  if (result.error) throw new Error(`执行 ${name} 失败：${result.error.message}`)
  let value = null
  try {
    value = JSON.parse(stdout.trim())
  } catch {
    const start = stdout.search(/[[{]/)
    if (start >= 0) {
      try {
        value = JSON.parse(stdout.slice(start))
      } catch {
        value = null
      }
    }
  }
  if (!value || typeof value !== 'object') {
    throw new Error(
      `${name} 未返回 JSON（exit=${result.status}）：${(stdout || stderr).trim().slice(-500)}`,
    )
  }
  return { status: result.status, value, stderr }
}

const ARM_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    ok: { type: 'boolean' },
    detail: { type: 'string' },
  },
  required: ['name', 'ok', 'detail'],
}

const ARM_TASK_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    exists: { type: 'boolean' },
    created: { type: 'boolean' },
    command: { type: 'string' },
  },
  required: ['name', 'exists', 'created', 'command'],
}

function snapshotTool(options) {
  return {
    name: 'ownshield_snapshot',
    description:
      '给 DSH 本体内核建内容寻址快照（默认对象是安装目录的 app.asar，可选用 withProfile 纳入 profile 层）。改 src/、asar 或内核文件之前先调它；建完把返回的 tag 交给 ownshield_arm。返回 tag、sha256、文件数、blob 数与快照库物理占用。',
    parameters: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: '快照名，也是武装时用的 tag。取简短可辨识的词，例如 before-asar-1121。',
        },
        withProfile: {
          type: 'boolean',
          description: 'true 时把 profile 层（cordis.patch.yml、预设目录、插件链接表）一起纳入快照。默认 false。',
        },
      },
      required: ['tag'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          skipped: { type: 'boolean' },
          tag: { type: 'string' },
          snapshot: { type: 'string' },
          dir: { type: 'string' },
          sha256: { type: 'string' },
          files: { type: 'number' },
          bytes: { type: 'number' },
          blobs: { type: 'number' },
          blobBytes: { type: 'number' },
          storeBytes: { type: 'number' },
          blobsAdded: { type: 'number' },
          blobsReused: { type: 'number' },
          archiveError: { type: 'string' },
        },
        required: [
          'ok',
          'skipped',
          'tag',
          'snapshot',
          'dir',
          'sha256',
          'files',
          'bytes',
          'blobs',
          'blobBytes',
          'storeBytes',
          'blobsAdded',
          'blobsReused',
          'archiveError',
        ],
      },
      render: (_args, value) => {
        const lines = [
          value.skipped ? `快照未新建（同内容已存在）：${value.tag}` : `快照已创建：${value.tag}`,
          `快照目录：${value.dir}`,
          `sha256：${value.sha256}`,
          `内容：${value.files} 个文件 / ${value.bytes} 字节`,
          `blob：${value.blobs} 个共 ${value.blobBytes} 字节；快照库物理占用 ${value.storeBytes} 字节`,
          `本轮 blob：新增 ${value.blobsAdded} / 复用 ${value.blobsReused}`,
        ]
        if (value.archiveError) lines.push(`告警：asar 解析失败（快照仍已创建）——${value.archiveError}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const tag = typeof args.tag === 'string' ? args.tag.trim() : ''
      if (tag === '') throw new Error('ownshield_snapshot 需要 tag（快照名不能为空）。')
      const cli = ['create', '--tag', tag, ...(args.withProfile === true ? ['--with-profile'] : []), '--json']
      const { status, value } = runScript(options, 'snapshot.mjs', cli, 180000)
      if (value.ok !== true) {
        throw new Error(`快照创建失败（exit=${status}）：${value.error || value.detail || JSON.stringify(value).slice(0, 300)}`)
      }
      return {
        ok: true,
        skipped: value.skipped === true,
        tag: typeof value.tag === 'string' ? value.tag : tag,
        snapshot: typeof value.snapshot === 'string' ? value.snapshot : '',
        dir: typeof value.dir === 'string' ? value.dir : '',
        sha256: typeof value.sourceSha256 === 'string' ? value.sourceSha256 : '',
        files: Number(value.files) || 0,
        bytes: Number(value.bytes) || 0,
        blobs: Number(value.blobs) || 0,
        blobBytes: Number(value.blobBytes) || 0,
        storeBytes: Number(value.storeBytes) || 0,
        blobsAdded: Number(value.blobsAdded) || 0,
        blobsReused: Number(value.blobsReused) || 0,
        archiveError: typeof value.archiveError === 'string' ? value.archiveError : '',
      }
    },
  }
}

function armTool(options) {
  return {
    name: 'ownshield_arm',
    description:
      '武装看门狗：先检查快照存在、快照闸通过、DSH 主进程存在，再写 arm.json 并（幂等）创建每分钟一次的 ownshield-watch 计划任务。武装后如果改内核把 DSH 改坏，看门狗会自动回滚、重启并校验。只在真的要动 src/、asar 或内核时调用；平时不要武装。前置检查不过会返回 ok:false 与逐项 problems。',
    parameters: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: '要用作回滚点的快照 tag（必须先由 ownshield_snapshot 建好）。',
        },
        notifySessionId: {
          type: 'string',
          description: '恢复成功或熔断时通报到哪个会话。省略时用当前调用会话。',
        },
        replace: {
          type: 'boolean',
          description:
            '已处于武装状态时是否覆盖既有回滚点。默认拒绝：arm.json 已存在且快照不同会直接失败，避免两个会话各自建快照后互相顶掉。确认要换回滚点再传 true。',
        },
      },
      required: ['tag'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          tag: { type: 'string' },
          armedAt: { type: 'string' },
          stateDir: { type: 'string' },
          armJson: { type: 'string' },
          armJsonWritten: { type: 'boolean' },
          armJsonRolledBack: { type: 'string' },
          task: ARM_TASK_SCHEMA,
          checks: { type: 'array', items: ARM_CHECK_SCHEMA },
          problems: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'ok',
          'dryRun',
          'tag',
          'armedAt',
          'stateDir',
          'armJson',
          'armJsonWritten',
          'task',
          'checks',
          'problems',
        ],
      },
      render: (_args, value) => {
        const lines = [
          value.ok ? `武装成功：快照 ${value.tag}` : `武装未完成：快照 ${value.tag || '(空)'}`,
          `armedAt：${value.armedAt || '(未确定)'}`,
          `arm.json：${value.armJsonWritten ? '已写入' : '未写入'}（${value.armJson}）`,
          `计划任务 ${value.task.name}：${value.task.exists ? '存在' : '不存在'}；本轮创建 ${value.task.created ? '是' : '否'}`,
        ]
        if (value.armJsonRolledBack) {
          lines.push(
            `arm.json 已回滚到失败留档：${value.armJsonRolledBack}（没有计划任务就不保留武装态）`,
          )
        }
        for (const check of value.checks ?? []) {
          lines.push(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`)
        }
        for (const problem of value.problems ?? []) lines.push(`! ${problem}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const tag = typeof args.tag === 'string' ? args.tag.trim() : ''
      if (tag === '') throw new Error('ownshield_arm 需要 tag（先用 ownshield_snapshot 建快照）。')
      const explicit = typeof args.notifySessionId === 'string' ? args.notifySessionId.trim() : ''
      const sessionId = explicit || (typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : '')
      const cli = ['arm', '--tag', tag, '--json', '--task-name', options.watchTaskName]
      if (args.replace === true) cli.push('--replace')
      if (sessionId) cli.push('--notify-session', sessionId)
      // config.nodePath：武装时写进生成的启动器；空则由 arm.mjs 运行时探测。
      if (options.nodePath) cli.push('--node-path', options.nodePath)
      const { value } = runScript(options, 'arm.mjs', cli, 30000)
      const task = value.task && typeof value.task === 'object' ? value.task : {}
      return {
        ok: value.ok === true,
        dryRun: value.dryRun === true,
        tag: typeof value.tag === 'string' ? value.tag : tag,
        armedAt: typeof value.armedAt === 'string' ? value.armedAt : '',
        stateDir: typeof value.stateDir === 'string' ? value.stateDir : '',
        armJson: typeof value.armJson === 'string' ? value.armJson : '',
        armJsonWritten: value.armJsonWritten === true,
        armJsonRolledBack:
          typeof value.armJsonRolledBack === 'string' ? value.armJsonRolledBack : '',
        task: {
          name: typeof task.name === 'string' ? task.name : options.watchTaskName,
          exists: task.exists === true,
          created: task.created === true,
          command: typeof task.command === 'string' ? task.command : '',
        },
        checks: Array.isArray(value.checks)
          ? value.checks.map((check) => ({
              name: String(check?.name ?? ''),
              ok: check?.ok === true,
              detail: String(check?.detail ?? ''),
            }))
          : [],
        problems: Array.isArray(value.problems) ? value.problems.map((problem) => String(problem)) : [],
      }
    },
  }
}

function disarmTool(options) {
  return {
    name: 'ownshield_disarm',
    description:
      '撤防：把 arm.json 移动到 <状态目录>/disarm/ 归档，恢复「非常驻」状态。不删除计划任务（未武装时 cookie 守卫仍需每分钟运行）。恢复成功后看门狗会自动撤防；人工撤防或放弃改动时调用它。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '归档文件名里的原因，默认 manual。例如 recovered、abandoned、manual。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          wasArmed: { type: 'boolean' },
          movedTo: { type: 'string' },
          reason: { type: 'string' },
          stateDir: { type: 'string' },
        },
        required: ['ok', 'wasArmed', 'movedTo', 'reason', 'stateDir'],
      },
      render: (_args, value) => {
        const lines = [
          value.wasArmed
            ? `已撤防：arm.json 已移动到 ${value.movedTo}`
            : '未武装（arm.json 不存在），无需撤防。',
          '计划任务保留：未武装时 cookie 守卫仍需每分钟运行。',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'manual'
      const { value } = runScript(options, 'arm.mjs', ['disarm', '--reason', reason, '--json'], 20000)
      return {
        ok: value.ok === true,
        wasArmed: value.wasArmed === true,
        movedTo: typeof value.movedTo === 'string' ? value.movedTo : '',
        reason: typeof value.reason === 'string' ? value.reason : reason,
        stateDir: typeof value.stateDir === 'string' ? value.stateDir : '',
      }
    },
  }
}

const STATUS_RECOVERY_SCHEMA = {
  type: 'object',
  properties: {
    logPath: { type: 'string' },
    exists: { type: 'boolean' },
    at: { type: 'string' },
    action: { type: 'string' },
    result: { type: 'string' },
    lastLine: { type: 'string' },
  },
  required: ['logPath', 'exists', 'at', 'action', 'result', 'lastLine'],
}

const STATUS_COOKIE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    exists: { type: 'boolean' },
    lastAttemptAt: { type: 'string' },
    result: { type: 'string' },
    detail: { type: 'string' },
    backoffActive: { type: 'boolean' },
    remainingMs: { type: 'number' },
  },
  required: ['path', 'exists', 'lastAttemptAt', 'result', 'detail', 'backoffActive', 'remainingMs'],
}

function statusTool(options) {
  return {
    name: 'ownshield_status',
    description:
      '自检 ownshield 状态（只读）：是否武装、tag 与 armedAt、ownshield-watch 计划任务是否存在、快照库解析路径与旧位置告警、最近一次 recovery.log 结论、cookie 守卫退避、needs-human 交接文件。武装前用它确认前置条件，熔断后用它判断该不该再武装。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          armed: { type: 'boolean' },
          tag: { type: 'string' },
          armedAt: { type: 'string' },
          stateDir: { type: 'string' },
          armJson: { type: 'string' },
          armError: { type: 'string' },
          task: {
            type: 'object',
            properties: { name: { type: 'string' }, exists: { type: 'boolean' } },
            required: ['name', 'exists'],
          },
          snapshots: {
            type: 'object',
            properties: {
              dir: { type: 'string' },
              source: { type: 'string' },
              legacy: { type: 'boolean' },
              warning: { type: 'string' },
            },
            required: ['dir', 'source', 'legacy', 'warning'],
          },
          recovery: STATUS_RECOVERY_SCHEMA,
          cookieGuard: STATUS_COOKIE_SCHEMA,
          healthy: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
          expectGracefulExit: { type: 'boolean' },
          expectGracefulExitAt: { type: 'string' },
          needsHuman: {
            type: 'object',
            properties: { path: { type: 'string' }, exists: { type: 'boolean' } },
            required: ['path', 'exists'],
          },
        },
        required: [
          'ok',
          'armed',
          'tag',
          'armedAt',
          'stateDir',
          'armJson',
          'armError',
          'task',
          'snapshots',
          'recovery',
          'cookieGuard',
          'needsHuman',
        ],
      },
      render: (_args, value) => {
        const lines = []
        for (const problem of value.problems ?? []) lines.push(`⚠ ${problem}`)
        lines.push(
          value.armed ? `武装：是（tag ${value.tag}，armedAt ${value.armedAt}）` : '武装：否',
          `计划任务 ${value.task.name}：${value.task.exists ? '存在' : '不存在'}`,
          `快照库：${value.snapshots.dir}（来源 ${value.snapshots.source}）`,
        )
        if (value.expectGracefulExit) {
          lines.push(
            `主动重启标记：在（${value.expectGracefulExitAt || '无时间戳，不会被认可'}）——有它时看门狗把进程消失当正常退出、不回滚；重启完成或超过 10 分钟后自动清掉`,
          )
        }
        if (value.snapshots.warning) lines.push(value.snapshots.warning)
        lines.push(
          value.recovery.exists
            ? `最近恢复：${value.recovery.result || '无结论'} · ${value.recovery.lastLine}`
            : '最近恢复：无 recovery.log',
        )
        lines.push(
          value.cookieGuard.exists
            ? `cookie 守卫：${value.cookieGuard.result || '未记录'}${value.cookieGuard.backoffActive ? `（退避中，剩 ${Math.round(value.cookieGuard.remainingMs / 1000)} 秒）` : '（无退避）'}`
            : 'cookie 守卫：无 cookie-guard.json',
        )
        if (value.needsHuman.exists) lines.push('需要人工：needs-human.json 存在，先读它再决定是否重新武装。')
        if (!value.armed) lines.push('提示：平时不应武装；要改内核时先 ownshield_snapshot，再 ownshield_arm。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const { value } = runScript(options, 'arm.mjs', ['status', '--json', '--task-name', options.watchTaskName], 15000)
      const task = value.task && typeof value.task === 'object' ? value.task : {}
      const snapshots = value.snapshots && typeof value.snapshots === 'object' ? value.snapshots : {}
      const recovery = value.recovery && typeof value.recovery === 'object' ? value.recovery : {}
      const cookieGuard = value.cookieGuard && typeof value.cookieGuard === 'object' ? value.cookieGuard : {}
      const needsHuman = value.needsHuman && typeof value.needsHuman === 'object' ? value.needsHuman : {}
      return {
        ok: value.ok === true,
        healthy: value.healthy === true,
        problems: Array.isArray(value.problems) ? value.problems.map((item) => String(item)) : [],
        expectGracefulExit: value.expectGracefulExit === true,
        expectGracefulExitAt:
          typeof value.expectGracefulExitAt === 'string' ? value.expectGracefulExitAt : '',
        armed: value.armed === true,
        tag: typeof value.tag === 'string' ? value.tag : '',
        armedAt: typeof value.armedAt === 'string' ? value.armedAt : '',
        stateDir: typeof value.stateDir === 'string' ? value.stateDir : '',
        armJson: typeof value.armJson === 'string' ? value.armJson : '',
        armError: typeof value.armError === 'string' ? value.armError : '',
        task: {
          name: typeof task.name === 'string' ? task.name : options.watchTaskName,
          exists: task.exists === true,
        },
        snapshots: {
          dir: typeof snapshots.dir === 'string' ? snapshots.dir : '',
          source: typeof snapshots.source === 'string' ? snapshots.source : '',
          legacy: snapshots.legacy === true,
          warning: typeof snapshots.warning === 'string' ? snapshots.warning : '',
        },
        recovery: {
          logPath: typeof recovery.logPath === 'string' ? recovery.logPath : '',
          exists: recovery.exists === true,
          at: typeof recovery.at === 'string' ? recovery.at : '',
          action: typeof recovery.action === 'string' ? recovery.action : '',
          result: typeof recovery.result === 'string' ? recovery.result : '',
          lastLine: typeof recovery.lastLine === 'string' ? recovery.lastLine : '',
        },
        cookieGuard: {
          path: typeof cookieGuard.path === 'string' ? cookieGuard.path : '',
          exists: cookieGuard.exists === true,
          lastAttemptAt: typeof cookieGuard.lastAttemptAt === 'string' ? cookieGuard.lastAttemptAt : '',
          result: typeof cookieGuard.result === 'string' ? cookieGuard.result : '',
          detail: typeof cookieGuard.detail === 'string' ? cookieGuard.detail : '',
          backoffActive: cookieGuard.backoffActive === true,
          remainingMs: Number(cookieGuard.remainingMs) || 0,
        },
        needsHuman: {
          path: typeof needsHuman.path === 'string' ? needsHuman.path : '',
          exists: needsHuman.exists === true,
        },
      }
    },
  }
}

/** Build every tool this plugin registers. Probe stays first. */
export function createOwnshieldTools(ctx, options) {
  return [
    probeTool(ctx, options),
    snapshotTool(options),
    armTool(options),
    disarmTool(options),
    statusTool(options),
  ]
}
