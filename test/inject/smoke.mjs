/**
 * 故障回注半边离线冒烟测试（2.0 起随 dsh-restart-wake 发布）：不启动 Harness、不写真实 ~/.dsh、不发网络请求。
 *
 * 运行：node test/inject/smoke.mjs
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as plugin from '../../index.js'
import { resolveInjectConfig, INJECT_DEFAULTS } from '../../lib/config-inject.js'
import {
  isExpired,
  listPending,
  moveTo,
  normalizeErrorTail,
  normalizeTimestamp,
  pendingFileName,
  readTask,
  writeInjectPending,
  writeWakePending,
} from '../../lib/pending-inject.js'
import { buildInjectMessage, describeRecovered } from '../../lib/message.js'
import { deliver, runOnce, startInjectLoop } from '../../lib/inject.js'
import { startRequestWatch } from '../../lib/request-watch.js'

const ROOT = join(import.meta.dirname, '..', '..', '..', 'tmp', 't5-inject')
mkdirSync(ROOT, { recursive: true })

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

function tempDir(tag) {
  return mkdtempSync(join(ROOT, `${tag}-`))
}

function fakeCtx(service, logLines = []) {
  return {
    get(name) {
      return name === 'sessionController' ? service : undefined
    },
    logger: {
      info(message) {
        logLines.push(message)
      },
      warn(message) {
        logLines.push(message)
      },
    },
  }
}

function pendingOptions(dir, overrides = {}) {
  return resolveInjectConfig('C:\\pkg', {
    injectDir: dir,
    doneDir: join(dir, 'inject-done'),
    failedDir: join(dir, 'inject-failed'),
    injectLogPath: join(dir, 'inject.log'),
    startupDelayMs: 1,
    readyTimeoutMs: 50,
    deliverTimeoutMs: 1000,
    maxAttempts: 1,
    retryDelayMs: 1,
    ...overrides,
  })
}

function successfulService(calls) {
  return {
    async prompt(request, signal) {
      assert.equal(typeof signal?.throwIfAborted, 'function', 'prompt 必须收到 AbortSignal')
      assert.equal(signal.aborted, false)
      calls.push(request)
      return { ok: true }
    },
  }
}

/**
 * 2.0：合并后的 index.js apply 会同时启动重启/回注/探针三套循环并注册 11 个工具。
 * 本文件只验回注半边，因此按原 dsh-ownshield-inject 的 apply 等价路径挂三套触发器，
 * 不跑重启侧、不注册工具。合并后的整段接线由前台 A1 与阶段 B 的 B1/B2 验收。
 */
function applyInjectHalf(ctx, config = {}) {
  const options = resolveInjectConfig('C:\\pkg', config)
  startInjectLoop(ctx, options)
  plugin.startProbeGate(ctx, options)
  startRequestWatch(ctx, options)
}

const cleanup = []
function makePendingDir() {
  const dir = tempDir('pending')
  cleanup.push(dir)
  return dir
}

try {
  /* ── 包与配置 ── */
  test('module exports apply / name', () => {
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.name, 'dsh-restart-wake')
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'))
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.name, 'dsh-restart-wake')
  })

  test('defaults live next to the other ownshield state', () => {
    const options = resolveInjectConfig('C:\\pkg', {})
    assert.ok(options.injectDir.includes('.dsh'))
    assert.ok(options.injectDir.endsWith('ownshield'))
    assert.equal(options.doneDir, join(options.injectDir, 'inject-done'))
    assert.equal(options.failedDir, join(options.injectDir, 'inject-failed'))
    assert.equal(options.maxErrorLines, 20)
    assert.equal(options.maxAttempts, INJECT_DEFAULTS.maxAttempts)
    assert.equal(options.timeZone, 'Asia/Shanghai')
  })

  test('override wins and bad numbers fall back', () => {
    const dir = makePendingDir()
    const options = resolveInjectConfig('C:\\pkg', {
      injectDir: dir,
      maxAttempts: 'abc',
      maxErrorLines: 5,
    })
    assert.equal(options.injectDir, dir)
    assert.equal(options.maxAttempts, INJECT_DEFAULTS.maxAttempts)
    assert.equal(options.maxErrorLines, 5)
  })

  /* ── pending 读取 ── */
  test('normalizeTimestamp accepts ISO, epoch ms and numeric strings', () => {
    const epoch = Date.parse('2026-11-17T12:00:00Z')
    assert.equal(normalizeTimestamp('2026-11-17T12:00:00Z'), '2026-11-17T12:00:00.000Z')
    assert.equal(normalizeTimestamp(epoch), '2026-11-17T12:00:00.000Z')
    assert.equal(normalizeTimestamp(String(epoch)), '2026-11-17T12:00:00.000Z')
    assert.equal(normalizeTimestamp('not-a-date'), undefined)
    assert.equal(normalizeTimestamp(undefined), undefined)
  })

  test('normalizeErrorTail keeps arrays and splits strings', () => {
    assert.deepEqual(normalizeErrorTail(['a', 'b']), ['a', 'b'])
    assert.deepEqual(normalizeErrorTail('a\r\nb\nc'), ['a', 'b', 'c'])
    assert.deepEqual(normalizeErrorTail(undefined), [])
  })

  test('readTask normalizes the ownshield rich pending shape', () => {
    const dir = makePendingDir()
    const file = writeInjectPending(dir, {
      ts: '2026-11-17T12:00:00Z',
      level: 'L3',
      phase: 'startup',
      source: 'renderer',
      errorTail: ['boom'],
      snapshotTag: '20261117T232621-baseline',
      recovered: true,
      rollbackFiles: ['C:\\a.txt'],
      sessionId: 'session-1',
    })
    const task = readTask(file)
    assert.equal(task.sessionId, 'session-1')
    assert.equal(task.level, 'L3')
    assert.equal(task.phase, 'startup')
    assert.equal(task.source, 'renderer')
    assert.equal(task.snapshotTag, '20261117T232621-baseline')
    assert.deepEqual(task.errorTail, ['boom'])
    assert.equal(task.createdAt, '2026-11-17T12:00:00.000Z')
    assert.equal(task.prompt, undefined)
  })

  test('readTask also accepts the wake format, including a BOM', () => {
    const dir = makePendingDir()
    const file = join(dir, pendingFileName('session-2'))
    writeFileSync(
      file,
      '\uFEFF' + JSON.stringify({ sessionId: 'session-2', prompt: '继续', createdAt: '2026-11-17T00:00:00Z' }),
    )
    const task = readTask(file)
    assert.equal(task.sessionId, 'session-2')
    assert.equal(task.prompt, '继续')
    assert.equal(task.createdAt, '2026-11-17T00:00:00.000Z')
  })

  test('readTask refuses a record without a session id', () => {
    const dir = makePendingDir()
    writeInjectPending(dir, { ts: '2026-11-17T00:00:00Z', level: 'L2' })
    assert.throws(() => readTask(join(dir, 'inject-pending.json')), /missing session id/)
  })

  test('listPending sees both prefixes and ignores archived names', () => {
    const dir = makePendingDir()
    writeInjectPending(dir, { sessionId: 'session-3', ts: new Date().toISOString() })
    writeWakePending(dir, 'session-4', 'continue')
    writeFileSync(join(dir, 'wake-pending-done-x.json'), '{}')
    writeFileSync(join(dir, 'inject-pending-failed-y.json'), '{}')
    const entries = listPending(dir)
    assert.equal(entries.length, 2)
    assert.deepEqual(
      entries.map((entry) => entry.file.split(/[\\/]/).pop()).sort(),
      ['inject-pending.json', pendingFileName('session-4')],
    )
  })

  test('writeInjectPending defaults ts and survives a reread', () => {
    const dir = makePendingDir()
    const file = writeInjectPending(dir, { sessionId: 'session-5', level: 'L1' })
    const body = JSON.parse(readFileSync(file, 'utf8'))
    assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(body.level, 'L1')
    assert.equal(readTask(file).sessionId, 'session-5')
  })

  test('isExpired tolerates missing timestamps', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    assert.equal(isExpired({ createdAt: '2026-11-17T11:00:00Z' }, 24 * 60 * 60 * 1000, now), false)
    assert.equal(isExpired({ createdAt: '2026-11-15T11:00:00Z' }, 24 * 60 * 60 * 1000, now), true)
    assert.equal(isExpired({}, 1000, now), false)
  })

  test('moveTo never overwrites and never deletes', () => {
    const dir = makePendingDir()
    const source = join(dir, 'inject-pending.json')
    writeFileSync(source, '{}')
    const targetDir = join(dir, 'inject-done')
    const first = moveTo(targetDir, source)
    assert.ok(first && existsSync(first))
    assert.equal(existsSync(source), false)
    writeFileSync(source, '{}')
    const second = moveTo(targetDir, source)
    assert.ok(second && second !== first)
    assert.equal(readdirSync(targetDir).length, 2, '同名归档必须追加序号，不能覆盖')
  })

  /* ── 消息组装 ── */
  test('buildInjectMessage carries stage, tail, snapshot and the instruction', () => {
    const text = buildInjectMessage({
      sessionId: 's',
      level: 'L3',
      phase: 'startup',
      source: 'renderer',
      recovered: true,
      snapshotTag: '20261117T232621-baseline',
      rollbackFiles: ['C:\\a.txt', 'C:\\b.txt'],
      errorTail: ['Error: boom', '    at x'],
    })
    for (const needle of [
      'L3',
      'startup',
      'renderer',
      '已恢复',
      '20261117T232621-baseline',
      'C:\\a.txt',
      'Error: boom',
      '请先解释根因',
      '最小修复',
      '不要重做大改',
    ]) {
      assert.ok(text.includes(needle), `message is missing ${needle}`)
    }
  })

  test('buildInjectMessage keeps only the last 20 lines by default', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`)
    const text = buildInjectMessage({ sessionId: 's', errorTail: lines })
    assert.ok(text.includes('line-30'))
    assert.ok(text.includes('line-11'))
    assert.ok(!text.includes('line-10\n'), '第 10 行应被截掉')
    assert.ok(text.includes('最后 20 行'))
  })

  test('buildInjectMessage caps the total length', () => {
    const text = buildInjectMessage(
      { sessionId: 's', errorTail: Array.from({ length: 20 }, () => 'x'.repeat(800)) },
      { maxMessageChars: 2000 },
    )
    assert.ok(text.length <= 2000)
    assert.ok(text.includes('已截断'))
    assert.ok(text.includes('请先解释根因'))
  })

  test('buildInjectMessage renders boolean/string recovered values', () => {
    assert.match(describeRecovered(false), /未恢复/)
    assert.equal(describeRecovered('L4 已停手'), 'L4 已停手')
    assert.equal(describeRecovered(undefined), '未知')
  })

  test('buildInjectMessage 分档：recovered 是事后通报，不要求处置', () => {
    const text = buildInjectMessage({
      sessionId: 's',
      level: 'recovered',
      phase: 'auto-recovery',
      recovered: true,
      snapshotTag: 'baseline',
      note: 'L1 恢复成功：回滚快照 baseline，重启 pid 15400',
    })
    assert.ok(text.includes('已自动恢复'), 'recovered 需要专属开头')
    assert.ok(text.includes('事后通报'), 'recovered 要说明这是通报')
    assert.ok(text.includes('不需要修改或重启'), 'recovered 的指令应是无处置')
    assert.ok(!text.includes('请先解释根因'), 'recovered 不该要求解释根因')
  })

  /* ── 投递主流程 ── */
  await testAsync('runOnce delivers a test pending file and moves it to inject-done', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir)
    writeInjectPending(dir, {
      ts: new Date().toISOString(),
      level: 'L2',
      phase: 'running',
      errorTail: ['Error: probe failed'],
      snapshotTag: '20261117T232621-baseline',
      recovered: true,
      sessionId: 'session-abc',
    })
    const calls = []
    const logs = []
    const summary = await runOnce(fakeCtx(successfulService(calls), logs), options, (line) => logs.push(line))

    assert.equal(summary.entries, 1)
    assert.equal(summary.delivered, 1)
    assert.equal(calls.length, 1)
    const request = calls[0]
    assert.equal(request.sessionId, 'session-abc')
    assert.equal(request.mode, 'queue')
    assert.equal(typeof request.requestId, 'string')
    assert.equal(request.clientTimeZone, 'Asia/Shanghai')
    assert.equal(request.content.length, 1)
    assert.equal(request.content[0].type, 'text')
    assert.ok(request.content[0].text.includes('L2'))
    assert.ok(request.content[0].text.includes('Error: probe failed'))

    assert.equal(existsSync(join(dir, 'inject-pending.json')), false)
    assert.equal(existsSync(join(dir, 'inject-done', 'inject-pending.json')), true)
    assert.ok(logs.some((line) => line.includes('delivered session=session-abc')))
    assert.ok(logs.some((line) => line.includes('scan-complete')))
  })

  await testAsync('runOnce retries and then succeeds', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir, { maxAttempts: 2, retryDelayMs: 1 })
    writeInjectPending(dir, { sessionId: 'session-retry', ts: new Date().toISOString() })
    let attempts = 0
    const service = {
      async prompt() {
        attempts += 1
        if (attempts === 1) throw new Error('temporary')
      },
    }
    const summary = await runOnce(fakeCtx(service), options, () => {})
    assert.equal(attempts, 2)
    assert.equal(summary.delivered, 1)
  })

  await testAsync('runOnce archives a failed delivery instead of deleting it', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir, { maxAttempts: 1 })
    writeInjectPending(dir, { sessionId: 'session-fail', ts: new Date().toISOString() })
    const service = {
      async prompt() {
        throw new Error('session/not-found')
      },
    }
    const logs = []
    const summary = await runOnce(fakeCtx(service), options, (line) => logs.push(line))
    assert.equal(summary.delivered, 0)
    assert.equal(summary.failed, 1)
    assert.equal(existsSync(join(dir, 'inject-pending.json')), false)
    assert.equal(existsSync(join(dir, 'inject-failed', 'inject-pending.json')), true)
    assert.ok(logs.some((line) => line.includes('gave-up')))
  })

  await testAsync('runOnce archives an unreadable record without prompt', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir)
    writeInjectPending(dir, { level: 'L2' })
    let called = 0
    const summary = await runOnce(
      fakeCtx({ async prompt() { called += 1 } }),
      options,
      () => {},
    )
    assert.equal(summary.delivered, 0)
    assert.equal(summary.failed, 1)
    assert.equal(called, 0)
    assert.equal(readdirSync(join(dir, 'inject-failed')).length, 1)
  })

  await testAsync('runOnce archives expired pending without prompt', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir, { maxAgeMs: 60 * 60 * 1000 })
    writeInjectPending(dir, {
      sessionId: 'session-old',
      ts: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    })
    let called = 0
    const summary = await runOnce(
      fakeCtx({ async prompt() { called += 1 } }),
      options,
      () => {},
    )
    assert.equal(called, 0)
    assert.equal(summary.failed, 1)
    assert.ok(existsSync(join(dir, 'inject-failed', 'inject-pending.json')))
  })

  await testAsync('runOnce delivers at most once per session', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir)
    writeInjectPending(dir, { sessionId: 'session-dup', ts: new Date().toISOString() })
    writeWakePending(dir, 'session-dup', 'second')
    let called = 0
    const summary = await runOnce(fakeCtx({ async prompt() { called += 1 } }), options, () => {})
    assert.equal(called, 1)
    assert.equal(summary.delivered, 1)
    assert.equal(summary.failed, 1)
    assert.equal(readdirSync(join(dir, 'inject-failed')).length, 1)
  })

  await testAsync('runOnce leaves files untouched when sessionController never appears', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir, { readyTimeoutMs: 5 })
    writeInjectPending(dir, { sessionId: 'session-slow', ts: new Date().toISOString() })
    const summary = await runOnce({ get: () => undefined, logger: {} }, options, () => {})
    assert.equal(summary.failed, 0)
    assert.equal(summary.delivered, 0)
    assert.equal(existsSync(join(dir, 'inject-pending.json')), true, '不能为了清理丢掉 pending')
  })

  await testAsync('runOnce is silent with an empty directory', async () => {
    const dir = makePendingDir()
    const logs = []
    const summary = await runOnce(fakeCtx({ async prompt() {} }, logs), pendingOptions(dir), (line) =>
      logs.push(line),
    )
    assert.equal(summary.entries, 0)
    assert.ok(logs.some((line) => line.includes('no-pending')))
    assert.equal(existsSync(join(dir, 'inject-done')), false)
  })

  await testAsync('deliver passes the AbortSignal and a structured prompt', async () => {
    const calls = []
    const service = successfulService(calls)
    const task = {
      sessionId: 'session-deliver',
      level: 'L3',
      errorTail: ['boom'],
      recovered: false,
    }
    const options = pendingOptions(makePendingDir())
    await deliver(service, task, options)
    assert.equal(calls[0].sessionId, 'session-deliver')
    assert.ok(calls[0].content[0].text.includes('未恢复'))
  })

  await testAsync('startInjectLoop schedules through ctx.effect', async () => {
    const dir = makePendingDir()
    const options = pendingOptions(dir)
    writeInjectPending(dir, { sessionId: 'session-loop', ts: new Date().toISOString() })
    let called = 0
    let disposed = 0
    let timerRan = false
    const effectLabels = []
    const ctx = {
      get: () => ({ async prompt() { called += 1 } }),
      logger: {},
      effect(factory, label) {
        effectLabels.push(label ?? '')
        const dispose = factory()
        timerRan = true
        disposed += 1
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    }
    applyInjectHalf(ctx, {
      injectDir: dir,
      doneDir: join(dir, 'inject-done'),
      failedDir: join(dir, 'inject-failed'),
      injectLogPath: join(dir, 'inject.log'),
      startupDelayMs: 1,
      readyTimeoutMs: 50,
      maxAttempts: 1,
    })
    assert.equal(timerRan, true)
    // A1：apply() 现在挂两个 effect —— 注入循环 + 探针生产者（后者 45 秒后才跑）。
    assert.equal(disposed, 2)
    assert.deepEqual(effectLabels.sort(), [
      'ownshield-inject.probeGate()',
      'ownshield-inject.startup()',
    ])
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(called, 1)
    assert.equal(existsSync(join(dir, 'inject-done', 'inject-pending.json')), true)
  })

  await testAsync('startInjectLoop rescans on scanIntervalMs (2026-11-21)', async () => {
    const dir = makePendingDir()
    let called = 0
    writeInjectPending(dir, { sessionId: 'session-loop-a', ts: new Date().toISOString() })
    const ctx = {
      get: () => ({ async prompt() { called += 1 } }),
      logger: {},
      effect(factory) {
        const dispose = factory()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    }
    applyInjectHalf(ctx, {
      injectDir: dir,
      doneDir: join(dir, 'inject-done'),
      failedDir: join(dir, 'inject-failed'),
      injectLogPath: join(dir, 'inject.log'),
      startupDelayMs: 1,
      readyTimeoutMs: 50,
      maxAttempts: 1,
      scanIntervalMs: 40,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 首轮扫描之后才写下的 pending：旧实现要等重启，新实现靠周期重扫拿到。
    writeInjectPending(dir, { sessionId: 'session-loop-b', ts: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.ok(called >= 2, `周期重扫应投递后写入的 pending，实际 called=${called}`)
  })
} finally {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 偶发占用 */
    }
  }
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* 根目录被占用就留给下次覆盖 */
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}`)
    console.error(failure.error)
  }
  console.log(`\n${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`${passed} passed, 0 failed`)
}
