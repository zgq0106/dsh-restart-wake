/**
 * 2.0 合包后的状态桥测试（离线，不碰真实 ~/.dsh）。
 *
 * 覆盖三件新增行为：
 *   1. restart_now 前给 arm.json 打「主动重启」标记（失败要能回滚）；
 *   2. 恢复成功时若有遗嘱，投递 [还魂] 消息而不是泛泛的事后通报；
 *   3. 没有遗嘱时如实降级，不编造续跑内容。
 *
 * Run with: node test/bridge.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { markGracefulExit, readArmState, unmarkGracefulExit, gracefulMarkValid, GRACEFUL_MARK_TTL_MS } from '../lib/arm-bridge.js'
import { notifyRecovered, evaluateSignals } from '../scripts/ownshield/watch.mjs'
import { appendWill } from '../scripts/ownshield/will.mjs'

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `dsh-bridge-${label}-`))
}

function pathsOf(dir) {
  return {
    ownshield: dir,
    state: join(dir, 'state.json'),
    arm: join(dir, 'arm.json'),
    disarmDir: join(dir, 'disarm'),
    boot: join(dir, 'boot.json'),
    bootsDir: join(dir, 'boots'),
  }
}

test('未在看护时打标记是空操作', () => {
  const dir = tempDir('noarm')
  try {
    const result = markGracefulExit({ ownshieldDir: dir })
    assert.equal(result.armed, false)
    assert.equal(result.marked, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('看护中打标记写入 expectGracefulExit 且不丢原字段', () => {
  const dir = tempDir('mark')
  try {
    const file = join(dir, 'arm.json')
    writeFileSync(file, JSON.stringify({ tag: 'snap-a', armedAt: '2026-11-22T10:00:00+08:00', failures: 0 }))
    const result = markGracefulExit({ ownshieldDir: dir })
    assert.equal(result.armed, true)
    assert.equal(result.marked, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.expectGracefulExit, true)
    // 必须带时间戳：没有它就永远不过期，真崩溃会被当正常退出而不救（11-22 真机踩过）
    assert.equal(typeof after.expectGracefulExitAt, 'string')
    assert.ok(!Number.isNaN(Date.parse(after.expectGracefulExitAt)))
    assert.equal(after.tag, 'snap-a')
    assert.equal(after.failures, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回滚标记：原值不是 true 时删除字段，是 true 时保留', () => {
  const dir = tempDir('unmark')
  try {
    const file = join(dir, 'arm.json')

    writeFileSync(file, JSON.stringify({ tag: 'snap-b' }))
    const first = markGracefulExit({ ownshieldDir: dir })
    unmarkGracefulExit(first)
    assert.equal('expectGracefulExit' in JSON.parse(readFileSync(file, 'utf8')), false)

    writeFileSync(file, JSON.stringify({ tag: 'snap-c', expectGracefulExit: true }))
    const second = markGracefulExit({ ownshieldDir: dir })
    assert.equal(second.previous, true)
    unmarkGracefulExit(second)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).expectGracefulExit, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('arm.json 损坏时报错但不改写文件', () => {
  const dir = tempDir('broken')
  try {
    const file = join(dir, 'arm.json')
    writeFileSync(file, '{ 半截')
    const result = markGracefulExit({ ownshieldDir: dir })
    assert.equal(result.marked, false)
    assert.equal(typeof result.error, 'string')
    assert.equal(readFileSync(file, 'utf8'), '{ 半截')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readArmState 读出 tag / armedAt / 标记状态', () => {
  const dir = tempDir('readstate')
  try {
    const file = join(dir, 'arm.json')
    writeFileSync(file, JSON.stringify({ tag: 'snap-d', armedAt: '2026-11-22T11:00:00+08:00' }))
    const state = readArmState({ ownshieldDir: dir })
    assert.equal(state.armed, true)
    assert.equal(state.tag, 'snap-d')
    assert.equal(state.armedAt, '2026-11-22T11:00:00+08:00')
    assert.equal(state.expectGracefulExit, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有遗嘱时恢复通报变成 [还魂] 消息', () => {
  const dir = tempDir('will')
  try {
    const sessionId = 'session-abc123'
    appendWill(
      sessionId,
      {
        turn: 7,
        step: 3,
        goal: '把合包后的状态桥接做完',
        done: [{ path: join(dir, 'missing.js') }],
        next: '跑全量测试并重启验证',
      },
      { stateDir: dir },
    )
    const result = notifyRecovered({
      paths: pathsOf(dir),
      arm: { notifySessionId: sessionId, tag: 'snap-x' },
      attempt: {
        level: 'L2',
        tag: 'snap-x',
        restart: { pid: 4242, running: 1 },
        verify: { reason: 'tools-ok' },
      },
      attempts: [],
      signals: [{ type: 'process-gone' }],
    })
    assert.equal(result.channel, 'inject')
    const body = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.match(body.prompt, /\[还魂\]/)
    assert.match(body.prompt, /把合包后的状态桥接做完/)
    assert.match(body.prompt, /跑全量测试并重启验证/)
    assert.match(body.prompt, /process-gone/)
    assert.doesNotMatch(body.prompt, /不需要你做任何处置/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有遗嘱时降级为事后通报，不编造续跑内容', () => {
  const dir = tempDir('nowill')
  try {
    const result = notifyRecovered({
      paths: pathsOf(dir),
      arm: { notifySessionId: 'session-nothing', tag: 'snap-y' },
      attempt: { level: 'L2', tag: 'snap-y', restart: { pid: 1 }, verify: { reason: 'ok' } },
      attempts: [],
      signals: [{ type: 'process-gone' }],
    })
    const body = JSON.parse(readFileSync(result.file, 'utf8'))
    assert.match(body.prompt, /这是一条事后通报/)
    assert.doesNotMatch(body.prompt, /\[还魂\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有通报会话时落 markdown，不丢通报', () => {
  const dir = tempDir('nosession')
  try {
    const result = notifyRecovered({
      paths: pathsOf(dir),
      arm: { tag: 'snap-z' },
      attempt: { level: 'L1', tag: 'snap-z', restart: { pid: 1 }, verify: { reason: 'ok' } },
      attempts: [],
    })
    assert.equal(result.channel, 'markdown')
    assert.ok(result.file.endsWith('recovered.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('标记有效期：窗口内认可、超时不认、没时间戳不认', () => {
  const now = Date.parse('2026-11-22T10:00:00Z')
  assert.equal(
    gracefulMarkValid({ expectGracefulExit: true, expectGracefulExitAt: new Date(now - 60_000).toISOString() }, now),
    true,
  )
  assert.equal(
    gracefulMarkValid(
      { expectGracefulExit: true, expectGracefulExitAt: new Date(now - GRACEFUL_MARK_TTL_MS).toISOString() },
      now,
    ),
    true,
  )
  assert.equal(
    gracefulMarkValid(
      { expectGracefulExit: true, expectGracefulExitAt: new Date(now - GRACEFUL_MARK_TTL_MS - 1000).toISOString() },
      now,
    ),
    false,
  )
  assert.equal(gracefulMarkValid({ expectGracefulExit: true }, now), false)
  assert.equal(gracefulMarkValid({ expectGracefulExit: false }, now), false)
  assert.equal(gracefulMarkValid(null, now), false)
})

test('过期标记不得把进程消失判成正常退出（真崩溃必须救）', () => {
  const now = Date.parse('2026-11-22T10:00:00Z')
  const boot = {
    pid: 100,
    path: 'X:\\DeepSeek Harness.exe',
    startedAt: now - 120_000,
    detectedAt: now - 119_000,
    graceUntil: now - 1000,
    crashBaseline: { newestTime: 0, newestName: '', count: 0 },
  }
  const run = (arm) =>
    evaluateSignals({
      arm,
      boot,
      now,
      procs: [],
      procsOk: true,
      crash: { ok: true, files: [] },
      heartbeats: [],
      probes: [],
      exitEvidence: () => ({ crashEvents: { ok: true, crashed: false, events: [] }, exitCode: null }),
    })

  const fresh = run({
    graceSeconds: 120,
    expectGracefulExit: true,
    expectGracefulExitAt: new Date(now - 60_000).toISOString(),
  })
  assert.ok(fresh.some((signal) => signal.type === 'graceful-exit'))

  const stale = run({
    graceSeconds: 120,
    expectGracefulExit: true,
    expectGracefulExitAt: new Date(now - 20 * 60_000).toISOString(),
  })
  assert.ok(stale.some((signal) => signal.type === 'process-gone'))

  const noStamp = run({ graceSeconds: 120, expectGracefulExit: true })
  assert.ok(noStamp.some((signal) => signal.type === 'process-gone'))
})

test('readArmState 报告标记是否仍有效', () => {
  const dir = tempDir('markvalid')
  try {
    const file = join(dir, 'arm.json')
    writeFileSync(
      file,
      JSON.stringify({ tag: 'snap-e', expectGracefulExit: true, expectGracefulExitAt: new Date().toISOString() }),
    )
    assert.equal(readArmState({ ownshieldDir: dir }).markValid, true)

    writeFileSync(
      file,
      JSON.stringify({ tag: 'snap-f', expectGracefulExit: true, expectGracefulExitAt: '2026-11-01T00:00:00Z' }),
    )
    const stale = readArmState({ ownshieldDir: dir })
    assert.equal(stale.expectGracefulExit, true)
    assert.equal(stale.markValid, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
