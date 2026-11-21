/**
 * 触发器：模型请求失败 → 立刻把这条信息注入回同一个会话。
 *
 * 为什么不轮询：探针里 `auth-gate` 的告警写在 `probe-*.json` 里，等看门狗下一分钟
 * 去读，本身就是摆渡。DSH 在请求失败那一刻就派发 `agent/request-error`（waterfall，
 * 载荷 `{ turn, step, provider, failure, retryPolicy, signal }`），`dsh-llm-retry`
 * 就是挂在这个事件上决定重试的。我们挂同一个事件，命中致命失败码时直接
 * `sessionController.prompt` 注入一条信息——事件即注入，中间没有 pending 文件、
 * 没有周期扫描、没有「通知系统」。
 *
 * 边界（2026-11-21 主人定）：模型能正常调用是底线。凭据/额度/限流失败后自动重试
 * 无意义，所以注入的文本要求模型**先告知主人再停下**，不要反复打同一个 provider。
 * 同一 agent + 同一失败码在冷却窗口内只注入一次，避免 401 把会话刷成死循环；
 * 一旦该会话成功产出 `assistant/message`，冷却立即清零（恢复了就该继续正常工作）。
 */

/** 致命/准致命失败码：注入；其余（网络抖动、5xx）交给 dsh-llm-retry 自己重试。 */
export const CREDENTIAL_PATTERN =
  /401|402|403|invalid.?api.?key|unauthor|insufficient|quota|credential|authentication|permission/i
export const RATE_PATTERN = /429|rate.?limit|too.?many.?requests/i

/**
 * 判定一次失败要不要注入。
 * @param {object} failure `agent/request-error` 载荷里的 failure（LlmFailure）。
 * @returns {{ inject: boolean, tier: 'credential'|'rate'|'other', code: string, detail: string }}
 */
export function classifyFailure(failure) {
  const code = String(
    failure?.code ?? failure?.kind ?? failure?.type ?? failure?.status ?? '',
  ).trim()
  const detail = String(failure?.message ?? failure?.detail ?? failure?.reason ?? '').trim()
  const hay = `${code} ${detail}`
  if (CREDENTIAL_PATTERN.test(hay)) return { inject: true, tier: 'credential', code, detail }
  if (RATE_PATTERN.test(hay)) return { inject: true, tier: 'rate', code, detail }
  return { inject: false, tier: 'other', code, detail }
}

/**
 * 注入文本。分档给动作，且**优先要求自主处理**：
 * 只有凭据/额度这类模型无权改的东西，才允许停下来交人。
 * @param {{ provider: string, tier: string, code: string, detail: string }} input
 * @returns {string}
 */
export function buildNotice({ provider, tier, code, detail }) {
  const head = `[ownshield] 上一次模型请求失败：provider=${provider || 'unknown'}，code=${code || 'unknown'}`
  const tail = detail ? `\n原始错误：${detail.slice(0, 300)}` : ''
  if (tier === 'rate') {
    return (
      `${head}，判定为限流。${tail}\n\n` +
      '请你自行处理，能解决就不要停下来打扰主人：\n' +
      '1. 等限流窗口过去再试，不要连续猛打同一个 provider；\n' +
      '2. 有其它可用链路或等价做法，就用它把手上任务推进完；\n' +
      '3. 只有连续失败、或窗口明显很长时才用一句话告知主人。\n\n' +
      '不要自行修改配置或凭据。'
    )
  }
  return (
    `${head}，判定为凭据或额度问题。${tail}\n\n` +
    '先按这个顺序自行处理，能自己解决的就不要停下来：\n' +
    '1. 换一条不依赖该 provider 的可行做法，把手上任务推进完（现有工具、缓存、已配置的其它模型）；\n' +
    '2. 确实无路可走时，用一句话说清「卡在凭据/额度」以及需要主人做的最小动作（更新 API key、确认额度），然后等指令。\n\n' +
    '不要重复调用同一 provider，不要自行修改配置或凭据。'
  )
}

/**
 * 冷却闸：同一 agent + 同一 code 在窗口内只放行一次。
 * 成功产出（`assistant/message`）即清零，因为那说明链路已经恢复。
 * @param {{ cooldownMs?: number, now?: () => number }} [options]
 */
export function createInjectGate({ cooldownMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const lastAt = new Map()
  return {
    /** @returns {boolean} true = 可以注入 */
    admit(agentId, code) {
      const key = `${agentId}|${code}`
      const previous = lastAt.get(key)
      const at = now()
      if (previous !== undefined && at - previous < cooldownMs) return false
      lastAt.set(key, at)
      return true
    },
    /** 链路恢复后清掉该 agent 的所有冷却记录。 */
    reset(agentId) {
      const prefix = `${agentId}|`
      for (const key of [...lastAt.keys()]) if (key.startsWith(prefix)) lastAt.delete(key)
    },
    size() {
      return lastAt.size
    },
  }
}

/** 投递一条文本；形状与 lib/inject.js 的 deliver 保持一致。 */
async function promptText(service, sessionId, text, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.deliverTimeoutMs)
  try {
    return await service.prompt(
      {
        requestId: `ownshield-req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: options.timeZone,
      },
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 挂监听。返回卸载函数；任何异常都吞掉，触发器绝不能影响主流程。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {object} options resolveConfig 的结果
 * @param {object} [deps] 测试注入点（now / log / prompt）
 * @returns {() => void}
 */
export function startRequestWatch(ctx, options = {}, deps = {}) {
  if (options.requestWatchEnabled === false) return () => {}
  if (typeof ctx?.on !== 'function') return () => {}

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const gate = createInjectGate({
    cooldownMs: Number(options.requestWatchCooldownMs) || 10 * 60 * 1000,
    now,
  })
  const log = (message) => {
    try {
      if (typeof deps.log === 'function') deps.log(message)
      else ctx.logger?.info?.(`${'ownshield-inject'}: ${message}`)
    } catch {
      /* 日志失败不影响触发器 */
    }
  }

  const deliver = async (agentId, provider, classified) => {
    const text = buildNotice({ provider, ...classified })
    if (typeof deps.prompt === 'function') {
      await deps.prompt({ agentId, provider, classified, text })
      return
    }
    const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    if (!service || typeof service.prompt !== 'function') {
      log(`request-watch: sessionController 未就绪，跳过注入 agent=${agentId}`)
      return
    }
    await promptText(service, agentId, text, options)
    log(`request-watch: injected agent=${agentId} provider=${provider} code=${classified.code}`)
  }

  /** 每个 agent 创建时把两个监听挂到它的作用域上：失败即注入，成功即解冻。 */
  const offCreated = ctx.on('agent/created', ({ agent } = {}) => {
    try {
      if (!agent?.id || !agent.ctx || typeof agent.ctx.on !== 'function') return
      const offError = agent.ctx.on('agent/request-error', (payload, next) => {
        try {
          const provider = String(payload?.provider ?? 'unknown')
          const classified = classifyFailure(payload?.failure)
          if (classified.inject && gate.admit(agent.id, classified.code)) {
            // 不 await：waterfall 必须立刻把 next() 交还给下游（llm-retry 还要判重试）。
            void deliver(agent.id, provider, classified).catch((error) => {
              log(`request-watch: inject failed agent=${agent.id} ${error?.message ?? error}`)
            })
          }
        } catch {
          /* 触发器失败不得影响请求链路 */
        }
        return next()
      })
      const offSuccess = agent.ctx.on('session/event', (subject, event) => {
        try {
          if (event?.type === 'assistant/message') gate.reset(agent.id)
        } catch {
          /* 同：不影响主流程 */
        }
      })
      return () => {
        try {
          offError?.()
          offSuccess?.()
        } catch {
          /* 卸载失败忽略 */
        }
      }
    } catch {
      return
    }
  })

  return offCreated
}
