/**
 * 探针「用完即清」：会话归档（侧栏默认隐藏）+ 删临时 cwd。
 *
 * 面向小白用户的硬要求：自检不能在他侧栏里留下会话，也不能让临时目录越堆越多。
 * 这里只测清理本身——探测逻辑另有其测。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupProbeSession } from '../lib/probe.js';

test('cleanup：归档会话 + 删临时目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-clean-'));
  const calls = [];
  const ctx = {
    get: (name) =>
      name === 'workspaceRegistry'
        ? {
            archiveSession: async (id, opts) => {
              calls.push([id, opts]);
            },
          }
        : null,
  };

  const out = await cleanupProbeSession(ctx, { sessionId: 'session-x', cwd: dir });
  assert.equal(out.archived, true);
  assert.equal(out.tmpRemoved, true);
  assert.deepEqual(calls, [['session-x', { stopActivity: true }]]);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(out.errors, []);
});

test('cleanup：归档入口缺失时只记错误，临时目录照样清', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-clean-'));
  const ctx = { get: () => ({}) };

  const out = await cleanupProbeSession(ctx, { sessionId: 'session-y', cwd: dir });
  assert.equal(out.archived, false);
  assert.equal(out.tmpRemoved, true);
  assert.ok(out.errors.some((row) => row.startsWith('archive:')));
  assert.equal(fs.existsSync(dir), false);
});

test('cleanup：registry 层不认两参签名时退回 controller 层签名', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-clean-'));
  let attempts = 0;
  const ctx = {
    get: () => ({
      archiveSession: async (a, b) => {
        attempts += 1;
        // 第一轮带 opts 的第二参 → 模拟只认 request 对象的 controller 层
        if (b !== undefined) throw new Error('two-arg signature not supported');
      },
    }),
  };

  const out = await cleanupProbeSession(ctx, { sessionId: 'session-z', cwd: dir });
  assert.equal(attempts, 2);
  assert.equal(out.archived, true);
  assert.equal(out.tmpRemoved, true);
});

test('cleanup：没有会话也没有目录时不做多余动作', async () => {
  const ctx = { get: () => null };
  const out = await cleanupProbeSession(ctx, { sessionId: '', cwd: '' });
  assert.equal(out.archived, false);
  assert.equal(out.tmpRemoved, false);
  assert.deepEqual(out.errors, []);
});
