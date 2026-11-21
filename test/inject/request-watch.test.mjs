/**
 * 触发器测试：模型请求失败 → 注入。
 *
 * 只测纯逻辑与挂载行为（假 ctx / 假 agent / 假 sessionController），
 * 不依赖 DSH 运行时；真机验证靠重启后制造一次 401。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNotice,
  classifyFailure,
  createInjectGate,
  startRequestWatch,
} from '../../lib/request-watch.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

test('classifyFailure：凭据/额度类注入，网络抖动不注入', () => {
  assert.deepEqual(
    { ...classifyFailure({ code: '401', message: 'invalid api key' }) },
    { inject: true, tier: 'credential', code: '401', detail: 'invalid api key' },
  )
  assert.equal(classifyFailure({ code: '402' }).tier, 'credential')
  assert.equal(classifyFailure({ message: 'insufficient_quota' }).tier, 'credential')
  assert.equal(classifyFailure({ code: '429', message: 'too many requests' }).tier, 'rate')
  assert.equal(classifyFailure({ code: '503', message: 'bad gateway' }).inject, false)
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).inject, false)
  assert.equal(classifyFailure(undefined).inject, false)
})

test('buildNotice：凭据类先要求自主处理，无路可走才交人', () => {
  const text = buildNotice({ provider: 'deepseek', tier: 'credential', code: '401', detail: 'bad key' })
  assert.match(text, /provider=deepseek/)
  assert.match(text, /code=401/)
  assert.match(text, /凭据或额度问题/)
  assert.match(text, /自行处理/)
  assert.match(text, /不依赖该 provider/)
  assert.match(text, /确实无路可走时/)
  assert.match(text, /不要自行修改配置/)
})

test('buildNotice：限流类优先自主，明确不打扰主人', () => {
  const text = buildNotice({ provider: 'deepseek', tier: 'rate', code: '429' })
  assert.match(text, /判定为限流/)
  assert.match(text, /自行处理/)
  assert.match(text, /不要停下来打扰主人/)
  assert.match(text, /等限流窗口/)
  assert.match(text, /只有连续失败/)
})

test('createInjectGate：同 agent 同 code 冷却内只放行一次，reset 后恢复', () => {
  let clock = 1000
  const gate = createInjectGate({ cooldownMs: 500, now: () => clock })
  assert.equal(gate.admit('s1', '401'), true)
  assert.equal(gate.admit('s1', '401'), false)
  assert.equal(gate.admit('s1', '429'), true, '不同 code 独立计')
  assert.equal(gate.admit('s2', '401'), true, '不同 agent 独立计')
  clock += 600
  assert.equal(gate.admit('s1', '401'), true, '冷却过后重新放行')
  gate.reset('s1')
  assert.equal(gate.size(), 1, '只清掉 s1 的记录')
})

test('startRequestWatch：失败即投递，冷却内不重复，成功产出后解冻', async () => {
  const prompts = []
  const handlers = new Map()
  const service = {
    async prompt(request) {
      prompts.push(request)
      return { ok: true }
    },
  }
  const ctx = {
    logger: { info() {} },
    get: (name) => (name === 'sessionController' ? service : undefined),
    on(type, handler) {
      handlers.set(`ctx:${type}`, handler)
      return () => handlers.delete(`ctx:${type}`)
    },
  }
  const agentHandlers = new Map()
  const agent = {
    id: 'session-x',
    ctx: {
      on(type, handler) {
        agentHandlers.set(type, handler)
        return () => agentHandlers.delete(type)
      },
    },
  }

  startRequestWatch(ctx, { requestWatchCooldownMs: 600_000, deliverTimeoutMs: 5000, timeZone: 'Asia/Shanghai' })
  handlers.get('ctx:agent/created')({ agent })

  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(undefined)
  }

  // 第一次 401：注入，且把 next() 交还下游。
  await agentHandlers.get('agent/request-error')({ provider: 'deepseek', failure: { code: '401' } }, next)
  await flush()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'session-x')
  assert.equal(prompts[0].mode, 'queue')
  assert.match(prompts[0].content[0].text, /code=401/)
  assert.equal(nextCalls, 1, 'waterfall 必须继续下游')

  // 冷却内第二次：不注入，但 next 仍然交还。
  await agentHandlers.get('agent/request-error')({ provider: 'deepseek', failure: { code: '401' } }, next)
  await flush()
  assert.equal(prompts.length, 1)
  assert.equal(nextCalls, 2)

  // 网络抖动：本来就不注入，也不消耗冷却。
  await agentHandlers.get('agent/request-error')({ provider: 'deepseek', failure: { code: '503' } }, next)
  await flush()
  assert.equal(prompts.length, 1)

  // 会话成功产出：冷却清零，下一次失败重新注入。
  agentHandlers.get('session/event')({}, { type: 'assistant/message' })
  await agentHandlers.get('agent/request-error')({ provider: 'deepseek', failure: { code: '401' } }, next)
  await flush()
  assert.equal(prompts.length, 2)
})

test('startRequestWatch：开关关掉就完全不挂监听', () => {
  let registered = 0
  const ctx = {
    on() {
      registered += 1
      return () => {}
    },
  }
  const off = startRequestWatch(ctx, { requestWatchEnabled: false })
  assert.equal(registered, 0)
  assert.equal(typeof off, 'function')
})

test('startRequestWatch：sessionController 未就绪时不抛错也不投递', async () => {
  const handlers = new Map()
  const ctx = {
    logger: { info() {} },
    get: () => undefined,
    on(type, handler) {
      handlers.set(`ctx:${type}`, handler)
      return () => {}
    },
  }
  const agentHandlers = new Map()
  const agent = { id: 'session-y', ctx: { on(type, handler) { agentHandlers.set(type, handler); return () => {} } } }
  startRequestWatch(ctx, { deliverTimeoutMs: 1000 })
  handlers.get('ctx:agent/created')({ agent })
  await agentHandlers.get('agent/request-error')({ provider: 'x', failure: { code: '401' } }, () => Promise.resolve())
  await flush()
})
