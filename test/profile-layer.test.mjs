/**
 * L3（profile 层）行为：`--profile-only` 只还原 profile，不碰 asar。
 *
 * 背景：看护链 L3 用「asar 已回滚过、根因在 profile 层」这一判断，只还原
 * patch / 预设 / package.json / link，不重复覆盖 asar。这里验三件事：
 *   1. 带 profile 的快照能只还原 profile 层，asar 保持原样；
 *   2. 不带 profile 的快照必须明确拒绝，而不是悄悄什么都不做；
 *   3. 看护侧（arm）能识别 manifest 里有没有 profile 层。
 *
 * 注意：snapshot.mjs 的快照库路径在模块加载时由 OWNSHIELD_SNAPSHOTS 解析并固定，
 * 所以整个文件只建一个沙盘、只 import 一次，各用例用不同 tag 区分。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownshield-l3-'));
  const asar = path.join(dir, 'app.asar');
  const profile = path.join(dir, 'profile');
  const store = path.join(dir, 'snapshots');
  fs.mkdirSync(path.join(profile, 'presets'), { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(asar, 'asar-v1');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: keepme\n      name: ok\n');
  fs.writeFileSync(path.join(profile, 'presets', 'p1.yml'), 'name: p1\n');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"desktop","dsh":{"profile":{"bundles":[]}}}\n');
  process.env.OWNSHIELD_SNAPSHOTS = store;
  process.env.OWNSHIELD_PROFILE_DIR = profile;
  return { dir, asar, profile, store };
})();

const snap = await import('../scripts/ownshield/snapshot.mjs');
const arm = await import('../scripts/ownshield/arm.mjs');

test('profile-only：只还原 profile 层，asar 保持不动', () => {
  snap.create({
    tag: 'l3t',
    paths: [box.asar],
    withProfile: true,
    profileDir: box.profile,
    json: false,
  });
  // create 的非 JSON 分支不返回对象；建没建成由下一步 restore 反证。
  assert.equal(arm.manifestHasProfile(box.store, 'l3t'), true);

  // 模拟「模型改坏了 profile、同时 asar 也被换过」：只该修 profile。
  fs.writeFileSync(path.join(box.profile, 'cordis.patch.yml'), '- insert:\n    - id: broken\n      name: BAD\n');
  fs.writeFileSync(box.asar, 'asar-v2');

  const out = snap.restore({ profileOnly: true, json: false }, 'l3t');
  assert.equal(out.ok, true);
  assert.equal(out.profileOnly, true);
  assert.equal(
    fs.readFileSync(path.join(box.profile, 'cordis.patch.yml'), 'utf8'),
    '- insert:\n    - id: keepme\n      name: ok\n',
  );
  // asar 一步都没碰：仍是改动后的内容
  assert.equal(fs.readFileSync(box.asar, 'utf8'), 'asar-v2');
  // 被替换的原文件留了备份，可人工回看
  const backups = fs.readdirSync(box.profile).filter((n) => n.startsWith('cordis.patch.yml.bak-'));
  assert.equal(backups.length, 1);
});

test('profile-only：asar-only 快照明确拒绝，不静默跳过', () => {
  snap.create({ tag: 'asaronly', paths: [box.asar], json: false });
  assert.throws(
    () => snap.restore({ profileOnly: true, json: false }, 'asaronly'),
    /不含 profile 层/,
  );
});

test('manifestHasProfile：带 profile 的快照为真，asar-only 为假', () => {
  snap.create({
    tag: 'withp',
    paths: [box.asar],
    withProfile: true,
    profileDir: box.profile,
    json: false,
  });
  snap.create({ tag: 'nop', paths: [box.asar], json: false });

  assert.equal(arm.manifestHasProfile(box.store, 'withp'), true);
  assert.equal(arm.manifestHasProfile(box.store, 'nop'), false);
  assert.equal(arm.manifestHasProfile(box.store, 'missing-tag'), false);
});
