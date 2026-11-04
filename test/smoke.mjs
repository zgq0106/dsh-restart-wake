/**
 * Offline smoke test: no Harness, no Task Scheduler, no network.
 *
 * Run with: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
import { resolveConfig, detectExecutable } from '../lib/config.js'
import {
  archive,
  discard,
  hasPending,
  isExpired,
  listArchived,
  listPending,
  pendingFileName,
  pruneArchives,
  removePending,
  writePending,
} from '../lib/pending.js'
import {
  clearLock,
  readLock,
  restartPayload,
  scheduleRestart,
  writeLock,
} from '../lib/restart.js'
import { inspectCookieStore } from '../lib/cookie.js'
import { restartPromptText } from '../lib/prompt.js'
import { WAKE_CLEANUP_NOTE } from '../lib/wake.js'
import { createTools } from '../lib/tools.js'

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

const workDir = mkdtempSync(join(tmpdir(), 'restart-wake-test-'))
const fakeCtx = {
  get: () => undefined,
  logger: { info() {}, warn() {} },
}

try {
  /* ───────────────────────────── config ───────────────────────────── */

  test('module exports apply / name / inject', () => {
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.name, 'dsh-restart-wake')
    assert.deepEqual(plugin.inject, ['tools'])
  })

  test('defaults point at a per-user registry', () => {
    const options = resolveConfig('C:\\pkg', {})
    assert.ok(options.pendingDir.includes('.dsh'))
    assert.ok(options.pendingDir.endsWith('restart-wake'))
    assert.equal(options.logPath, join(options.pendingDir, 'wake.log'))
    assert.equal(options.lockPath, join(options.pendingDir, 'restart.lock'))
    assert.equal(options.taskName, 'DshRestartWake')
    assert.equal(options.delaySeconds, 12)
    assert.equal(options.maxAttempts, 3)
    assert.equal(options.maxAgeMs, 24 * 60 * 60 * 1000)
  })

  test('override wins and processName derives from exePath', () => {
    const options = resolveConfig('C:\\pkg', {
      pendingDir: workDir,
      exePath: 'C:\\Apps\\My Harness.exe',
      delaySeconds: 20,
    })
    assert.equal(options.pendingDir, workDir)
    assert.equal(options.logPath, join(workDir, 'wake.log'))
    assert.equal(options.processName, 'My Harness')
    assert.equal(options.delaySeconds, 20)
  })

  test('explicit processName is kept', () => {
    const options = resolveConfig('C:\\pkg', {
      exePath: 'C:\\Apps\\whatever.exe',
      processName: 'DeepSeek Harness',
    })
    assert.equal(options.processName, 'DeepSeek Harness')
  })

  test('detectExecutable returns a string', () => {
    assert.equal(typeof detectExecutable('Definitely Not Installed'), 'string')
  })

  test('bad numeric override falls back to the default', () => {
    const options = resolveConfig('C:\\pkg', { delaySeconds: 'abc' })
    assert.equal(options.delaySeconds, 12)
  })

  /* ───────────────────────────── pending ───────────────────────────── */

  test('pending file name is sanitized', () => {
    assert.equal(pendingFileName('session-abc-123'), 'wake-pending-session-abc-123.json')
    assert.equal(pendingFileName('../../evil'), 'wake-pending-.._.._evil.json')
  })

  test('write / list / has / read', () => {
    const file = writePending(workDir, 'session-abc-123', 'continue the task', new Date('2026-11-04T00:00:00Z'))
    assert.ok(existsSync(file))
    assert.ok(hasPending(workDir, 'session-abc-123'))
    assert.ok(!hasPending(workDir, 'session-other'))

    const entries = listPending(workDir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].task.prompt, 'continue the task')
    assert.equal(entries[0].task.createdAt, '2026-11-04T00:00:00.000Z')
  })

  test('two sessions never share one file', () => {
    writePending(workDir, 'session-abc-123', 'first')
    writePending(workDir, 'session-def-456', 'second')
    assert.equal(listPending(workDir).length, 2)
    assert.ok(hasPending(workDir, 'session-abc-123'))
    assert.ok(hasPending(workDir, 'session-def-456'))
  })

  test('archive renames and is no longer pending', () => {
    const source = writePending(workDir, 'session-abc-123', 'first')
    const target = archive(workDir, source, 'done')
    assert.ok(target && existsSync(target))
    assert.ok(!existsSync(source))
    assert.equal(listPending(workDir).length, 1)
    assert.equal(listArchived(workDir, 10).length, 1)
  })

  test('archived names are excluded from the pending pattern', () => {
    writeFileSync(join(workDir, 'wake-pending-done-x.json'), '{"sessionId":"x","prompt":"y"}')
    assert.ok(!listPending(workDir).some((entry) => entry.file.endsWith('wake-pending-done-x.json')))
  })

  test('removePending removes only one session', () => {
    const removed = removePending(workDir, 'session-def-456')
    assert.equal(removed, true)
    assert.equal(hasPending(workDir, 'session-def-456'), false)
    assert.equal(removePending(workDir, 'session-def-456'), false)
  })

  test('isExpired uses createdAt and tolerates missing values', () => {
    const now = Date.parse('2026-11-04T12:00:00Z')
    assert.equal(isExpired({ createdAt: '2026-11-04T11:00:00Z' }, 24 * 60 * 60 * 1000, now), false)
    assert.equal(isExpired({ createdAt: '2026-11-02T11:00:00Z' }, 24 * 60 * 60 * 1000, now), true)
    assert.equal(isExpired({}, 24 * 60 * 60 * 1000, now), false)
    assert.equal(isExpired({ createdAt: 'not-a-date' }, 1000, now), false)
  })

  /* ───────────────────────────── mutex ───────────────────────────── */

  test('lock lifecycle', () => {
    const lockPath = join(workDir, 'restart.lock')
    assert.equal(readLock(lockPath, 600000).held, false)
    writeLock(lockPath, 'session-abc-123')
    const lock = readLock(lockPath, 600000)
    assert.equal(lock.held, true)
    assert.equal(lock.stale, false)
    assert.equal(readLock(lockPath, -1).stale, true)
    clearLock(lockPath)
    assert.equal(readLock(lockPath, 600000).held, false)
  })

  /* ───────────────────────────── tools ───────────────────────────── */

  test('built-in protocol prompt states the rules', () => {
    const text = restartPromptText()
    for (const needle of ['restart_now', '最后一步', 'RESULT: OK', 'restart_status', 'wake_register', 'schedule_delete']) {
      assert.ok(text.includes(needle), `prompt is missing ${needle}`)
    }
    assert.ok(text.length < 1200, 'prompt is too long to inject on every step')
  })

  test('promptEnabled defaults to true and can be turned off', () => {
    assert.equal(resolveConfig('C:\\pkg', {}).promptEnabled, true)
    assert.equal(resolveConfig('C:\\pkg', { promptEnabled: false }).promptEnabled, false)
  })

  test('wake delivery appends the schedule cleanup note', () => {
    assert.ok(WAKE_CLEANUP_NOTE.includes('schedule_delete'))
    assert.ok(WAKE_CLEANUP_NOTE.includes('inactive'))
  })

  test('discard removes a delivered entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-wake-discard-'))
    try {
      const file = writePending(dir, 'session-discard', 'x')
      assert.equal(discard(file), true)
      assert.equal(existsSync(file), false)
      assert.equal(readdirSync(dir).filter((name) => name.startsWith('wake-pending')).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pruneArchives drops done files and keeps the newest failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-wake-prune-'))
    try {
      for (let i = 0; i < 3; i += 1) {
        writeFileSync(join(dir, `wake-done-session-a-2026-11-04T00-00-0${i}-000Z.json`), '{}')
      }
      for (let i = 10; i < 22; i += 1) {
        writeFileSync(join(dir, `wake-failed-session-b-2026-11-04T00-00-${i}-000Z.json`), '{}')
      }
      const removed = pruneArchives(dir, 10)
      const left = readdirSync(dir)
      assert.equal(removed, 5, 'three done files plus the two oldest failures')
      assert.equal(left.filter((name) => name.startsWith('wake-done-')).length, 0)
      assert.equal(left.filter((name) => name.startsWith('wake-failed-')).length, 10)
      assert.ok(left.includes('wake-failed-session-b-2026-11-04T00-00-21-000Z.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('six tools with unique names', () => {
    const options = resolveConfig('C:\\pkg', { pendingDir: workDir, exePath: 'C:\\Apps\\My Harness.exe' })
    const tools = createTools(fakeCtx, options)
    assert.equal(tools.length, 6)
    const names = tools.map((tool) => tool.name)
    assert.deepEqual(
      [...new Set(names)],
      [
        'restart_now',
        'wake_register',
        'wake_list',
        'wake_cancel',
        'restart_status',
        'cookie_status',
      ],
    )
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 10)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
  })

  test('restart_now refuses without a session id', async () => {
    const options = resolveConfig('C:\\pkg', { pendingDir: workDir, exePath: 'C:\\Apps\\My Harness.exe' })
    const tool = createTools(fakeCtx, options).find((item) => item.name === 'restart_now')
    await assert.rejects(() => tool.execute({}, undefined), /无法确定当前会话 id/)
  })

  test('restart_payload carries every script input', () => {
    const options = resolveConfig('C:\\pkg', { pendingDir: workDir, exePath: 'C:\\Apps\\My Harness.exe' })
    const payload = restartPayload(options, 9)
    for (const key of [
      'exePath',
      'processName',
      'logPath',
      'taskName',
      'delaySeconds',
      'launchWaitSeconds',
      'maxLaunchAttempts',
      'graceSeconds',
      'killTimeoutSeconds',
      'singleInstanceWaitSeconds',
      'cookieDbPath',
      'cookieProbePath',
      'cookieCleanupPath',
      'cookieThreshold',
      'crashLogDir',
    ]) {
      assert.ok(key in payload, `payload is missing ${key}`)
    }
    assert.equal(payload.delaySeconds, 9)
  })

  test('cookie inspection reports a missing store instead of failing', () => {
    const info = inspectCookieStore(join(workDir, 'no-such-dir', 'Cookies'))
    assert.equal(info.available, false)
    assert.equal(info.reason, 'missing-db')
  })

  test('cookie_status reports the missing cleanup script too', async () => {
    const options = resolveConfig('C:\\pkg', {
      pendingDir: workDir,
      exePath: 'C:\\Apps\\My Harness.exe',
      cookieDbPath: join(workDir, 'nope', 'Cookies'),
      cookieCleanupPath: join(workDir, 'nope', 'cookie-cleanup.mjs'),
    })
    const tool = createTools(fakeCtx, options).find((item) => item.name === 'cookie_status')
    const value = await tool.execute({})
    assert.equal(value.available, false)
    assert.equal(value.threshold, 50)
    assert.equal(value.cleanupExists, false)
  })

  await testAsync('scheduleRestart rejects a missing executable before touching schtasks', async () => {
    const options = resolveConfig('C:\\pkg', {
      pendingDir: workDir,
      exePath: join(workDir, 'definitely-missing.exe'),
    })
    await assert.rejects(
      () => scheduleRestart(options, { delaySeconds: 5 }),
      /找不到 Harness 可执行文件|只支持 Windows/,
    )
  })
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}`)
    console.error(failure.error)
  }
  console.log(`\n${passed} passed, ${failures.length} failed`)
  process.exit(1)
}

console.log(`${passed} passed, 0 failed`)
