#!/usr/bin/env node
/**
 * ownshield watch 的单元与集成测试（node:test，零依赖）。
 *
 *   node --test watch.test.mjs
 *
 * 覆盖验收要求：
 *   - 无 arm.json 立即退出，且不创建状态目录；
 *   - 造一份 arm.json + boot.json（死 pid）后 --dry-run 判定「将执行 L1」且不写文件；
 *   - 进程消失 / 新 crash log / 无心跳 / 探针结构性失败 四类判定分别正确；
 *   - L1 只用一次、之后降 L2；次数用尽交人。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkSnapshotGuard,
  classifyProbe,
  decideRecovery,
  evaluateSignals,
  nextLevel,
  levelTag,
  normalizeArm,
  normalizeBoot,
  normalizeState,
  parseCrashTime,
  parseTime,
  planLevels,
  probeInfra,
  resolveSnapshotDir,
  runWatch,
  sameBoot,
  sha256File,
  updateStrikes,
} from './watch.mjs';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ownshield-watch-test-${prefix}-`));
}

function bootRecord(now, overrides = {}) {
  return {
    armId: '',
    pid: 4242,
    startedAt: now - 60_000,
    detectedAt: now - 60_000,
    graceUntil: now + 60_000,
    crashBaseline: { newestTime: now - 120_000, newestName: 'crash-old.log', count: 1 },
    ...overrides,
  };
}

function armRecord(now, overrides = {}) {
  return {
    ...normalizeArm({
      tag: 'before-test',
      armedAt: iso(now - 600_000),
      graceSeconds: 120,
      maxLevel: 2,
      failures: 0,
      baselineTag: 'baseline',
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 时间与输入解析
// ---------------------------------------------------------------------------

test('parseCrashTime 按文件名解析 UTC 时间', () => {
  assert.equal(
    parseCrashTime('crash-2026-11-04T12-00-56-068Z-web-boot.log'),
    Date.UTC(2026, 10, 4, 12, 0, 56, 68),
  );
  assert.equal(parseCrashTime('not-a-crash.log'), null);
});

test('parseTime 接受 7 位小数、epoch 秒与毫秒', () => {
  assert.equal(parseTime('2026-11-16T15:42:57.7951357Z'), Date.UTC(2026, 10, 16, 15, 42, 57, 795));
  assert.equal(parseTime(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseTime('garbage'), null);
});

test('normalizeArm 补默认值并夹取越界值', () => {
  const arm = normalizeArm({ tag: 'x', armedAt: iso(T0) });
  assert.equal(arm.tag, 'x');
  assert.equal(arm.graceSeconds, 120);
  assert.equal(arm.maxLevel, 2);
  assert.equal(arm.failures, 0);
  assert.equal(arm.baselineTag, 'baseline');
  assert.equal(arm.maxRecoveryAttempts, 3);

  const clamped = normalizeArm({ tag: 'x', armedAt: iso(T0), maxLevel: 5, graceSeconds: 99999 });
  assert.equal(clamped.maxLevel, 2);
  assert.equal(clamped.graceSeconds, 3600);
  assert.ok(clamped.problems.length >= 2);
});

test('normalizeBoot 接受预置 boot.json，缺失字段回退', () => {
  const boot = normalizeBoot({ pid: 7, startedAt: iso(T0) });
  assert.equal(boot.pid, 7);
  assert.equal(boot.startedAt, T0);
  assert.equal(boot.detectedAt, T0);
  assert.equal(boot.graceUntil, T0 + 120_000);
  assert.equal(normalizeBoot({ nope: 1 }), null);
});

// ---------------------------------------------------------------------------
// 探针分类
// ---------------------------------------------------------------------------

test('classifyProbe 只把 A/B 类结构性失败判为回滚信号', () => {
  const structural = (error) => ({
    ok: false,
    checks: [{ name: 'create-session', ok: false, error, detail: '' }],
  });
  assert.equal(classifyProbe(structural('agent-preset/invalid: bad')).structural, true);
  assert.equal(classifyProbe(structural('Duplicate tool group identifier: outbound')).structural, true);
  assert.equal(classifyProbe(structural('resume failed for session x')).structural, true);
  assert.equal(classifyProbe(structural('session/not-found')).structural, true);
  assert.equal(classifyProbe(structural('agent-preset/locked')).structural, false);
  assert.equal(classifyProbe(structural('request timeout after 60000ms')).structural, false);
  assert.equal(classifyProbe(structural('HTTP 500')).structural, false);

  const inventory = {
    ok: false,
    checks: [{ name: 'tool-inventory', ok: false, error: '缺少预期工具: x', detail: '' }],
  };
  assert.deepEqual(classifyProbe(inventory), { structural: true, reason: 'tool-inventory-missing' });
  assert.equal(classifyProbe({ ok: true, checks: [] }).structural, false);
});

// ---------------------------------------------------------------------------
// 四类判定
// ---------------------------------------------------------------------------

test('进程消失（宽限期内）→ 硬失败 process-gone', () => {
  const now = T0;
  const signals = evaluateSignals({
    arm: armRecord(now),
    boot: bootRecord(now),
    now,
    procs: [],
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'process-gone');
  assert.equal(signals[0].hard, true);
});

test('进程存活 → 无信号（宽限期内还不查心跳）', () => {
  const now = T0;
  const boot = bootRecord(now);
  const signals = evaluateSignals({
    arm: armRecord(now),
    boot,
    now,
    procs: [{ pid: boot.pid, start: boot.startedAt }],
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  });
  assert.deepEqual(signals, []);
});

test('宽限期外进程消失仍算 process-gone（旧行为相反，2026-11-20 修正）', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 300_000, graceUntil: now - 180_000 });
  const signals = evaluateSignals({
    arm: armRecord(now),
    boot,
    now,
    procs: [],
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  });
  assert.equal(signals.some((signal) => signal.type === 'process-gone'), true);
});

test('新 crash log → 硬失败；旧 crash log 不算', () => {
  const now = T0;
  const boot = bootRecord(now);
  const alive = [{ pid: boot.pid, start: boot.startedAt }];
  const base = {
    arm: armRecord(now),
    boot,
    now,
    procs: alive,
    procsOk: true,
    heartbeats: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  };
  const fresh = evaluateSignals({
    ...base,
    crash: { ok: true, files: [{ name: 'crash-new.log', ts: now - 1_000 }] },
  });
  assert.deepEqual(
    fresh.map((signal) => signal.type),
    ['new-crash-log'],
  );
  assert.equal(fresh[0].hard, true);

  const old = evaluateSignals({
    ...base,
    crash: { ok: true, files: [{ name: 'crash-old.log', ts: now - 300_000 }] },
  });
  assert.deepEqual(old, []);
});

test('宽限期内无心跳 → 软失败 no-heartbeat；有新鲜心跳则无信号', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 300_000, graceUntil: now - 180_000 });
  const alive = [{ pid: boot.pid, start: boot.startedAt }];
  const base = {
    arm: armRecord(now),
    boot,
    now,
    procs: alive,
    procsOk: true,
    crash: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  };
  const none = evaluateSignals({ ...base, heartbeats: { ok: true, files: [] } });
  assert.deepEqual(
    none.map((signal) => signal.type),
    ['no-heartbeat'],
  );
  assert.equal(none[0].hard, false);

  const fresh = evaluateSignals({
    ...base,
    heartbeats: { ok: true, files: [{ name: 'hb-1.json', ts: now - 5_000 }] },
  });
  assert.deepEqual(fresh, []);
});

test('探针结构性失败 → 硬失败；网络类失败不算', () => {
  const now = T0;
  const boot = bootRecord(now);
  const alive = [{ pid: boot.pid, start: boot.startedAt }];
  const base = {
    arm: armRecord(now),
    boot,
    now,
    procs: alive,
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: true, files: [] },
  };
  const bad = evaluateSignals({
    ...base,
    probes: {
      ok: true,
      files: [
        {
          name: 'probe-1.json',
          ts: now - 1_000,
          ok: false,
          checks: [{ name: 'create-session', ok: false, error: 'agent-preset/invalid: preset tree', detail: '' }],
        },
      ],
    },
  });
  assert.deepEqual(
    bad.map((signal) => signal.type),
    ['probe-failure'],
  );
  assert.equal(bad[0].hard, true);

  const network = evaluateSignals({
    ...base,
    probes: {
      ok: true,
      files: [
        {
          name: 'probe-2.json',
          ts: now - 1_000,
          ok: false,
          checks: [{ name: 'prompt-first-turn', ok: false, error: 'timeout 60000ms', detail: '' }],
        },
      ],
    },
  });
  assert.deepEqual(network, []);
});

test('进程表查询失败时不做判定（避免误回滚）', () => {
  const now = T0;
  const signals = evaluateSignals({
    arm: armRecord(now),
    boot: bootRecord(now),
    now,
    procs: [],
    procsOk: false,
    crash: { ok: true, files: [{ name: 'crash-x.log', ts: now }] },
    heartbeats: { ok: true, files: [] },
    probes: { ok: true, files: [] },
  });
  assert.deepEqual(signals, []);
});

// ---------------------------------------------------------------------------
// 计数复现与触发
// ---------------------------------------------------------------------------

test('硬信号一次即触发恢复', () => {
  const decision = decideRecovery({
    signals: [{ type: 'new-crash-log', hard: true }],
    strikes: {},
  });
  assert.equal(decision.action, 'recover');
});

test('软信号首次观察，复现后才触发', () => {
  const soft = [{ type: 'no-heartbeat', hard: false }];
  let strikes = updateStrikes({}, soft, T0);
  assert.equal(strikes['no-heartbeat'].count, 1);
  assert.equal(decideRecovery({ signals: soft, strikes }).action, 'observe');

  strikes = updateStrikes(strikes, soft, T0 + 60_000);
  assert.equal(strikes['no-heartbeat'].count, 2);
  assert.equal(decideRecovery({ signals: soft, strikes }).action, 'recover');
});

test('信号消失时计数清零；两个软信号同时成立也触发', () => {
  const soft = [{ type: 'no-heartbeat', hard: false }];
  const strikes = updateStrikes(updateStrikes({}, soft, T0), [], T0 + 60_000);
  assert.deepEqual(strikes, {});

  const two = [{ type: 'a', hard: false }, { type: 'b', hard: false }];
  assert.equal(decideRecovery({ signals: two, strikes: {} }).action, 'recover');
});

// ---------------------------------------------------------------------------
// 分级
// ---------------------------------------------------------------------------

test('L1 只用一次，之后降 L2；次数用尽交人', () => {
  const arm = armRecord(T0);
  const fresh = normalizeState(null);
  assert.equal(nextLevel(arm, fresh), 'L1');

  const l1Used = normalizeState({ recoveryAttempts: 1, levelsUsed: { L1: true } });
  assert.equal(nextLevel(arm, l1Used), 'L2');

  const exhausted = normalizeState({ recoveryAttempts: 3, levelsUsed: { L1: true, L2: 2 } });
  assert.equal(nextLevel(arm, exhausted), null);
});

test('maxLevel=1 时 L1 用尽即交人', () => {
  const arm = { ...armRecord(T0), maxLevel: 1 };
  assert.equal(nextLevel(arm, normalizeState(null)), 'L1');
  assert.equal(nextLevel(arm, normalizeState({ recoveryAttempts: 1, levelsUsed: { L1: true } })), null);
});

test('maxLevel=3：L1 → L2 → L3，L3 用 profileTag，缺省退回 arm.tag', () => {
  const arm = { ...armRecord(T0), maxLevel: 3, profileTag: 'snap-with-profile' };
  assert.equal(nextLevel(arm, normalizeState(null)), 'L1');
  assert.equal(nextLevel(arm, normalizeState({ recoveryAttempts: 1, levelsUsed: { L1: true } })), 'L2');
  assert.equal(nextLevel(arm, normalizeState({ recoveryAttempts: 2, levelsUsed: { L1: true, L2: 1 } })), 'L3');
  // L3 用掉之后回到 L2，次数用尽交人
  assert.equal(
    nextLevel(arm, normalizeState({ recoveryAttempts: 3, levelsUsed: { L1: true, L2: 1, L3: true } })),
    null,
  );
  assert.deepEqual(
    planLevels(arm, normalizeState(null)).map((step) => step.level),
    ['L1', 'L2', 'L3'],
  );
  assert.equal(levelTag(arm, 'L3'), 'snap-with-profile');
  assert.equal(levelTag({ ...arm, profileTag: undefined }, 'L3'), arm.tag);
  assert.equal(levelTag(arm, 'L2'), arm.baselineTag);
});

test('planLevels 给出 L1 → L2 → L2 的只读计划', () => {
  const arm = armRecord(T0);
  assert.deepEqual(
    planLevels(arm, normalizeState(null)).map((step) => step.level),
    ['L1', 'L2', 'L2'],
  );
  assert.deepEqual(
    planLevels(arm, normalizeState({ recoveryAttempts: 1, levelsUsed: { L1: true } })).map(
      (step) => step.level,
    ),
    ['L2', 'L2'],
  );
  assert.deepEqual(planLevels({ ...arm, maxLevel: 1 }, normalizeState(null)).map((step) => step.level), ['L1']);
});

// ---------------------------------------------------------------------------
// 集成：CLI 级行为（直接调 runWatch，避免子进程管道限制）
// ---------------------------------------------------------------------------

test('无 arm.json 立即退出且不创建状态目录', () => {
  const dir = tmpDir('unarmed');
  const stateDir = path.join(dir, 'state');
  try {
    const result = runWatch({ dryRun: false, json: false, quiet: false, stateDir, exe: '' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.armed, false);
    assert.equal(fs.existsSync(stateDir), false, '未在看护时不应创建任何目录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run：造 arm.json + 死 pid boot.json → 判定将执行 L1，且零状态写入', () => {
  const dir = tmpDir('armed');
  const crashDir = path.join(dir, 'crash');
  fs.mkdirSync(crashDir);
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, 'arm.json'),
    JSON.stringify({
      tag: 'test-snapshot-tag',
      armedAt: iso(now - 60_000),
      graceSeconds: 3600,
      maxLevel: 2,
      failures: 0,
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'boot.json'),
    JSON.stringify({
      pid: 999_999,
      startedAt: iso(now - 10_000),
      detectedAt: iso(now - 10_000),
    }),
  );
  const previousCrashDir = process.env.OWNSHIELD_CRASH_DIR;
  process.env.OWNSHIELD_CRASH_DIR = crashDir;
  try {
    const result = runWatch({ dryRun: true, json: false, quiet: false, stateDir: dir, exe: '' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.decision.action, 'recover');
    assert.equal(result.output.decision.level, 'L1');
    assert.equal(result.output.decision.tag, 'test-snapshot-tag');
    assert.deepEqual(result.output.plan.map((step) => step.level), ['L1', 'L2', 'L2']);

    const names = fs.readdirSync(dir).sort();
    assert.deepEqual(
      names.filter((name) => !['arm.json', 'boot.json', 'crash'].includes(name)),
      [],
      'dry-run 不应写 recovery.log / watch-state.json 等状态文件',
    );
    assert.equal(fs.existsSync(path.join(dir, 'recovery.log')), false);
    assert.equal(fs.existsSync(path.join(dir, 'watch.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'watch-state.json')), false);
  } finally {
    if (previousCrashDir === undefined) delete process.env.OWNSHIELD_CRASH_DIR;
    else process.env.OWNSHIELD_CRASH_DIR = previousCrashDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('看护但尚未出现新启动时只等待，不做动作', () => {
  const dir = tmpDir('waiting');
  fs.writeFileSync(
    path.join(dir, 'arm.json'),
    JSON.stringify({
      tag: 'test-tag',
      armedAt: iso(Date.now() - 30_000),
      graceSeconds: 120,
      maxLevel: 2,
      failures: 0,
    }),
  );
  const previousCrashDir = process.env.OWNSHIELD_CRASH_DIR;
  process.env.OWNSHIELD_CRASH_DIR = path.join(dir, 'no-crash');
  try {
    const result = runWatch({ dryRun: true, json: false, quiet: false, stateDir: dir, exe: '' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.waiting, true);
    assert.equal(result.output.decision.reason.startsWith('waiting-for-boot'), true);
    assert.equal(fs.existsSync(path.join(dir, 'boot.json')), false);
  } finally {
    if (previousCrashDir === undefined) delete process.env.OWNSHIELD_CRASH_DIR;
    else process.env.OWNSHIELD_CRASH_DIR = previousCrashDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T6 补测：判定函数边界、连续失败计数、断电续跑
// ---------------------------------------------------------------------------

const alive = (boot) => [{ pid: boot.pid, start: boot.startedAt }];

test('sameBoot：同 pid 漂移 4s 仍算、6s 不算；不同 pid 超 3s 不算', () => {
  const boot = bootRecord(T0);
  assert.equal(sameBoot({ pid: boot.pid, start: boot.startedAt }, boot), true);
  assert.equal(sameBoot({ pid: boot.pid, start: boot.startedAt + 4_000 }, boot), true);
  assert.equal(sameBoot({ pid: boot.pid, start: boot.startedAt + 6_000 }, boot), false);
  assert.equal(sameBoot({ pid: 1, start: boot.startedAt + 4_000 }, boot), false);
  assert.equal(sameBoot(null, boot), false);
});

test('process-gone：宽限期前后都判（2026-11-20 修正，旧行为只判宽限期内）', () => {
  const boot = bootRecord(T0);
  const atGrace = evaluateSignals({
    arm: armRecord(T0),
    boot,
    now: boot.graceUntil,
    procs: [],
    procsOk: true,
    crash: { ok: false, files: [] },
    heartbeats: { ok: false, files: [] },
    probes: { ok: false, files: [] },
  });
  assert.deepEqual(atGrace.map((signal) => signal.type), ['process-gone']);
  assert.equal(atGrace[0].hard, true);

  const after = evaluateSignals({
    arm: armRecord(T0),
    boot,
    now: boot.graceUntil + 1,
    procs: [],
    procsOk: true,
    crash: { ok: false, files: [] },
    heartbeats: { ok: false, files: [] },
    probes: { ok: false, files: [] },
  });
  // 修正前这里期望空数组——那正是「看护超过 120 秒后崩溃无信号」的缺陷本身。
  assert.deepEqual(
    after.map((signal) => signal.type),
    ['process-gone'],
  );
  assert.equal(after[0].hard, true);
});

test('new-crash-log：晚于 boot 基线的新文件命中，boot 前旧文件与更早文件不命中', () => {
  const boot = bootRecord(T0);
  const base = {
    arm: armRecord(T0),
    boot,
    now: T0,
    procs: alive(boot),
    procsOk: true,
    crash: { ok: true, files: [] },
    heartbeats: { ok: false, files: [] },
    probes: { ok: false, files: [] },
  };
  const fresh = evaluateSignals({
    ...base,
    crash: { ok: true, files: [{ name: 'crash-2026-11-17T11-59-59-000Z-renderer.log', ts: T0 - 1_000 }] },
  });
  // 2026-11-20 分级后：renderer 类崩溃走软信号 renderer-crash，不再直接整机重启。
  assert.deepEqual(fresh.map((signal) => signal.type), ['renderer-crash']);

  const old = evaluateSignals({
    ...base,
    crash: { ok: true, files: [{ name: 'crash-2026-11-17T11-00-00-000Z-host.log', ts: T0 - 300_000 }] },
  });
  assert.deepEqual(old, []);

  const beforeBoot = evaluateSignals({
    ...base,
    boot: {
      ...boot,
      crashBaseline: { newestTime: T0 - 600_000, newestName: 'crash-ancient.log', count: 1 },
    },
    crash: { ok: true, files: [{ name: 'crash-2026-11-17T11-40-00-000Z-host.log', ts: T0 - 200_000 }] },
  });
  assert.deepEqual(beforeBoot, []);
});

test('探针失败：not-found/resume/session/tool-inventory 命中，429 与 5xx 不命中', () => {
  const structural = (error, name = 'create-session') =>
    classifyProbe({ ok: false, checks: [{ name, ok: false, error, detail: '' }] }).structural;
  assert.equal(structural('agent-preset/not-found: preset tree'), true);
  assert.equal(structural('resume failed for session x'), true);
  assert.equal(structural('session/not-found'), true);
  assert.equal(structural('429 Too Many Requests'), false);
  assert.equal(structural('HTTP 502 bad gateway'), false);
  assert.deepEqual(
    classifyProbe({
      ok: false,
      checks: [{ name: 'tool-inventory', ok: false, error: '缺少预期工具: read', detail: '' }],
    }),
    { structural: true, reason: 'tool-inventory-missing' },
  );
});

test('连续失败计数：软信号第 1 次观察、第 2/3 次触发，消失清零', () => {
  const soft = [{ type: 'no-heartbeat', hard: false }];
  let strikes = updateStrikes({}, soft, T0);
  assert.equal(strikes['no-heartbeat'].count, 1);
  assert.equal(decideRecovery({ signals: soft, strikes }).action, 'observe');
  for (const round of [2, 3]) {
    strikes = updateStrikes(strikes, soft, T0 + (round - 1) * 60_000);
    assert.equal(strikes['no-heartbeat'].count, round);
    assert.equal(decideRecovery({ signals: soft, strikes }).action, 'recover');
  }
  assert.deepEqual(updateStrikes(strikes, [], T0 + 240_000), {});
});

test('连续恢复失败：L1 失败后降 L2，三次尝试用尽交人，failures 达 maxFailures', () => {
  const arm = armRecord(T0);
  let state = normalizeState(null);
  const levels = [];
  for (let round = 0; round < 3; round += 1) {
    const level = nextLevel(arm, state);
    assert.ok(level, `第 ${round + 1} 次不应提前交人`);
    levels.push(level);
    state = normalizeState({
      ...state,
      recoveryAttempts: state.recoveryAttempts + 1,
      levelsUsed:
        level === 'L1'
          ? { ...state.levelsUsed, L1: true }
          : { ...state.levelsUsed, L2: (state.levelsUsed.L2 || 0) + 1 },
      failures: state.failures + 1,
    });
  }
  assert.deepEqual(levels, ['L1', 'L2', 'L2']);
  assert.equal(state.failures, arm.maxFailures);
  assert.equal(nextLevel(arm, state), null);
  assert.deepEqual(planLevels(arm, state), []);
});

test('断电续跑：normalizeState 保留 failures/attempts/levelsUsed/strikes，下一轮直接 L2', () => {
  const state = normalizeState({
    armId: 'abc123',
    failures: 2,
    recoveryAttempts: 1,
    levelsUsed: { L1: true },
    attempts: [{ level: 'L1', result: 'fail' }],
    strikes: { 'no-heartbeat': { count: 1, firstSeenAt: iso(T0), lastSeenAt: iso(T0) } },
    lastResult: 'recovery-failed',
  });
  assert.equal(state.failures, 2);
  assert.equal(state.recoveryAttempts, 1);
  assert.deepEqual(state.levelsUsed, { L1: true });
  assert.equal(state.attempts.length, 1);
  assert.equal(state.strikes['no-heartbeat'].count, 1);
  assert.equal(nextLevel(armRecord(T0), state), 'L2');
});

// ---------------------------------------------------------------------------
// 2026-11-20 新增：宽限期解耦 / 挂死心跳 / 正常退出
// ---------------------------------------------------------------------------

function signalsFor(now, { boot, arm, procs, heartbeats, crash }) {
  return evaluateSignals({
    arm: arm ?? armRecord(now),
    boot,
    now,
    procs: procs ?? [],
    procsOk: true,
    crash: crash ?? { ok: true, files: [] },
    heartbeats: heartbeats ?? { ok: true, files: [] },
    probes: { ok: true, files: [] },
  });
}

test('宽限期之后进程消失仍然报 process-gone（不再只保护启动后 120 秒）', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 3_600_000, graceUntil: now - 3_480_000 });
  const signals = signalsFor(now, { boot, procs: [] });
  const types = signals.map((signal) => signal.type);
  assert.ok(types.includes('process-gone'), `应报 process-gone，实际 ${types.join(',')}`);
  assert.equal(signals.find((signal) => signal.type === 'process-gone').hard, true);
});

test('arm.expectGracefulExit=true（带时间戳）时进程消失按正常退出处理，不产生 process-gone', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 3_600_000, graceUntil: now - 3_480_000 });
  const arm = armRecord(now, {
    expectGracefulExit: true,
    expectGracefulExitAt: new Date(now - 60_000).toISOString(),
  });
  const signals = signalsFor(now, { boot, arm, procs: [] });
  const types = signals.map((signal) => signal.type);
  assert.ok(types.includes('graceful-exit'), `应报 graceful-exit，实际 ${types.join(',')}`);
  assert.ok(!types.includes('process-gone'), '显式声明正常退出时不应报 process-gone');
  assert.equal(signals.find((signal) => signal.type === 'graceful-exit').hard, false);
});

test('标记过期或没有时间戳时不得放行（否则真崩溃不救）', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 3_600_000, graceUntil: now - 3_480_000 });

  const stale = armRecord(now, {
    expectGracefulExit: true,
    expectGracefulExitAt: new Date(now - 20 * 60_000).toISOString(),
  });
  const staleTypes = signalsFor(now, { boot, arm: stale, procs: [] }).map((signal) => signal.type);
  assert.ok(staleTypes.includes('process-gone'), `过期标记应报 process-gone，实际 ${staleTypes.join(',')}`);

  const noStamp = armRecord(now, { expectGracefulExit: true });
  const noStampTypes = signalsFor(now, { boot, arm: noStamp, procs: [] }).map((signal) => signal.type);
  assert.ok(
    noStampTypes.includes('process-gone'),
    `没写时间戳的标记应报 process-gone，实际 ${noStampTypes.join(',')}`,
  );
});

test('进程活着但心跳超过 90 秒未刷新 → heartbeat-stale（挂死形态）', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 300_000, graceUntil: now - 180_000 });
  const procs = [{ pid: boot.pid, start: boot.startedAt }];
  const stale = signalsFor(now, {
    boot,
    procs,
    heartbeats: { ok: true, files: [{ name: 'hb-x.json', ts: now - 200_000 }] },
  });
  const types = stale.map((signal) => signal.type);
  assert.ok(types.includes('heartbeat-stale'), `应报 heartbeat-stale，实际 ${types.join(',')}`);

  const fresh = signalsFor(now, {
    boot,
    procs,
    heartbeats: { ok: true, files: [{ name: 'hb-x.json', ts: now - 10_000 }] },
  });
  assert.deepEqual(fresh.map((signal) => signal.type), []);
});

test('心跳周期 30 秒时，90 秒阈值不会把正常进程误判为挂死', () => {
  const now = T0;
  const boot = bootRecord(now, { startedAt: now - 600_000, graceUntil: now - 480_000 });
  const procs = [{ pid: boot.pid, start: boot.startedAt }];
  // 连续三轮、每轮 30 秒间隔，心跳都在上一轮之后刷新过
  for (const age of [25_000, 28_000, 30_000]) {
    const signals = signalsFor(now + age, {
      boot,
      procs,
      heartbeats: { ok: true, files: [{ name: 'hb-x.json', ts: now + age - 30_000 }] },
    });
    assert.deepEqual(signals.map((signal) => signal.type), [], `age=${age} 不应有信号`);
  }
});

test('渲染进程崩溃 → 软信号 renderer-crash（不越级整机重启）', () => {
  const now = T0;
  const boot = bootRecord(now);
  const procs = [{ pid: boot.pid, start: boot.startedAt }];
  const signals = signalsFor(now, {
    boot,
    procs,
    crash: {
      ok: true,
      files: [{ name: 'crash-2026-11-20T05-05-07-384Z-renderer.log', ts: now - 1_000 }],
    },
  });
  const renderer = signals.find((signal) => signal.type === 'renderer-crash');
  assert.ok(renderer, `应报 renderer-crash，实际 ${signals.map((s) => s.type).join(',')}`);
  assert.equal(renderer.hard, false);
  assert.ok(!signals.some((signal) => signal.type === 'new-crash-log'), '渲染崩溃不应升级为硬信号');
});

test('主进程崩溃 → 硬信号 new-crash-log', () => {
  const now = T0;
  const boot = bootRecord(now);
  const procs = [{ pid: boot.pid, start: boot.startedAt }];
  const signals = signalsFor(now, {
    boot,
    procs,
    crash: {
      ok: true,
      files: [{ name: 'crash-2026-11-20T05-05-07-384Z-host.log', ts: now - 1_000 }],
    },
  });
  const hard = signals.find((signal) => signal.type === 'new-crash-log');
  assert.ok(hard, `应报 new-crash-log，实际 ${signals.map((s) => s.type).join(',')}`);
  assert.equal(hard.hard, true);
});



test('probeInfra：正常目录 ok；crash 路径被文件占位时判不可写', () => {
  const dir = tmpDir('infra');
  const good = probeInfra({ dir, crashDir: path.join(dir, 'logs'), checkTask: false });
  assert.equal(good.ok, true, good.problems.join(';'));

  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const bad = probeInfra({ dir, crashDir: blocker, checkTask: false });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('crash 目录不可写')));
});

/* ── 快照过期闸（2026-11-21）：DSH 升级后旧快照不能用来回滚 ── */

function snapshotFixture(prefix, { tag = 'baseline', withAsar = true, tamperAfterCreate = null } = {}) {
  const root = tmpDir(prefix);
  const asar = path.join(root, 'app.asar');
  fs.writeFileSync(asar, 'current-build-v1');
  const snaps = path.join(root, 'snapshots');
  const dir = path.join(snaps, `20260101T000000-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = withAsar
    ? [{ path: asar, rel: 'app.asar', size: fs.statSync(asar).size, sha256: sha256File(asar) }]
    : [];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, tag, files }));
  if (tamperAfterCreate !== null) fs.writeFileSync(asar, tamperAfterCreate);
  return { root, asar, snaps, dir };
}

test('checkSnapshotGuard：asar 与快照一致才放行', () => {
  const fx = snapshotFixture('guard-ok');
  assert.equal(resolveSnapshotDir('baseline', fx.snaps), fx.dir);
  const guard = checkSnapshotGuard('baseline', { dir: fx.snaps, asarPath: fx.asar });
  assert.equal(guard.ok, true, guard.detail);
  assert.equal(guard.reason, 'match');
  assert.equal(guard.sha256, sha256File(fx.asar));
});

test('checkSnapshotGuard：安装被换过（DSH 升级）→ 拒绝回滚，报 asar-mismatch', () => {
  const fx = snapshotFixture('guard-mismatch', { tamperAfterCreate: 'new-build-after-upgrade' });
  const guard = checkSnapshotGuard('baseline', { dir: fx.snaps, asarPath: fx.asar });
  assert.equal(guard.ok, false);
  assert.equal(guard.reason, 'asar-mismatch');
  assert.ok(guard.detail.includes('降级'), `详情应点明降级风险：${guard.detail}`);
  assert.notEqual(guard.expected, guard.actual);
});

test('checkSnapshotGuard：tag 不存在 / manifest 无 asar 条目都要拒绝', () => {
  const missing = snapshotFixture('guard-missing');
  const g1 = checkSnapshotGuard('nope', { dir: missing.snaps, asarPath: missing.asar });
  assert.equal(g1.ok, false);
  assert.equal(g1.reason, 'snapshot-missing');
  assert.ok(g1.detail.includes('nope'));

  const noAsar = snapshotFixture('guard-no-asar', { tag: 'hollow', withAsar: false });
  const g2 = checkSnapshotGuard('hollow', { dir: noAsar.snaps, asarPath: noAsar.asar });
  assert.equal(g2.ok, false);
  assert.equal(g2.reason, 'manifest-no-asar');
});
