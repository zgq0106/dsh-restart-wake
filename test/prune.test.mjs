/**
 * 快照清理（prune）的回归测试：快照库没有自动 GC，删错一次就是丢回滚点，
 * 所以这里把「谁必须保留、谁可以删、blob 怎么判孤儿」全部钉住。
 *
 * Run with: node test/prune.test.mjs
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'prune-test-'))
const snaps = join(root, 'snapshots')
const blobs = join(snaps, 'blobs')
mkdirSync(blobs, { recursive: true })

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
const blobA = sha('content-A')
const blobB = sha('content-B')
const blobC = sha('content-C')
const blobD = sha('content-D')
for (const [name, body] of [
  [blobA, 'content-A'],
  [blobB, 'content-B'],
  [blobC, 'content-C'],
  [blobD, 'content-D'],
]) {
  writeFileSync(join(blobs, name), body)
}

function makeSnapshot(dirName, tag, ts, shaList) {
  const dir = join(snaps, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      tag,
      ts,
      files: shaList.map((s, i) => ({ rel: `f${i}`, size: 1, sha256: s })),
    }),
  )
}

// 五份：old 被 arm.json 引用（最旧）、baseline 是已知好、t3 带一个只被它引用的 blob。
makeSnapshot('20261101T000000-old', 'old', '2026-11-01T00:00:00+08:00', [blobA])
makeSnapshot('20261102T000000-baseline', 'baseline', '2026-11-02T00:00:00+08:00', [blobA])
makeSnapshot('20261103T000000-t3', 't3', '2026-11-03T00:00:00+08:00', [blobD])
makeSnapshot('20261104T000000-t4', 't4', '2026-11-04T00:00:00+08:00', [blobB])
makeSnapshot('20261105T000000-t5', 't5', '2026-11-05T00:00:00+08:00', [blobC])
writeFileSync(join(root, 'arm.json'), JSON.stringify({ tag: 'old' }))

// snapshot.mjs 的库路径在模块加载时求值，所以必须先设环境变量再动态导入。
process.env.OWNSHIELD_SNAPSHOTS = snaps
const { prune } = await import('../scripts/ownshield/snapshot.mjs')

const snapshotDirs = () => readdirSync(snaps).filter((n) => n !== 'blobs' && n !== 'recovery.log').sort()
const blobNames = () => readdirSync(blobs).sort()

test('dry-run 只报告，不动任何文件', () => {
  const summary = prune({ dryRun: true, keep: 2, silent: true })
  assert.equal(summary.doomed.length, 1)
  assert.equal(summary.doomed[0].tag, 't3')
  assert.equal(snapshotDirs().length, 5)
  assert.equal(blobNames().length, 4)
})

test('arm 引用的与 baseline 永不删除，其余保留最近 N 份', () => {
  prune({ keep: 2, silent: true })
  const dirs = snapshotDirs()
  assert.equal(dirs.length, 4)
  assert.ok(dirs.some((n) => n.includes('old')), 'arm.json 引用的 old 必须保留')
  assert.ok(dirs.some((n) => n.includes('baseline')), 'baseline 必须保留')
  assert.ok(dirs.some((n) => n.includes('t4')) && dirs.some((n) => n.includes('t5')), '最近的 t4/t5 保留')
  assert.ok(!dirs.some((n) => n.includes('t3')), 't3 应被清理')
})

test('只回收没人引用的 blob，共享 blob 不能被误删', () => {
  const blobsLeft = blobNames()
  assert.ok(!blobsLeft.includes(blobD), '只被 t3 引用的 blob 应回收')
  assert.ok(blobsLeft.includes(blobA), 'old 与 baseline 共享的 blob 必须保留')
  assert.ok(blobsLeft.includes(blobB) && blobsLeft.includes(blobC), '在用 blob 保留')
  assert.equal(blobsLeft.length, 3)
})

test('再跑一次是幂等的', () => {
  const summary = prune({ keep: 2, silent: true })
  assert.equal(summary.doomed.length, 0)
  assert.equal(summary.blobs.orphans.length, 0)
  assert.equal(snapshotDirs().length, 4)
  assert.equal(blobNames().length, 3)
})

test('keep=0 也不会删掉被引用或被标记保留的快照', () => {
  const summary = prune({ keep: 0, silent: true })
  const keptTags = summary.survivors.map((m) => m.tag)
  assert.ok(keptTags.includes('old') && keptTags.includes('baseline'))
  // t4 / t5 不再受 keep 保护，会被清掉
  assert.ok(summary.doomed.some((m) => m.tag === 't4' || m.tag === 't5'))
})

test.after(() => rmSync(root, { recursive: true, force: true }))
