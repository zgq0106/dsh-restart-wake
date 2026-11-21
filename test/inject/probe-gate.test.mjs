#!/usr/bin/env node
/**
 * A1 · probe-failure 生产者（lib/probe-gate.js，2.0 随 dsh-restart-wake 发布）
 *
 *   node test/inject/probe-gate.test.mjs
 *
 * 覆盖任务书要求的五项：限流生效 / 限流外触发 / 结构失败产信号 / 网络失败不产信号 / 探针超时。
 * 另外验证磁盘侧产物（probe-gate.json、probe-failure.json、inject-pending-probe.json）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROBE_INTERVAL_MS,
  classifyProbeArtifact,
  latestProbeArtifact,
  planStartupProbe,
  readProbeState,
  runProbeGate,
  shouldProbe,
  writeProbeFailure,
  writeProbeState,
} from '../../lib/probe-gate.js'
import { writeProbeRequest } from '../../index.js'

const HOURS = 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 21, 5, 0, 0)

function tmpDir(prefix = 'probe-gate') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ownshield-inject-${prefix}-`))
}

/** runProbeGate 的假依赖：一切副作用都落在内存里，便于断言「有没有写」。 */
function fakeDeps({ latest = null, state = null } = {}) {
  const calls = { state: [], failure: [], request: [], logs: [] }
  return {
    calls,
    deps: {
      readState: () => state ?? { exists: false, lastProbeAt: null, lastOutcome: '', lastReasons: [] },
      writeState: (payload) => calls.state.push(payload),
      latest: () => latest,
      writeFailure: (args) => calls.failure.push(args),
      requestProbe: (args) => calls.request.push(args),
    },
  }
}

test('限流：距上次探针 1 小时 → 直接跳过，不投递、不产信号', async () => {
  const { deps, calls } = fakeDeps({
    state: { exists: true, lastProbeAt: T0 - 1 * HOURS, lastOutcome: 'ok', lastReasons: [] },
  })
  const result = await runProbeGate({
    dir: 'C:/virtual',
    now: T0,
    probeSessionId: 'session-abc',
    deps,
    log: (m) => calls.logs.push(m),
  })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'rate-limited')
  assert.equal(calls.request.length, 0, '限流期间不得写 pending');
  assert.equal(calls.failure.length, 0, '限流期间不得产硬信号');
  assert.ok(calls.logs.some((m) => m.includes('probe-skip')))
})

test('限流外：距上次 7 小时 → 触发一次，写 pending 并记 lastProbeAt', async () => {
  const { deps, calls } = fakeDeps({
    state: { exists: true, lastProbeAt: T0 - 7 * HOURS, lastOutcome: 'ok', lastReasons: [] },
  })
  const result = await runProbeGate({
    dir: 'C:/virtual',
    now: T0,
    probeSessionId: 'session-abc',
    deps,
  })
  assert.equal(result.action, 'request')
  assert.equal(calls.request.length, 1)
  assert.equal(calls.request[0].sessionId, 'session-abc')
  assert.match(calls.request[0].prompt, /ownshield_probe/)
  assert.equal(calls.failure.length, 0)
  assert.equal(calls.state.length, 1)
  assert.equal(calls.state[0].outcome, 'requested')
})

test('限流外但没有可投递会话 → idle，绝不为了「跑起来」硬造 pending', async () => {
  const { deps, calls } = fakeDeps()
  const result = await runProbeGate({ dir: 'C:/virtual', now: T0, probeSessionId: '', deps })
  assert.equal(result.action, 'idle')
  assert.equal(calls.request.length, 0)
  assert.equal(calls.state.length, 0)
})

test('结构失败（工具清单缺失）→ 产 probe-failure 硬信号', async () => {
  const latest = {
    name: 'probe-2026-11-21T04-59-00-000Z.json',
    ts: T0 - 60_000,
    artifact: {
      ok: false,
      checks: [{ name: 'tool-inventory', ok: false, error: 'missing 3 tools: a,b,c', detail: '' }],
    },
  }
  const { deps, calls } = fakeDeps({ latest })
  const result = await runProbeGate({ dir: 'C:/virtual', now: T0, deps })
  assert.equal(result.action, 'classify')
  assert.equal(result.structural, true)
  assert.deepEqual(calls.failure[0].classification.reasons, ['inventory-missing'])
  assert.equal(calls.state[0].outcome, 'structural')
})

test('结构失败（agent-preset/invalid）→ 产信号；四类关键词都认得', async () => {
  const cases = [
    [{ name: 'session-create', ok: false, error: 'agent-preset/invalid: bad field' }, 'agent-preset/invalid'],
    [{ name: 'tool-register', ok: false, error: "Duplicate tool group 'core'" }, 'duplicate-tool-group'],
    [{ name: 'resume', ok: false, error: 'resume failed after 30s' }, 'resume-failed'],
    [{ name: 'resume', ok: false, error: 'session/not-found' }, 'session-not-found'],
  ]
  for (const [check, reason] of cases) {
    const classification = classifyProbeArtifact({ ok: false, checks: [check] })
    assert.equal(classification.structural, true, `${reason} 应判结构性失败`)
    assert.ok(classification.reasons.includes(reason), `${reason} 未命中，实际 ${classification.reasons}`)
  }
})

test('网络失败（ECONNRESET / 502 / 限流）→ 只记日志，不产硬信号', async () => {
  for (const error of ['ECONNRESET', 'HTTP 502 Bad Gateway', 'rate limited 429']) {
    const latest = {
      name: 'probe-x.json',
      ts: T0 - 60_000,
      artifact: { ok: false, checks: [{ name: 'first-turn', ok: false, error }] },
    }
    const { deps, calls } = fakeDeps({ latest })
    const result = await runProbeGate({ dir: 'C:/virtual', now: T0, deps })
    assert.equal(result.structural, false, `${error} 不该产硬信号`)
    assert.equal(calls.failure.length, 0)
    assert.notEqual(calls.state[0].outcome, 'structural')
  }
})

test('探针超时：直调挂住 → 记 timeout，不产硬信号', async () => {
  const { deps, calls } = fakeDeps()
  const never = () => new Promise(() => {})
  const result = await runProbeGate({
    dir: 'C:/virtual',
    now: T0,
    probeFn: never,
    probeTimeoutMs: 30,
    deps,
  })
  assert.equal(result.action, 'direct')
  assert.equal(result.structural, false)
  assert.equal(result.kind, 'timeout')
  assert.equal(calls.failure.length, 0)
  assert.equal(calls.state[0].outcome, 'timeout')
})

test('直调通过 → 不产信号，记 ok', async () => {
  const { deps, calls } = fakeDeps()
  const result = await runProbeGate({
    dir: 'C:/virtual',
    now: T0,
    probeFn: async () => ({ ok: true, checks: [{ name: 'session-create', ok: true }] }),
    deps,
  })
  assert.equal(result.ok, true)
  assert.equal(calls.failure.length, 0)
  assert.equal(calls.state[0].outcome, 'ok')
})

test('shouldProbe：无历史/超窗允许，窗内拒绝并给出 nextAt', () => {
  assert.equal(shouldProbe({ lastProbeAt: null }, { now: T0 }).probe, true)
  const fresh = shouldProbe({ lastProbeAt: T0 - HOURS }, { now: T0 })
  assert.equal(fresh.probe, false)
  assert.equal(fresh.nextAt, new Date(T0 - HOURS + PROBE_INTERVAL_MS).toISOString())
  assert.equal(shouldProbe({ lastProbeAt: T0 - 7 * HOURS }, { now: T0 }).probe, true)
})

test('磁盘侧：probe-failure.json / probe-gate.json 真写盘并读得回', () => {
  const dir = tmpDir('disk')
  const payload = writeProbeFailure(dir, {
    artifact: { name: 'probe-a.json', artifact: { ts: '2026-11-21T04:00:00.000Z', ok: false, checks: [{ name: 'tool-inventory', ok: false }] } },
    classification: { reasons: ['inventory-missing'] },
    now: T0,
  })
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'probe-failure.json'), 'utf8'))
  assert.equal(onDisk.structural, true)
  assert.deepEqual(onDisk.reasons, ['inventory-missing'])
  assert.equal(onDisk.ts, payload.ts)
  assert.equal(onDisk.source, 'dsh-ownshield-inject')

  writeProbeState(dir, { now: T0, outcome: 'structural', reasons: ['inventory-missing'] })
  const state = readProbeState(dir)
  assert.equal(state.lastProbeAt, T0)
  assert.equal(state.lastOutcome, 'structural')
})

test('latestProbeArtifact：取最新一份，忽略坏 JSON 与其它文件', () => {
  const dir = tmpDir('latest')
  fs.writeFileSync(path.join(dir, 'probe-old.json'), JSON.stringify({ ok: true, ts: '2026-11-21T03:00:00.000Z' }))
  fs.writeFileSync(path.join(dir, 'probe-new.json'), JSON.stringify({ ok: false, ts: '2026-11-21T04:00:00.000Z' }))
  fs.writeFileSync(path.join(dir, 'probe-broken.json'), '{ not json')
  fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({ ok: true }))
  const latest = latestProbeArtifact(dir)
  assert.ok(latest)
  assert.equal(latest.name, 'probe-new.json')
  const since = Date.parse('2026-11-21T03:30:00.000Z')
  assert.equal(latestProbeArtifact(dir, { since }).name, 'probe-new.json')
})

test('planStartupProbe：有直调能力时优先直调，避免多烧一条会话消息', () => {
  const plan = planStartupProbe({
    state: { lastProbeAt: null },
    latest: null,
    now: T0,
    probeSessionId: 'session-abc',
    hasDirect: true,
  })
  assert.equal(plan.action, 'direct')
})

test('writeProbeRequest：写 inject-pending-probe.json，字段可被 inject 的 pending 解析', () => {
  const dir = tmpDir('pending')
  const file = writeProbeRequest(dir, { sessionId: 'session-xyz', prompt: 'run probe', now: new Date(T0) })
  assert.equal(path.basename(file), 'inject-pending-probe.json')
  const body = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(body.sessionId, 'session-xyz')
  assert.equal(body.prompt, 'run probe')
  assert.equal(body.createdAt, new Date(T0).toISOString())
  assert.equal(body.level, 'probe')
  // inject 的 pending 文件名正则必须认得它，否则这条永远不会被投递。
  assert.match('inject-pending-probe.json', /^(?:wake|inject)-pending(?!-(done|failed|expired|duplicate)).*\.json$/i)
})
