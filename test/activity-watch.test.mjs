/**
 * 「纸条即探针」的判定部分：真实事件 → 健康结论。
 * 采集在 lib/activity-watch.js；这里只验判定，不碰 DSH。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvent,
  emptyActivity,
  recordActivity,
  summarizeActivity,
  toolResultFailed,
} from '../lib/activity-watch.js';

const T0 = Date.parse('2026-11-22T10:00:00.000Z');

test('tool/result：成功、失败、结构不明的判定', () => {
  assert.equal(toolResultFailed({ ok: true, result: 'x' }), false);
  assert.equal(toolResultFailed({ ok: false }), true);
  assert.equal(toolResultFailed({ error: 'boom' }), true);
  assert.equal(toolResultFailed({ isError: true }), true);
  assert.equal(toolResultFailed({}), false);

  assert.deepEqual(classifyEvent({ type: 'tool/result', data: { name: 'read' } }), {
    kind: 'tool',
    ok: true,
    text: 'read',
  });
  assert.equal(classifyEvent({ type: 'tool/result', data: { error: 'x' } }).ok, false);
  assert.equal(classifyEvent({ type: 'assistant/message', data: {} }).ok, true);
  assert.equal(classifyEvent({ type: 'turn/end', data: { reason: 'error' } }).ok, false);
  assert.equal(classifyEvent({ type: 'turn/end', data: { reason: 'done' } }).ok, true);
  assert.equal(classifyEvent({ type: 'unknown' }), null);
});

test('有成功 → alive（单次工具报错不算坏）', () => {
  let state = emptyActivity(T0);
  state = recordActivity(state, { kind: 'tool', ok: false, text: 'read' }, { now: T0 });
  state = recordActivity(state, { kind: 'tool', ok: false, text: 'read' }, { now: T0 + 1000 });
  state = recordActivity(state, { kind: 'turn', ok: true, text: '' }, { now: T0 + 2000 });

  const out = summarizeActivity(state, { now: T0 + 3000 });
  assert.equal(out.verdict, 'alive');
  assert.equal(out.successes, 1);
  assert.equal(out.failures, 2);
});

test('连续失败且没有成功 → failing', () => {
  let state = emptyActivity(T0);
  for (let i = 0; i < 3; i += 1) {
    state = recordActivity(state, { kind: 'tool', ok: false, text: 'pwsh' }, { now: T0 + i });
  }
  const out = summarizeActivity(state, { now: T0 + 10 });
  assert.equal(out.verdict, 'failing');
  assert.equal(out.failures, 3);
  assert.equal(out.lastErrorText, 'pwsh');
});

test('窗口外的旧记录不算数', () => {
  let state = emptyActivity(T0);
  for (let i = 0; i < 5; i += 1) {
    state = recordActivity(state, { kind: 'tool', ok: false, text: 'old' }, { now: T0 });
  }
  const out = summarizeActivity(state, { now: T0 + 60 * 60 * 1000, windowMs: 10 * 60 * 1000 });
  assert.equal(out.verdict, 'idle');
  assert.equal(out.failures, 0);
});

test('没有流量 → idle，不下结论', () => {
  assert.equal(summarizeActivity(null, { now: T0 }).verdict, 'idle');
  assert.equal(summarizeActivity(emptyActivity(T0), { now: T0 }).verdict, 'idle');
});

test('记录上限：只保留最近 50 条', () => {
  let state = emptyActivity(T0);
  for (let i = 0; i < 80; i += 1) {
    state = recordActivity(state, { kind: 'tool', ok: i % 2 === 0, text: String(i) }, { now: T0 + i });
  }
  assert.equal(state.recent.length, 50);
  assert.equal(state.recent[0].text, '30');
});
