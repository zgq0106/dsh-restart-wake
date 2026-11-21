/**
 * Offline smoke test: no Harness process, no network, no real ~/.dsh writes.
 *
 * Run with: node test/ownshield-smoke.mjs
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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'   // 2.0：合并后只验模块面（apply/name/inject）
import { checkAuthGate, checkWebCookieAge, resolveCookieMaxAgeDays } from '../lib/auth-gate.js'
import { resolveOwnshieldConfig } from '../lib/config-ownshield.js'
import {
  ownshieldPromptText,
  registerPrompt,
  PROMPT_ORDER,
  PROMPT_SECTION_NAME,
} from '../lib/prompt.js'
import { createOwnshieldTools } from '../lib/tools-ownshield.js'

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

const workDir = mkdtempSync(join(tmpdir(), 'ownshield-test-'))

function makeCtx({ controller, toolNames = ['read', 'ownshield_probe'], services = {} } = {}) {
  const cleanups = []
  const registered = []
  const scopeSeen = []
  const registry = {
    register(tool) {
      registered.push(tool)
      return () => {
        const index = registered.indexOf(tool)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    definitions(scope) {
      scopeSeen.push(scope)
      return toolNames.map((name) => ({ name }))
    },
  }
  const ctx = {
    tools: registry,
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'tools') return registry
      if (name === 'agents') return { get: () => undefined }
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    },
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
  }
  return { ctx, registered, cleanups, scopeSeen }
}

function makeController(options = {}) {
  const {
    sessionId = 'session-probe-1',
    createError,
    promptTimeout = false,
    resumeErrors = {},
  } = options
  let prompted = false

  return {
    calls: [],
    async create(request) {
      this.calls.push(['create', request])
      if (createError) throw createError
      return { sessionId, agentPreset: 'standard' }
    },
    async prompt(request, signal) {
      this.calls.push(['prompt', request])
      if (signal?.aborted) throw new Error('prompt signal already aborted')
      prompted = true
      return { accepted: true }
    },
    async events() {
      if (!prompted || promptTimeout) {
        return { records: [], hasMore: false }
      }
      return {
        records: [
          {
            type: 'event',
            event: {
              seq: 0,
              type: 'user/message',
              data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'probe' }] },
            },
          },
          {
            type: 'event',
            event: {
              seq: 1,
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'pong' }] } },
            },
          },
        ],
        hasMore: false,
      }
    },
    async resolveAgent(id) {
      this.calls.push(['resolveAgent', id])
      const code = resumeErrors[id]
      if (code) return { error: { code, message: `session ${id} unavailable` } }
      return { agent: { id, status: 'idle' } }
    },
  }
}

function probeFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(
    (name) => /^probe-\d{4}-\d{2}-\d{2}T/.test(name) && name.endsWith('.json'),
  )
}

function writeBaseline(dir, value) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tool-baseline.json'), JSON.stringify(value), 'utf8')
}

function writeProbeSession(dir, value) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'probe-session.json'), JSON.stringify(value), 'utf8')
}

function optionsFor(dir, extra = {}) {
  return resolveOwnshieldConfig('C:\\pkg', {
    ownshieldDir: dir,
    tmpBase: join(workDir, 'tmp'),
    probeTimeoutMs: 1000,
    probePollMs: 10,
    resumeTimeoutMs: 1000,
    ...extra,
  })
}

/**
 * 2.0：合并后的 index.js apply 会同时启动重启/回注/探针三套循环并注册 11 个工具。
 * 本文件只验自愈半边，因此按原 dsh-ownshield 的 apply 等价路径注册（提示 + 5 个工具），
 * 不启动其它循环。合并后的整段接线由前台 A1 与阶段 B 的 B1/B2 验收。
 */
function applyOwnshieldHalf(ctx, config = {}) {
  const options = resolveOwnshieldConfig('C:\\pkg', config)
  registerPrompt(ctx, { restartPromptEnabled: false, ownshieldPromptEnabled: true })
  for (const tool of createOwnshieldTools(ctx, options)) {
    const register = () => ctx.tools.register(tool)
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, `dsh-restart-wake.tool.${tool.name}()`)
    } else {
      register()
    }
  }
}

try {
  /* module */

  test('module exports apply / name / inject', () => {
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.name, 'dsh-restart-wake')
    assert.deepEqual(plugin.inject, ['tools'])
  })

  test('manifest and bundle patch', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.name, 'dsh-restart-wake')
    assert.equal(pkg.dsh.manifestVersion, 1)
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.ok(patch.includes('name: dsh-restart-wake'))
    assert.ok(patch.includes('id: restart-wake'))
  })

  test('defaults point at ~/.dsh/ownshield', () => {
    const options = resolveOwnshieldConfig('C:\\pkg', {})
    assert.equal(options.ownshieldDir, join(homedir(), '.dsh', 'ownshield'))
    assert.equal(options.baselinePath, join(options.ownshieldDir, 'tool-baseline.json'))
    assert.equal(options.probeSessionPath, join(options.ownshieldDir, 'probe-session.json'))
    assert.equal(options.probeMessage, 'probe')
    assert.equal(options.probeTimeoutMs, 60000)
    assert.equal(options.probePollMs, 500)
    assert.equal(options.resumeTimeoutMs, 30000)
  })

  test('overrides win and numbers are clamped', () => {
    const options = resolveOwnshieldConfig('C:\\pkg', {
      probeTimeoutMs: 1234,
      probePollMs: 5,
      ownshieldDir: 'C:\\probe',
    })
    assert.equal(options.probeTimeoutMs, 1234)
    assert.equal(options.probePollMs, 10)
    assert.equal(options.ownshieldDir, 'C:\\probe')
    assert.equal(options.baselinePath, 'C:\\probe\\tool-baseline.json')
  })

  test('apply registers five tools with full contracts inside effects', () => {
    const { ctx, registered, cleanups } = makeCtx({ controller: makeController() })
    applyOwnshieldHalf(ctx, { ownshieldDir: join(workDir, 'apply') })
    assert.equal(registered.length, 5)
    assert.equal(cleanups.length, 5)

    assert.equal(registered[0].name, 'ownshield_probe')
    for (const tool of registered) {
      assert.ok(tool.description.length > 30, `${tool.name} 的描述太短`)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(tool.output.schema.type, 'object', `${tool.name} 缺 output.schema`)
      assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`)
    }
    assert.ok(registered[0].output.schema.required.includes('checks'))
    assert.ok(registered[0].output.schema.required.includes('path'))
  })

  /* happy path */

  await testAsync('ownshield_probe writes a complete probe artifact', async () => {
    const dir = join(workDir, 'happy')
    writeBaseline(dir, ['read'])
    const agent = { id: 'agent-1' }
    const { ctx, registered, scopeSeen } = makeCtx({ controller: makeController() })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const tool = registered[0]

    const value = await tool.execute({}, { agent })
    assert.equal(scopeSeen.includes(agent), true, 'inventory must use the calling agent scope')
    assert.equal(value.ok, true)
    assert.equal(typeof value.ts, 'string')
    assert.ok(value.durationMs >= 0)
    assert.ok(existsSync(value.path))
    assert.equal(value.sessionId, 'session-probe-1')
    assert.deepEqual(
      value.checks.map((check) => check.name),
      [
        'create-session',
        'prompt-first-turn',
        'resume-probe-session',
        'tool-inventory',
        'service-inventory',
        'plugin-heartbeat',
        'auth-gate',
      ],
    )
    for (const check of value.checks) {
      for (const key of ['detail', 'error', 'name', 'ok']) assert.ok(key in check, `check 缺字段 ${key}`)
      assert.equal(typeof check.error, 'string')
      assert.equal(typeof check.detail, 'string')
      if ('warn' in check) assert.equal(typeof check.warn, 'string')
    }

    const data = JSON.parse(readFileSync(value.path, 'utf8'))
    for (const key of ['checks', 'durationMs', 'ok', 'ts']) assert.ok(key in data, `结果缺字段 ${key}`)
    if ('warnings' in data) assert.ok(Array.isArray(data.warnings))
    assert.equal(data.ok, true)
    assert.equal(data.checks.length, 7)
    assert.equal(data.checks[1].detail.includes('pong'), true)

    // The first successful run establishes the fixed resume session.
    const probeSession = JSON.parse(readFileSync(join(dir, 'probe-session.json'), 'utf8'))
    assert.equal(probeSession.sessionId, 'session-probe-1')

    const render = tool.output.render({}, value)
    assert.equal(Array.isArray(render), true)
    assert.equal(render[0].type, 'text')
    assert.ok(render[0].text.includes('ownshield 探针通过'))
    assert.ok(render[0].text.includes(value.path))
  })

  await testAsync('service-inventory reports a service that stopped resolving', async () => {
    const dir = join(workDir, 'service-missing')
    writeBaseline(dir, ['read'])
    writeFileSync(
      join(dir, 'service-baseline.json'),
      JSON.stringify({ services: ['tools', 'alphaService', 'betaService'] }),
      'utf8',
    )
    const { ctx, registered } = makeCtx({
      controller: makeController(),
      services: { alphaService: { alive: true } },
    })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })

    const value = await registered[0].execute({})
    const serviceCheck = value.checks.find((check) => check.name === 'service-inventory')
    assert.equal(serviceCheck.ok, false)
    assert.ok(serviceCheck.error.includes('betaService'), 'missing service must be named')
    assert.ok(!serviceCheck.error.includes('alphaService'), 'resolving service must not be reported')
    assert.equal(serviceCheck.detail, 'expected=3 missing=1 missingKeys=betaService')
    assert.equal(value.ok, false)
  })

  await testAsync('service-inventory passes when every baseline key resolves', async () => {
    const dir = join(workDir, 'service-ok')
    writeBaseline(dir, ['read'])
    writeFileSync(
      join(dir, 'service-baseline.json'),
      JSON.stringify(['tools']),
      'utf8',
    )
    const { ctx, registered } = makeCtx({ controller: makeController() })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })

    const value = await registered[0].execute({})
    const serviceCheck = value.checks.find((check) => check.name === 'service-inventory')
    assert.equal(serviceCheck.ok, true)
    assert.equal(serviceCheck.error, '')
    assert.equal(serviceCheck.detail, 'expected=1 missing=0')
  })

  test('result file name uses the timestamp', () => {
    const dir = join(workDir, 'happy')
    const files = probeFiles(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^probe-\d{4}-\d{2}-\d{2}T.*Z\.json$/)
  })

  /* inventory */

  await testAsync('missing baseline skips tool-inventory', async () => {
    const dir = join(workDir, 'no-baseline')
    const { ctx, registered } = makeCtx({ controller: makeController() })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})

    const inventory = value.checks.find((check) => check.name === 'tool-inventory')
    assert.equal(inventory.ok, true)
    assert.ok(inventory.detail.includes('跳过'))
    assert.equal(value.ok, true)
  })

  await testAsync('a missing expected tool fails the inventory check', async () => {
    const dir = join(workDir, 'missing-tool')
    writeBaseline(dir, { tools: ['read', 'ghost'] })
    const { ctx, registered } = makeCtx({
      controller: makeController(),
      toolNames: ['read', 'ownshield_probe', 'edit'],
    })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})

    const inventory = value.checks.find((check) => check.name === 'tool-inventory')
    assert.equal(inventory.ok, false)
    assert.ok(inventory.error.includes('ghost'))
    assert.ok(inventory.detail.includes('extra=2'))
    assert.equal(value.ok, false)
  })

  await testAsync('extra tools never fail the inventory check', async () => {
    const dir = join(workDir, 'extra-tool')
    writeBaseline(dir, ['read'])
    const { ctx, registered } = makeCtx({
      controller: makeController(),
      toolNames: ['read', 'ownshield_probe', 'edit'],
    })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})
    const inventory = value.checks.find((check) => check.name === 'tool-inventory')
    assert.equal(inventory.ok, true)
    assert.ok(inventory.detail.includes('extra=2'))
  })

  await testAsync('a corrupt baseline fails loudly', async () => {
    const dir = join(workDir, 'bad-baseline')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tool-baseline.json'), '{not json', 'utf8')
    const { ctx, registered } = makeCtx({ controller: makeController() })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})
    const inventory = value.checks.find((check) => check.name === 'tool-inventory')
    assert.equal(inventory.ok, false)
    assert.ok(inventory.error.length > 0)
    assert.equal(value.ok, false)
  })

  /* failures */

  await testAsync('a preset assembly failure is captured and still written', async () => {
    const dir = join(workDir, 'create-fail')
    const error = new Error('preset tree failed to mount')
    error.code = 'agent-preset/invalid'
    const { ctx, registered } = makeCtx({ controller: makeController({ createError: error }) })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 500,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})

    assert.equal(value.ok, false)
    const create = value.checks.find((check) => check.name === 'create-session')
    assert.equal(create.ok, false)
    assert.ok(create.error.includes('agent-preset/invalid'))
    const prompt = value.checks.find((check) => check.name === 'prompt-first-turn')
    assert.ok(prompt.error.includes('跳过'))
    assert.ok(existsSync(value.path))
    const data = JSON.parse(readFileSync(value.path, 'utf8'))
    assert.equal(data.ok, false)
    assert.equal(data.checks.length, 7)
  })

  await testAsync('a deleted fixed probe session rebases to the fresh session', async () => {
    const dir = join(workDir, 'rebase')
    writeProbeSession(dir, { sessionId: 'session-old' })
    const { ctx, registered } = makeCtx({
      controller: makeController({
        sessionId: 'session-new',
        resumeErrors: { 'session-old': 'session/not-found' },
      }),
    })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 1000,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})

    const resume = value.checks.find((check) => check.name === 'resume-probe-session')
    assert.equal(resume.ok, true)
    assert.ok(resume.detail.includes('重绑'))
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'probe-session.json'), 'utf8')).sessionId,
      'session-new',
    )
    assert.equal(value.ok, true)
  })

  await testAsync('a first turn that never settles times out', async () => {
    const dir = join(workDir, 'timeout')
    const { ctx, registered } = makeCtx({ controller: makeController({ promptTimeout: true }) })
    applyOwnshieldHalf(ctx, {
      ownshieldDir: dir,
      tmpBase: join(workDir, 'tmp'),
      probeTimeoutMs: 120,
      probePollMs: 10,
    })
    const value = await registered[0].execute({})

    assert.equal(value.ok, false)
    const prompt = value.checks.find((check) => check.name === 'prompt-first-turn')
    assert.equal(prompt.ok, false)
    assert.ok(prompt.error.includes('settled') || prompt.error.includes('首轮'))
    assert.ok(existsSync(value.path))
  })

  await testAsync('a missing sessionController rejects with an actionable error', async () => {
    const dir = join(workDir, 'no-controller')
    const { ctx, registered } = makeCtx({ controller: undefined })
    applyOwnshieldHalf(ctx, { ownshieldDir: dir })
    await assert.rejects(() => registered[0].execute({}), /sessionController 不可用/)
  })

  test('tool list exposes the five tools, each with schema + render', () => {
    const { ctx } = makeCtx({ controller: makeController() })
    const tools = createOwnshieldTools(ctx, optionsFor(join(workDir, 'tools')))
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'ownshield_probe',
        'ownshield_snapshot',
        'ownshield_arm',
        'ownshield_disarm',
        'ownshield_status',
      ],
    )
    const required = {
      ownshield_probe: ['checks', 'path'],
      ownshield_snapshot: ['tag', 'sha256', 'storeBytes'],
      ownshield_arm: ['armedAt', 'task', 'checks'],
      ownshield_disarm: ['movedTo'],
      ownshield_status: ['armed', 'task', 'snapshots', 'recovery'],
    }
    for (const tool of tools) {
      assert.equal(tool.output.schema.type, 'object', `${tool.name} 缺 output.schema`)
      assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`)
      assert.equal(tool.parameters.type, 'object', `${tool.name} 缺 parameters`)
      for (const field of required[tool.name]) {
        assert.ok(
          tool.output.schema.required.includes(field),
          `${tool.name} 的 schema 缺 required.${field}`,
        )
      }
    }
  })

  test('recovery tools fail with an actionable error when scripts are missing', async () => {
    const { ctx } = makeCtx({ controller: makeController() })
    const tools = createOwnshieldTools(ctx, optionsFor(join(workDir, 'missing-scripts')))
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    await assert.rejects(() => byName.ownshield_snapshot.execute({ tag: 'x' }), /脚本缺失/)
    await assert.rejects(() => byName.ownshield_arm.execute({ tag: 'x' }), /脚本缺失/)
    await assert.rejects(() => byName.ownshield_status.execute({}), /脚本缺失/)
  })

  test('built-in protocol prompt states the five rules', () => {
    const text = ownshieldPromptText()
    for (const needle of [
      'ownshield_snapshot',
      'ownshield_arm',
      '自动回滚',
      '三次',
      'ownshield_status',
      '撤防',
      '不要武装',
    ]) {
      assert.ok(text.includes(needle), `prompt 缺要点：${needle}`)
    }
    assert.ok(
      text.length >= 200 && text.length <= 300,
      `prompt 长度应在 200-300 字，实际 ${text.length}`,
    )
  })

  test('protocol prompt registers on the calling scope and honors promptEnabled', () => {
    const sections = []
    const { ctx, cleanups } = makeCtx({
      services: {
        systemPrompt: {
          section(entry) {
            sections.push(entry)
            return () => {}
          },
        },
      },
    })
    assert.equal(registerPrompt(ctx, { restartPromptEnabled: false, ownshieldPromptEnabled: true }), true)
    assert.equal(cleanups.length, 1)
    assert.equal(sections[0].name, PROMPT_SECTION_NAME)
    assert.equal(sections[0].order, PROMPT_ORDER)
    assert.ok(sections[0].text.includes('ownshield_arm'))

    const off = makeCtx({
      services: {
        systemPrompt: {
          section() {
            throw new Error('promptEnabled=false 时不应注册')
          },
        },
      },
    })
    assert.equal(registerPrompt(off.ctx, { restartPromptEnabled: false, ownshieldPromptEnabled: false }), false)
    assert.equal(off.cleanups.length, 0)
  })

  test('new P1 config defaults derive scriptsDir and keep prompt on', () => {
    const defaults = resolveOwnshieldConfig('C:\\pkg', {})
    assert.equal(defaults.scriptsDir, join('C:\\pkg', 'scripts', 'ownshield'))
    assert.equal(defaults.snapshotScriptPath, join('C:\\pkg', 'scripts', 'ownshield', 'snapshot.mjs'))
    assert.equal(defaults.armScriptPath, join('C:\\pkg', 'scripts', 'ownshield', 'arm.mjs'))
    assert.equal(defaults.promptEnabled, true)
    assert.equal(defaults.watchTaskName, 'ownshield-watch')

    const override = resolveOwnshieldConfig('C:\\pkg', {
      scriptsDir: 'E:\\HarnessWorkRoom\\tools\\ownshield',
      promptEnabled: false,
      watchTaskName: 'custom-watch',
    })
    assert.equal(override.scriptsDir, 'E:\\HarnessWorkRoom\\tools\\ownshield')
    assert.equal(override.armScriptPath, 'E:\\HarnessWorkRoom\\tools\\ownshield\\arm.mjs')
    assert.equal(override.promptEnabled, false)
    assert.equal(override.watchTaskName, 'custom-watch')
  })

  test('auth-gate 恒 ok=true：缺凭据只告警，不构成 probe-failure', () => {
    const home = join(workDir, 'auth-home')
    mkdirSync(home, { recursive: true })
    const blank = () => ({ name: 'auth-gate', ok: false, error: '', detail: '' })

    const missing = checkAuthGate({ env: { DSH_HOME: home, APPDATA: join(home, 'appdata') } }, blank())
    assert.equal(missing.ok, true, 'C 类只告警，缺凭据绝不能让探针变红')
    assert.ok(missing.warn.includes('凭据'), `warn 应点明缺凭据：${missing.warn}`)

    writeFileSync(join(home, '.credentials.yaml'), 'token: redacted\n')
    const present = checkAuthGate({ env: { DSH_HOME: home, APPDATA: join(home, 'appdata') } }, blank())
    assert.equal(present.ok, true)
    assert.ok(present.detail.includes('凭据文档存在'), present.detail)
    assert.equal(present.warn, '', '凭据在、无日志标记时不应有告警')
  })

  test('auth-gate 报本地 Web cookie 过期（11-19 那次 401 的真因）', () => {
    const home = join(workDir, 'cookie-home')
    const hostDir = join(home, 'logs', 'ds-harness-remote')
    mkdirSync(hostDir, { recursive: true })
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    const patch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    writeFileSync(patch, '- id: connection\n  config:\n    cookieMaxAgeDays: 1\n')

    const now = Date.now()
    const iso = (ms) => new Date(ms).toISOString()
    const hostLog = (startAgoMs, lastAgoMs) =>
      `${iso(now - startAgoMs)} [INFO] [ds-harness-remote] host identity ready {"deviceId":"x"}\n${iso(now - lastAgoMs)} [INFO] [ds-harness-remote] host rpc ok\n`

    const env = { DSH_HOME: home, APPDATA: join(home, 'appdata') }
    const blank = () => ({ name: 'auth-gate', ok: false, error: '', detail: '', warn: '' })
    assert.equal(resolveCookieMaxAgeDays(env, home), 1)

    // 进程跑了 30h、cookie 寿命 1 天 → 过期
    writeFileSync(join(hostDir, 'host.log'), hostLog(30 * 3_600_000, 60_000))
    const stale = checkWebCookieAge({ env, home, now })
    assert.equal(stale.state, 'stale')
    assert.ok(stale.detail.includes('401'), stale.detail)

    // 探针层面：过期只进 warn，ok 恒 true、绝不构成 probe-failure
    const gate = checkAuthGate({ env }, blank())
    assert.equal(gate.ok, true, 'C 类只告警')
    assert.ok(gate.warn.includes('401'), gate.warn)

    // 刚启动 → 不报
    writeFileSync(join(hostDir, 'host.log'), hostLog(10 * 60_000, 60_000))
    assert.equal(checkWebCookieAge({ env, home, now }).state, 'ok')

    // 日志不活跃（DSH 没在跑）→ 跳过，不误报
    writeFileSync(join(hostDir, 'host.log'), hostLog(30 * 3_600_000, 5 * 3_600_000))
    assert.equal(checkWebCookieAge({ env, home, now }).state, 'idle')

    // profile 未显式配置 → 不猜默认值
    writeFileSync(patch, '- id: connection\n')
    writeFileSync(join(hostDir, 'host.log'), hostLog(30 * 3_600_000, 60_000))
    assert.equal(checkWebCookieAge({ env, home, now }).state, 'unconfigured')
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

