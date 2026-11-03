/**
 * Agent tools.
 *
 * The tools encode the restart protocol so a model does not have to remember
 * it: register the wake-up first, respect the mutex, refuse to restart while
 * another session is genuinely running, and validate the executable before
 * anything is killed.
 *
 * `execute(args, exec)` receives the tool execution context; `exec.agent.id`
 * is the calling session id, so nobody has to pass it in by hand.
 */

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { inspectCookieStore } from './cookie.js'
import {
  hasPending,
  listArchived,
  listPending,
  removePending,
  writePending,
} from './pending.js'
import {
  clearLock,
  environmentReport,
  listRunningSessions,
  readLock,
  readLogTail,
  scheduleRestart,
  writeLock,
} from './restart.js'
import { createLogger } from './wake.js'

const DEFAULT_WAKE_PROMPT =
  'Harness 已重启完成。请读取重启日志确认结果（末尾应为 RESULT: OK），然后继续之前未完成的工作。'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function sessionOf(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function promptOf(args) {
  return typeof args.prompt === 'string' && args.prompt.trim() !== ''
    ? args.prompt.trim()
    : DEFAULT_WAKE_PROMPT
}

/* ───────────────────────────── restart_now ───────────────────────────── */

function restartNowTool(ctx, options) {
  return {
    name: 'restart_now',
    description:
      '安排一次 Harness 重启：先登记唤醒待办（重启完成后自动回到本会话继续），再通过 Windows 计划任务在 delaySeconds 秒后重启。重启会中断本回合，所以这必须是本轮最后一步。默认拒绝在其他未登记的运行中会话存在时重启；确认安全后可传 force。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '重启完成后投递给本会话的话，写清接下来要做什么。省略时使用通用文案。',
        },
        delaySeconds: {
          type: 'number',
          description: '挂上计划任务后等多少秒再重启，默认 12（给回复和日志留时间），范围 5-300。',
        },
        force: {
          type: 'boolean',
          description: 'true 时忽略「其他未登记会话正在运行」的阻塞检查。仅在确认那些会话不怕被打断时使用。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['scheduled', 'blocked', 'busy', 'unavailable'] },
          sessionId: { type: 'string' },
          delaySeconds: { type: 'number' },
          taskName: { type: 'string' },
          wakeFile: { type: 'string' },
          commandLine: { type: 'string' },
          lockAgeSeconds: { type: 'number' },
          message: { type: 'string' },
          blockers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                cwd: { type: 'string' },
                updatedAt: { type: 'string' },
              },
              required: ['sessionId'],
            },
          },
        },
        required: ['status', 'sessionId'],
      },
      render: (args, value) => {
        if (value.status === 'scheduled') {
          return [
            {
              type: 'text',
              text: [
                `已安排在 ${value.delaySeconds} 秒后重启（任务 ${value.taskName}）。`,
                '本轮回复发出后 Harness 会退出并自动回来，然后按登记的待办唤醒本会话。',
              ].join('\n'),
            },
          ]
        }
        if (value.status === 'blocked') {
          const rows = (value.blockers ?? []).map(
            (item) => `- ${item.sessionId}${item.cwd ? `  ${item.cwd}` : ''}`,
          )
          return [
            {
              type: 'text',
              text: [
                '未重启：以下会话正在运行且没有登记唤醒待办，重启会打断它们。',
                ...rows,
                '先等它们收尾/登记，或确认可以打断后传 force: true。',
              ].join('\n'),
            },
          ]
        }
        if (value.status === 'busy') {
          return [
            {
              type: 'text',
              text: `未重启：另一个会话 ${Math.round(value.lockAgeSeconds ?? 0)} 秒前已经安排了重启，正在等它执行。`,
            },
          ]
        }
        return [{ type: 'text', text: value.message ?? '未重启。' }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = sessionOf(exec)
      if (!sessionId) throw new Error('无法确定当前会话 id（工具执行上下文缺少 agent），不能安全登记唤醒。')

      const log = createLogger(ctx, options)
      const delaySeconds = clamp(args.delaySeconds, 5, 300, options.delaySeconds)
      const force = args.force === true

      // 1) Mutex. A lock only means "one restart at a time"; a stale lock means
      //    the previous attempt died halfway and may be cleared.
      const lock = readLock(options.lockPath, options.lockStaleMs)
      if (lock.held && !lock.stale) {
        return {
          status: 'busy',
          sessionId,
          lockAgeSeconds: Math.round(lock.ageMs / 1000),
        }
      }
      if (lock.held && lock.stale) {
        log(`stale-lock-cleared ageMs=${lock.ageMs}`)
        clearLock(options.lockPath)
      }

      // 2) Blocked sessions. A running session that already registered is
      //    considered finished: it asked to be killed and woken up again.
      const running = await listRunningSessions(ctx)
      if (!running.available && !force) {
        return {
          status: 'unavailable',
          sessionId,
          message: `无法读取会话列表（${running.error ?? '未知原因'}），不能确认没有别的会话在跑。确认安全后可传 force: true。`,
        }
      }
      const blockers = running.sessions.filter(
        (item) => item.sessionId !== sessionId && !hasPending(options.pendingDir, item.sessionId),
      )
      if (blockers.length > 0 && !force) {
        return {
          status: 'blocked',
          sessionId,
          blockers,
        }
      }

      // 3) Register the wake-up before anything is killed. The file must exist
      //    when the new Host starts scanning; writing it afterwards is too late.
      const prompt = promptOf(args)
      const hadPending = hasPending(options.pendingDir, sessionId)
      const wakeFile = writePending(options.pendingDir, sessionId, prompt)

      // 4) Claim the mutex, then schedule. Roll everything back on failure so a
      //    later restart does not wake a session whose restart never happened.
      writeLock(options.lockPath, sessionId)
      try {
        const scheduled = await scheduleRestart(options, { delaySeconds })
        log(`scheduled session=${sessionId} delay=${delaySeconds}s task=${scheduled.taskName}`)
        return {
          status: 'scheduled',
          sessionId,
          delaySeconds,
          taskName: scheduled.taskName,
          wakeFile,
          commandLine: scheduled.commandLine,
        }
      } catch (error) {
        clearLock(options.lockPath)
        // Only remove the entry this call created; a previous registration the
        // session made deliberately must survive a failed schedule attempt.
        if (!hadPending) removePending(options.pendingDir, sessionId)
        log(`schedule-failed session=${sessionId} ${errorText(error)}`)
        throw new Error(`调度重启失败：${errorText(error)}`)
      }
    },
  }
}

/* ───────────────────────────── wake_register ───────────────────────────── */

function wakeRegisterTool(ctx, options) {
  return {
    name: 'wake_register',
    description:
      '只登记唤醒待办、不重启：本会话收尾后，等别的会话执行重启时把我也叫醒。登记即表示本轮可以被打断，登记后不要再做长任务。要自己触发重启请改用 restart_now。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '重启完成后投递给本会话的话。省略时使用通用文案。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['registered'] },
          sessionId: { type: 'string' },
          wakeFile: { type: 'string' },
        },
        required: ['status', 'sessionId', 'wakeFile'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text: `已登记唤醒：${value.wakeFile}\n本轮可以收尾了，等下一次重启完成后本会话会被自动唤醒。`,
        },
      ],
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = sessionOf(exec)
      if (!sessionId) throw new Error('无法确定当前会话 id（工具执行上下文缺少 agent）。')

      const wakeFile = writePending(options.pendingDir, sessionId, promptOf(args))
      createLogger(ctx, options)(`registered session=${sessionId}`)
      return { status: 'registered', sessionId, wakeFile }
    },
  }
}

/* ─────────────────────────────── wake_list ─────────────────────────────── */

function wakeListTool(options) {
  return {
    name: 'wake_list',
    description:
      '查看唤醒登记表：当前待唤醒的会话、最近处理过的归档、以及重启互斥锁的状态。用于判断「谁在等重启」「上次唤醒成功没有」。',
    parameters: {
      type: 'object',
      properties: {
        archived: {
          type: 'number',
          description: '最多列出多少条历史归档，默认 10，范围 1-50。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          pending: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                sessionId: { type: 'string' },
                createdAt: { type: 'string' },
                error: { type: 'string' },
              },
              required: ['file'],
            },
          },
          archived: { type: 'array', items: { type: 'string' } },
          lock: {
            type: 'object',
            properties: {
              held: { type: 'boolean' },
              stale: { type: 'boolean' },
              ageSeconds: { type: 'number' },
            },
            required: ['held', 'stale', 'ageSeconds'],
          },
        },
        required: ['pending', 'archived', 'lock'],
      },
      render: (args, value) => {
        const lines = []
        if (value.pending.length === 0) {
          lines.push('当前没有待唤醒登记。')
        } else {
          lines.push(`${value.pending.length} 条待唤醒登记：`)
          for (const item of value.pending) {
            lines.push(`- ${item.sessionId || item.file}  ${item.createdAt || ''}${item.error ? `  (损坏：${item.error})` : ''}`)
          }
        }
        lines.push(
          value.lock.held
            ? `重启锁：持有中（${value.lock.ageSeconds} 秒${value.lock.stale ? '，已过期，可覆盖' : ''}）`
            : '重启锁：空闲',
        )
        if (value.archived.length > 0) lines.push(`最近处理：${value.archived.length} 条归档`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const limit = clamp(args.archived, 1, 50, 10)
      const lock = readLock(options.lockPath, options.lockStaleMs)
      return {
        pending: listPending(options.pendingDir).map((entry) => ({
          file: basename(entry.file),
          sessionId: entry.task?.sessionId ?? '',
          createdAt: entry.task?.createdAt ?? '',
          error: entry.error ?? '',
        })),
        archived: listArchived(options.pendingDir, limit).map((file) => basename(file)),
        lock: { held: lock.held, stale: lock.stale, ageSeconds: Math.round(lock.ageMs / 1000) },
      }
    },
  }
}

/* ────────────────────────────── wake_cancel ────────────────────────────── */

function wakeCancelTool(ctx, options) {
  return {
    name: 'wake_cancel',
    description:
      '取消本会话的唤醒登记。用于「不重启了」或「已经醒过来，不想再被叫一次」。只删本会话自己的登记，不动别人的。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['cancelled', 'not-found'] },
          sessionId: { type: 'string' },
        },
        required: ['status', 'sessionId'],
      },
      render: (args, value) => [
        {
          type: 'text',
          text:
            value.status === 'cancelled'
              ? '已取消本会话的唤醒登记。'
              : '本会话没有待唤醒登记，无需取消。',
        },
      ],
    },
    async execute(rawArgs, exec) {
      const sessionId = sessionOf(exec)
      if (!sessionId) throw new Error('无法确定当前会话 id（工具执行上下文缺少 agent）。')
      const removed = removePending(options.pendingDir, sessionId)
      createLogger(ctx, options)(`${removed ? 'cancelled' : 'cancel-miss'} session=${sessionId}`)
      return { status: removed ? 'cancelled' : 'not-found', sessionId }
    },
  }
}

/* ───────────────────────────── restart_status ───────────────────────────── */

function restartStatusTool(ctx, options) {
  return {
    name: 'restart_status',
    description:
      '查看重启环境与状态：可执行文件/脚本路径是否有效、重启锁、待唤醒登记、运行中的会话，以及重启日志末尾。重启前用它自检，重启后用它验收。',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: '返回日志末尾多少行，默认 20，范围 1-200。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          exePath: { type: 'string' },
          exeExists: { type: 'boolean' },
          processName: { type: 'string' },
          scriptExists: { type: 'boolean' },
          commandExists: { type: 'boolean' },
          pendingDir: { type: 'string' },
          logPath: { type: 'string' },
          taskName: { type: 'string' },
          cookieProbeExists: { type: 'boolean' },
          cookieDbExists: { type: 'boolean' },
          lock: {
            type: 'object',
            properties: {
              held: { type: 'boolean' },
              stale: { type: 'boolean' },
              ageMs: { type: 'number' },
            },
            required: ['held', 'stale', 'ageMs'],
          },
          runningAvailable: { type: 'boolean' },
          running: {
            type: 'array',
            items: {
              type: 'object',
              properties: { sessionId: { type: 'string' }, cwd: { type: 'string' } },
              required: ['sessionId'],
            },
          },
          pendingCount: { type: 'number' },
          logTail: { type: 'array', items: { type: 'string' } },
        },
        required: ['platform', 'exePath', 'exeExists', 'pendingDir', 'runningAvailable', 'pendingCount'],
      },
      render: (args, value) => {
        const lines = [
          `平台：${value.platform}`,
          `可执行文件：${value.exePath || '(未探测到)'}${value.exeExists ? '' : '  ⚠ 不存在'}`,
          `重启脚本：${value.scriptExists ? '就绪' : '⚠ 缺失'}；计划任务入口：${value.commandExists ? '就绪' : '⚠ 缺失'}`,
          `登记目录：${value.pendingDir}`,
          `重启锁：${value.lock.held ? `持有 ${Math.round(value.lock.ageMs / 1000)} 秒${value.lock.stale ? '（已过期）' : ''}` : '空闲'}`,
          `待唤醒：${value.pendingCount} 条`,
        ]
        if (!value.runningAvailable) lines.push('运行中会话：无法读取（sessionController 未组合）')
        else if (value.running.length === 0) lines.push('运行中会话：无')
        else lines.push(`运行中会话：${value.running.map((item) => item.sessionId).join(', ')}`)
        if (value.logTail.length > 0) {
          lines.push('日志末尾：')
          for (const line of value.logTail) lines.push(`  ${line}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const lines = clamp(args.lines, 1, 200, 20)
      const env = environmentReport(options)
      const running = await listRunningSessions(ctx)
      return {
        ...env,
        runningAvailable: running.available,
        running: running.sessions.map((item) => ({ sessionId: item.sessionId, cwd: item.cwd })),
        pendingCount: listPending(options.pendingDir).length,
        logTail: readLogTail(options.logPath, lines),
      }
    },
  }
}

/* ───────────────────────────── cookie_status ───────────────────────────── */

function cookieStatusTool(options) {
  return {
    name: 'cookie_status',
    description:
      '检查 dsh-auth-* cookie 堆积情况——Harness 桌面端「重启约 70 次后启动报 Web authentication failed」的根因。返回数量、估算请求头大小与清理阈值；Harness 运行时 cookie 库被独占，通常读不到，此时重启窗口会自动清理超阈值残留。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          reason: { type: 'string' },
          message: { type: 'string' },
          dbPath: { type: 'string' },
          authCount: { type: 'number' },
          totalCount: { type: 'number' },
          headerBytes: { type: 'number' },
          headerLimitBytes: { type: 'number' },
          threshold: { type: 'number' },
          cleanupExists: { type: 'boolean' },
        },
        required: ['available', 'dbPath', 'threshold', 'cleanupExists'],
      },
      render: (args, value) => {
        const lines = [`cookie 库：${value.dbPath || '(未配置)'}`]
        if (value.available) {
          const kb = Math.round((value.headerBytes ?? 0) / 1024)
          lines.push(`dsh-auth-*：${value.authCount} 条，估算请求头约 ${kb} KB（上限 16 KB）`)
          lines.push(`其它 cookie：${(value.totalCount ?? 0) - value.authCount} 条（不会被动）`)
          lines.push(
            value.authCount >= value.threshold
              ? `已超过阈值 ${value.threshold}：下次重启会在可读窗口自动清理。`
              : `低于阈值 ${value.threshold}：下次重启不会清理。`,
          )
        } else if (value.reason === 'locked') {
          lines.push('无法读取：Harness 正在运行，cookie 库被独占。')
          lines.push(`重启窗口会自动清理超过 ${value.threshold} 条的 dsh-auth-* 残留。`)
        } else {
          lines.push(
            `无法读取：${value.reason}${value.message ? ` - ${value.message}` : ''}`,
          )
        }
        if (!value.cleanupExists) lines.push('⚠ 清理脚本缺失，重启时不会自动清理。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const info = inspectCookieStore(options.cookieDbPath)
      return {
        ...info,
        threshold: options.cookieThreshold,
        cleanupExists: existsSync(options.cookieCleanupPath),
      }
    },
  }
}

/* ──────────────────────────────── entry ──────────────────────────────── */

/**
 * Build all six tools. Registration happens in `index.js` so each tool gets
 * its own `ctx.effect` cleanup.
 */
export function createTools(ctx, options) {
  return [
    restartNowTool(ctx, options),
    wakeRegisterTool(ctx, options),
    wakeListTool(options),
    wakeCancelTool(ctx, options),
    restartStatusTool(ctx, options),
    cookieStatusTool(options),
  ]
}
