/**
 * 本地 Web 登录 cookie 过期守卫：判据、信号识别、未在看护快通道。
 *
 * 背景：11-19 那次页面 401 是 cookie 过期，而它不写 DSH 日志、不进会话事件，
 * 只能从「进程年龄 vs cookieMaxAgeDays」静态推断。这里固定该判据，并保证
 * watch 与插件侧 auth-gate 的结论一致。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  evaluateSignals,
  evaluateWebCookie,
  readCookieMaxAgeDays,
  runWatch,
} from './watch.mjs'
// auth-gate 有两种布局：发布包内是 `scripts/ownshield/ → ../../lib/auth-gate.js`，
// 开发目录是 `tools/ownshield/ → ../../dsh-ownshield/lib/auth-gate.js`。
// 静态 import 只能写死一种，所以这里按实际存在的路径动态解析。
const authGateUrl = (() => {
  const packed = new URL('../../lib/auth-gate.js', import.meta.url)
  if (existsSync(fileURLToPath(packed))) return packed.href
  return new URL('../../dsh-ownshield/lib/auth-gate.js', import.meta.url).href
})()
const { checkWebCookieAge } = await import(authGateUrl)

const HOUR = 3_600_000

function makeHome({ startAgoMs, lastAgoMs, cookieMaxAgeDays = 1, now }) {
  const home = mkdtempSync(join(tmpdir(), 'ownshield-cookie-'))
  mkdirSync(join(home, 'logs', 'ds-harness-remote'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  if (cookieMaxAgeDays !== null) {
    writeFileSync(
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: connection\n  name: "@deepseek-ai/dsh-client-connection"\n  config:\n    cookieMaxAgeDays: ${cookieMaxAgeDays}\n`,
    )
  } else {
    writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: connection\n')
  }
  const iso = (ms) => new Date(ms).toISOString()
  writeFileSync(
    join(home, 'logs', 'ds-harness-remote', 'host.log'),
    [
      `${iso(now - startAgoMs)} [INFO] [ds-harness-remote] host identity ready {"deviceId":"x"}`,
      `${iso(now - lastAgoMs)} [INFO] [ds-harness-remote] host rpc ok`,
      '',
    ].join('\n'),
  )
  return home
}

test('readCookieMaxAgeDays 从 profile 补丁取数；没配就是 undefined', () => {
  const now = Date.now()
  const configured = makeHome({ startAgoMs: HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: 7, now })
  const bare = makeHome({ startAgoMs: HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: null, now })
  try {
    assert.equal(readCookieMaxAgeDays(configured), 7)
    assert.equal(readCookieMaxAgeDays(bare), undefined)
  } finally {
    rmSync(configured, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('evaluateWebCookie：过期 / 未过期 / 不活跃 / 未配置 四态', () => {
  const now = Date.now()
  const staleHome = makeHome({ startAgoMs: 30 * HOUR, lastAgoMs: 60_000, now })
  const freshHome = makeHome({ startAgoMs: 10 * 60_000, lastAgoMs: 60_000, now })
  const idleHome = makeHome({ startAgoMs: 30 * HOUR, lastAgoMs: 5 * HOUR, now })
  const bareHome = makeHome({ startAgoMs: 30 * HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: null, now })
  try {
    const stale = evaluateWebCookie({ home: staleHome, now })
    assert.equal(stale.state, 'stale')
    assert.equal(stale.limitHours, 24)
    assert.ok(stale.detail.includes('401'), stale.detail)

    assert.equal(evaluateWebCookie({ home: freshHome, now }).state, 'ok')
    // host.log 30 分钟没动 = DSH 可能没在跑，不推断，避免误报
    assert.equal(evaluateWebCookie({ home: idleHome, now }).state, 'idle')
    assert.equal(evaluateWebCookie({ home: bareHome, now }).state, 'unconfigured')
    assert.equal(evaluateWebCookie({ home: join(staleHome, 'nope'), now }).state, 'no-log')
  } finally {
    for (const dir of [staleHome, freshHome, idleHome, bareHome]) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('插件侧 auth-gate 与 watch 侧判据一致（同一 fixture 同一结论）', () => {
  const now = Date.now()
  const cases = [
    { startAgoMs: 30 * HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: 1 },
    { startAgoMs: 10 * 60_000, lastAgoMs: 60_000, cookieMaxAgeDays: 1 },
    { startAgoMs: 30 * HOUR, lastAgoMs: 5 * HOUR, cookieMaxAgeDays: 1 },
    { startAgoMs: 30 * HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: null },
    { startAgoMs: 30 * HOUR, lastAgoMs: 60_000, cookieMaxAgeDays: 2 },
  ]
  for (const item of cases) {
    const home = makeHome({ ...item, now })
    try {
      const plugin = checkWebCookieAge({ env: { DSH_HOME: home }, home, now })
      const watch = evaluateWebCookie({ home, now })
      assert.equal(
        watch.state,
        plugin.state,
        `结论不一致（${JSON.stringify(item)}）：watch=${watch.state} plugin=${plugin.state}`,
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('探针 checks 里的 cookieStale 变成 cookie-stale 信号（ok 仍为 true 也认）', () => {
  const now = Date.now()
  const arm = { tag: 'baseline', armedAtMs: now - HOUR, graceSeconds: 120 }
  const boot = { pid: 100, startedAt: now - 30 * 60_000, graceUntil: now - 29 * 60_000 }
  const base = {
    arm,
    boot,
    now,
    procs: [{ pid: 100, start: boot.startedAt, browser: true }],
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: true, files: [{ ts: now - 10_000 }] },
  }
  const probeFile = (checks) => ({ ok: true, files: [{ name: 'probe-x.json', ts: now - 60_000, ok: true, checks }] })

  const hit = evaluateSignals({
    ...base,
    probes: probeFile([
      { name: 'auth-gate', ok: true, error: '', detail: '进程已运行 30.0h，超过寿命', cookieStale: true },
    ]),
  })
  const signal = hit.find((item) => item.type === 'cookie-stale')
  assert.ok(signal, `应产生 cookie-stale 信号，实际 ${JSON.stringify(hit.map((s) => s.type))}`)
  assert.equal(signal.hard, true)

  const miss = evaluateSignals({
    ...base,
    probes: probeFile([{ name: 'auth-gate', ok: true, error: '', detail: '未过期' }]),
  })
  assert.equal(miss.some((item) => item.type === 'cookie-stale'), false, '没有标记就不该产生信号')
})

test('未在看护：cookie 未过期时正常退出，不碰进程', async () => {
  const now = Date.now()
  const home = makeHome({ startAgoMs: 10 * 60_000, lastAgoMs: 60_000, now })
  const stateDir = join(home, 'state')
  mkdirSync(stateDir, { recursive: true })
  try {
    const result = runWatch({ dryRun: true, stateDir, dshHome: home, exe: 'C:\\nope\\none.exe' })
    assert.equal(result.output.armed, false)
    assert.equal(result.output.decision.action, 'none')
    assert.equal(result.output.cookieGuard, 'ok')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('未在看护：cookie 过期 → 判定 recover，dry-run 不重启', async () => {
  const now = Date.now()
  const home = makeHome({ startAgoMs: 30 * HOUR, lastAgoMs: 60_000, now })
  const stateDir = join(home, 'state')
  mkdirSync(stateDir, { recursive: true })
  try {
    const result = runWatch({ dryRun: true, stateDir, dshHome: home, exe: 'C:\\nope\\none.exe' })
    assert.equal(result.output.armed, false)
    assert.equal(result.output.decision.action, 'recover')
    assert.ok(result.output.decision.reason.includes('cookie-stale'), result.output.decision.reason)
    assert.equal(result.output.restart ?? null, null, 'dry-run 绝不能重启')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('未在看护：--no-cookie-guard 关闭守卫', async () => {
  const now = Date.now()
  const home = makeHome({ startAgoMs: 30 * HOUR, lastAgoMs: 60_000, now })
  const stateDir = join(home, 'state')
  mkdirSync(stateDir, { recursive: true })
  try {
    const result = runWatch({ dryRun: true, stateDir, dshHome: home, cookieGuard: false })
    assert.equal(result.output.decision.action, 'none')
    assert.equal(result.output.cookieGuard, 'disabled')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
