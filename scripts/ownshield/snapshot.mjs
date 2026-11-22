#!/usr/bin/env node
/**
 * ownshield snapshot —— 内容寻址快照器（零依赖，仅 Node 标准库）
 *
 * 用法:
 *   node snapshot.mjs create --tag <名字> [--paths <文件或目录>]... [--json]
 *   node snapshot.mjs list [--json]
 *   node snapshot.mjs restore <tag> [--to <目标>] [--dry-run] [--json]
 *   node snapshot.mjs verify <tag> [--json]
 *
 * 目录约定（快照库默认 ~/.dsh/ownshield/snapshots，可用 OWNSHIELD_SNAPSHOTS 覆盖；
 * 旧版工作区 <脚本目录>/../.. 下的 snapshots 若已有快照则继续沿用并告警）:
 *   snapshots/blobs/<sha256>              内容寻址 blob（同内容只存一份）
 *   snapshots/<时间戳>-<tag>/manifest.json
 *   snapshots/recovery.log                每步审计日志（追加，一行一条）
 *
 * 硬约束:
 *   - 绝不删除任何原件；替换前先备份为 <目标>.bak-<时间戳>。
 *   - 所有写操作幂等：目标已存在同 sha256 则跳过。
 *   - 只写快照库与恢复目标；安装目录仅在 restore 非 --dry-run 时写。
 *
 * asar 结构解析复用同目录 asar.mjs（readArchive / summarize），不重复实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readArchive, summarize } from './asar.mjs';

const SCRIPT_DIR = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const WORKROOM = path.resolve(SCRIPT_DIR, '..', '..');
/** 旧版快照库位置（脚本目录上溯两级），只用于兼容存量。 */
const LEGACY_SNAPSHOTS = path.join(WORKROOM, 'snapshots');

/** 目录下是否已有快照（排除 blobs，必须有 manifest.json）。只读探测，不创建目录。 */
function hasSnapshotDirs(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((ent) => {
    if (!ent.isDirectory() || ent.name === 'blobs') return false;
    try {
      return fs.statSync(path.join(dir, ent.name, 'manifest.json')).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * 快照库解析顺序（与 watch.mjs 保持一致）：
 * 1. OWNSHIELD_SNAPSHOTS；2. 新默认 ~/.dsh/ownshield/snapshots 且含快照；
 * 3. 旧位置含快照则沿用并向 stderr 告警；4. 都没有 → 新默认（首次 create 会建）。
 */
function resolveSnapshotsDir() {
  const override = String(process.env.OWNSHIELD_SNAPSHOTS || '').trim();
  if (override) return path.resolve(override);
  const preferred = path.join(os.homedir(), '.dsh', 'ownshield', 'snapshots');
  if (hasSnapshotDirs(preferred)) return preferred;
  if (hasSnapshotDirs(LEGACY_SNAPSHOTS)) {
    console.error(
      `[ownshield] 快照库仍位于旧路径 ${LEGACY_SNAPSHOTS}，建议迁移到 ${preferred}（或设 OWNSHIELD_SNAPSHOTS）`,
    );
    return LEGACY_SNAPSHOTS;
  }
  return preferred;
}

const SNAPSHOTS = resolveSnapshotsDir();
const BLOBS = path.join(SNAPSHOTS, 'blobs');
const LOG = path.join(SNAPSHOTS, 'recovery.log');
/**
 * 快照默认对象：由 exe 推导安装根下的 app.asar。
 *
 * 解析顺序：OWNSHIELD_ASAR → OWNSHIELD_EXE → 运行中 DSH 进程的 ExecutablePath
 * → 常见安装位置。全部落空时返回 ''，由调用方明确报错——不写死任何盘符路径。
 * 进程表探测只在真要建默认快照时才做（restore/list/verify 不付这个成本）。
 */
function resolveInstallAsar() {
  const override = String(process.env.OWNSHIELD_ASAR || '').trim();
  if (override) return path.resolve(override);
  const fromEnv = String(process.env.OWNSHIELD_EXE || '').trim();
  if (fromEnv !== '') return path.join(path.dirname(fromEnv), 'resources', 'app.asar');
  const probed = probeInstalledExe();
  if (probed !== '') return path.join(path.dirname(probed), 'resources', 'app.asar');
  const common = commonExeCandidates().find((candidate) => fs.existsSync(candidate));
  return common ? path.join(path.dirname(common), 'resources', 'app.asar') : '';
}

/** 常见安装位置里的 DSH 可执行文件（不写死盘符）。 */
function commonExeCandidates() {
  const out = [];
  const programDirs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  for (const root of programDirs) {
    if (root) out.push(path.join(root, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    out.push(path.join(process.env.LOCALAPPDATA, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  }
  return out;
}

/**
 * 读运行中 DSH 进程的可执行文件路径（只读查询；用文件描述符接输出，沙箱下可用）。
 *
 * 先 Get-Process（取 Path），失败再退回 Get-CimInstance 的 ExecutablePath：
 * 2026-11-21 实测在受限环境下 `Get-CimInstance Win32_Process` 会静默返回空，
 * 只有 Get-Process 这条路拿得到 Path（arm.mjs / watch.mjs 同样以 Get-Process 兜底）。
 */
function probeInstalledExe() {
  const name = String(process.env.OWNSHIELD_PROC_NAME || '').trim() || 'DeepSeek Harness';
  const tmpDir = path.join(os.tmpdir(), 'ownshield-snapshot');
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `$name = '${name}'`,
    "$path = ''",
    '$p = Get-Process -Name $name -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1',
    'if ($p) { try { $path = [string]$p.Path } catch { $path = \'\' } }',
    'if ([string]::IsNullOrWhiteSpace($path)) {',
    '  try {',
    "    $c = Get-CimInstance Win32_Process -Filter \"Name='$name.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath } | Select-Object -First 1",
    '    if ($c) { $path = [string]$c.ExecutablePath }',
    '  } catch { }',
    '}',
    '$path',
  ].join('\n');
  const shells = [process.env.OWNSHIELD_PS, 'powershell.exe', 'pwsh'].filter((s, i, all) => s && all.indexOf(s) === i);
  for (const shell of shells) {
    const outFile = path.join(tmpDir, `exe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.out`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const fd = fs.openSync(outFile, 'w');
      try {
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: ['ignore', fd, 'ignore'],
          timeout: 20000,
          windowsHide: true,
        });
        if (result.error) continue;
        const value = fs.readFileSync(outFile, 'utf8').trim();
        if (value !== '' && fs.existsSync(value)) return value;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* 换下一个 shell */
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* 清理失败不影响结论 */ }
    }
  }
  return '';
}

/** 默认快照对象；第一次用到时才解析（可缓存，避免重复 PowerShell）。 */
let INSTALL_ASAR_CACHE = '';
function installAsarPath() {
  if (INSTALL_ASAR_CACHE === '') INSTALL_ASAR_CACHE = resolveInstallAsar();
  if (INSTALL_ASAR_CACHE === '') {
    throw new Error('找不到 DSH 安装位置（app.asar）：请设 OWNSHIELD_ASAR / OWNSHIELD_EXE，或用 --paths 显式指定快照对象');
  }
  return INSTALL_ASAR_CACHE;
}
/** profile 层默认目录（只读来源；restore 时才写）。测试用 --profile-dir 覆盖。 */
const DEFAULT_PROFILE_NAME = String(process.env.DSH_PROFILE || '').trim() || 'desktop';
const DEFAULT_PROFILE_DIR = process.env.OWNSHIELD_PROFILE_DIR
  ? path.resolve(process.env.OWNSHIELD_PROFILE_DIR)
  : path.join(os.homedir(), '.dsh', 'profiles', DEFAULT_PROFILE_NAME);
/** 预设目录候选（11-19 真机出现过的两种布局）。 */
const PRESET_DIR_NAMES = ['.agent-presets', 'presets'];
const MANIFEST = 'manifest.json';
const CHUNK = 1048576;

const fmt = (n) => Number(n).toLocaleString('en-US');
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';
const short = (s) => String(s).slice(0, 16);
const pad2 = (n) => String(n).padStart(2, '0');

function stampName(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function sanitizeTag(tag) {
  const t = String(tag || '').trim();
  if (!t) throw new Error('--tag 不能为空');
  if (t.length > 64) throw new Error('--tag 过长（最多 64 字符）');
  return t.replace(/[\\/:*?"<>|\s]+/g, '_');
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const blobPath = (sha) => path.join(BLOBS, sha);

function appendLog(fields) {
  const line =
    `[${isoLocal(new Date())}] ` +
    Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_')}`)
      .join(' ');
  try {
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch (err) {
    console.error(`警告: recovery.log 写入失败: ${err.message}`);
  }
}

function atomicWrite(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结论 */ }
    throw err;
  }
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSize(p);
    else if (ent.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function blobStats() {
  const count = { n: 0, bytes: 0 };
  if (!fs.existsSync(BLOBS)) return count;
  for (const ent of fs.readdirSync(BLOBS, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    count.n++;
    count.bytes += fs.statSync(path.join(BLOBS, ent.name)).size;
  }
  return count;
}

function readManifests({ quiet = false } = {}) {
  if (!fs.existsSync(SNAPSHOTS)) return [];
  const out = [];
  for (const ent of fs.readdirSync(SNAPSHOTS, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'blobs' || ent.name === 'quarantine') continue;
    const mf = path.join(SNAPSHOTS, ent.name, MANIFEST);
    if (!fs.existsSync(mf)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      m.dir = path.join(SNAPSHOTS, ent.name);
      m.dirName = ent.name;
      out.push(m);
    } catch (err) {
      if (!quiet) console.error(`警告: 跳过不可解析的 manifest: ${mf} (${err.message})`);
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

function resolveTag(tag) {
  const all = readManifests();
  const hit = all.filter((m) => m.tag === tag);
  if (!hit.length) return null;
  return hit[hit.length - 1]; // ts 已排序，取最新一代
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') { opts.tag = argv[++i]; if (opts.tag === undefined) throw new Error('--tag 缺少值'); }
    else if (a === '--paths') { const v = argv[++i]; if (v === undefined) throw new Error('--paths 缺少值'); (opts.paths ||= []).push(v); }
    else if (a === '--to') { opts.to = argv[++i]; if (opts.to === undefined) throw new Error('--to 缺少值'); }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep') { const v = argv[++i]; if (v === undefined) throw new Error('--keep 缺少值'); opts.keep = Number(v); }
    else if (a === '--keep-tag') { const v = argv[++i]; if (v === undefined) throw new Error('--keep-tag 缺少值'); (opts.keepTags ||= []).push(v); }
    else if (a === '--with-profile') opts.withProfile = true;
    else if (a === '--profile-dir') {
      opts.profileDir = argv[++i];
      if (opts.profileDir === undefined) throw new Error('--profile-dir 缺少值');
    }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`未知参数: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

/** 展开一个输入路径：目录递归、文件单条。prefix 用于多输入时避免相对路径撞车。 */
function collectInput(input, prefix) {
  const st = fs.statSync(input);
  if (st.isFile()) {
    return { root: { path: input, kind: 'file', name: path.basename(input) }, files: [{ path: input, rel: prefix + path.basename(input), size: st.size }] };
  }
  if (!st.isDirectory()) throw new Error(`不支持的文件类型（非文件/目录）: ${input}`);
  const files = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) files.push({ path: a, rel: prefix + r, size: fs.statSync(a).size });
      else console.error(`警告: 跳过非普通文件: ${a}`);
    }
  };
  walk(input, '');
  return { root: { path: input, kind: 'dir', name: path.basename(input) }, files };
}

function ensureBlob(sha, srcPath, size, stats) {
  const dest = blobPath(sha);
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size === size && sha256File(dest) === sha) {
      stats.reused++;
      return { existed: true };
    }
    appendLog({ op: 'blob-repair', sha: short(sha), note: '已有 blob 校验不一致，按内容重写' });
  }
  fs.mkdirSync(BLOBS, { recursive: true });
  const tmp = path.join(BLOBS, `.tmp-${process.pid}-${Date.now()}-${sha.slice(0, 8)}`);
  try {
    fs.copyFileSync(srcPath, tmp);
    const actual = sha256File(tmp);
    if (actual !== sha) throw new Error(`源文件在复制期间发生变化: ${srcPath}（期望 ${short(sha)}，实际 ${short(actual)}）`);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结论 */ }
    throw err;
  }
  stats.added++;
  stats.bytesAdded += size;
  return { existed: false };
}


// ─────────────────────────────────────────────────────────────────────────────
// profile 层（A5）：cordis.patch.yml + 备份链 / 预设目录 / 插件链接表
//
// 11-19 的真实故障（预设降级、5 个 junction 被误删）全在这一层，而 L1/L2 当时只回
// app.asar，等于救命时救错地方。这里默认关闭（--with-profile 才纳入），
// 保证 asar-only 的老行为一字不变。
// ─────────────────────────────────────────────────────────────────────────────

/** profile 目录：--profile-dir > 环境变量 > ~/.dsh/profiles/desktop。 */
export function resolveProfileDir(opts = {}) {
  return path.resolve(opts.profileDir || DEFAULT_PROFILE_DIR);
}

/** 读 package.json 的 dsh.profile.bundles（字符串或数组都认）。 */
export function readBundleList(profileDir) {
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) return { file, exists: false, bundles: [], error: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const declared = raw?.dsh?.profile?.bundles;
    const bundles = Array.isArray(declared) ? declared.map(String) : typeof declared === 'string' ? [declared] : [];
    return { file, exists: true, bundles, error: '' };
  } catch (err) {
    return { file, exists: true, bundles: [], error: err.message };
  }
}

/**
 * 判断一个路径是不是链接（symlink 或 Windows junction）。
 *
 * 坑（2026-11-21 本机实测）：Node 24 / libuv 对 **PowerShell 或安装器建的 junction**
 * 会在 lstat 里报成普通目录（isSymbolicLink()=false），readlinkSync 直接 EINVAL；
 * 而 fs.symlinkSync(..., 'junction') 建出来的又能被 lstat 认出来。真实 profile 里两种都有，
 * 所以这里三条路都试：lstat → realpath 是否指向别处。
 */
export function isLinkPath(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return true;
    const real = nativeRealpath(abs);
    return real !== '' && path.resolve(real) !== path.resolve(abs);
  } catch {
    return false;
  }
}

/** realpath 的 native 版本才认 Windows junction（JS 版会原样返回链接自身，2026-11-21 实测）。 */
function nativeRealpath(abs) {
  try {
    const fn = fs.realpathSync.native ?? fs.realpathSync;
    return fn(abs);
  } catch {
    return '';
  }
}

/** 读链接目标：优先 readlink（普通 symlink），失败退回 native realpath（junction 走这条）。 */
export function linkTargetOf(abs) {
  try {
    return fs.readlinkSync(abs);
  } catch {
    const real = nativeRealpath(abs);
    return real && path.resolve(real) !== path.resolve(abs) ? real : '';
  }
}

/** 枚举 node_modules 下指向工作区的 junction / symlink，记录链接本身与目标。 */
export function scanLinks(profileDir) {
  const root = path.join(profileDir, 'node_modules');
  const links = [];
  if (!fs.existsSync(root)) return links;
  const walk = (dir, depth) => {
    if (depth > 1) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.bin') continue;
      const abs = path.join(dir, ent.name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || ent.isSymbolicLink() || isLinkPath(abs)) {
        const target = linkTargetOf(abs);
        links.push({
          rel: path.relative(profileDir, abs).split(path.sep).join('/'),
          target,
          broken: target === '' || !fs.existsSync(target),
        });
        continue;
      }
      if (st.isDirectory() && ent.name.startsWith('@')) walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return links.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 收集 profile 层三类对象。缺项不猜：写进 problems，由调用方原样报出来。
 */
export function collectProfile(profileDir) {
  const dir = path.resolve(profileDir);
  const problems = [];
  const files = [];
  if (!fs.existsSync(dir)) return { dir, files, links: [], presets: [], bundles: [], problems: [`profile 目录不存在：${dir}`] };

  const patch = path.join(dir, 'cordis.patch.yml');
  if (fs.existsSync(patch)) files.push({ role: 'patch', path: patch, rel: 'cordis.patch.yml' });
  else problems.push(`缺 cordis.patch.yml：${patch}`);

  // 备份链：恢复时一起带回来，否则「回到上一版」无从下手。
  for (const name of fs.readdirSync(dir).filter((n) => /^cordis\.patch\.yml\.(bak|backup)/i.test(n)).sort()) {
    files.push({ role: 'patch-backup', path: path.join(dir, name), rel: name });
  }

  const presets = [];
  for (const name of PRESET_DIR_NAMES) {
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) continue;
    const inner = collectInput(abs, `${name}/`);
    presets.push({ name, path: abs, files: inner.files.length });
    for (const f of inner.files) files.push({ role: 'preset', path: f.path, rel: f.rel });
  }
  if (presets.length === 0) problems.push(`未找到预设目录（${PRESET_DIR_NAMES.join(' / ')}）：${dir}`);

  const pkg = readBundleList(dir);
  if (pkg.exists) files.push({ role: 'package-json', path: pkg.file, rel: 'package.json' });
  else problems.push(`缺 package.json：${pkg.file}`);
  if (pkg.error) problems.push(`package.json 解析失败：${pkg.error}`);

  return { dir, files, links: scanLinks(dir), presets, bundles: pkg.bundles, problems };
}

/** 目标路径映射：有 --to 就落到目标目录下，没有就按 manifest 记的原路径。 */
function profileTarget(rel, abs, toDir) {
  if (!toDir) return path.resolve(abs);
  return path.join(path.resolve(toDir), ...rel.split('/'));
}

/**
 * 恢复 profile 层。顺序固定：文件 → 链接 → patch。
 * 每步幂等（sha 相同跳过）、sha256 校验、缺项照实报「缺什么」。
 */
export function restoreProfile(m, opts = {}) {
  const prof = m?.profile;
  if (!prof) {
    throw new Error(`快照 ${m?.tag ?? ''} 没有 profile 段：建立快照时需要 --with-profile；缺什么就报什么，不猜`);
  }
  const stamp = stampName(new Date());
  const toDir = opts.to ? path.resolve(opts.to) : '';
  const dryRun = Boolean(opts.dryRun);
  const missing = [];
  const results = [];

  // ① 文件（patch 留到最后）
  const ordered = [...prof.files].sort((a, b) => (a.role === 'patch' ? 1 : 0) - (b.role === 'patch' ? 1 : 0));
  for (const f of ordered) {
    if (f.role === 'patch') continue;
    const target = profileTarget(f.rel, f.path, toDir);
    const blob = blobPath(f.sha256);
    if (!fs.existsSync(blob)) {
      missing.push(`缺 blob：${f.rel}（${short(f.sha256)}）`);
      continue;
    }
    if (dryRun) {
      results.push({ step: 'file', rel: f.rel, target, result: 'would-restore', exists: fs.existsSync(target) });
      continue;
    }
    results.push({ step: 'file', rel: f.rel, target, ...materialize({ sha: f.sha256, size: f.size, target, stamp }) });
  }

  // ② 链接（junction）：目标一致就跳过；不一致先备份再重建，绝不直接删。
  for (const link of prof.links) {
    const abs = toDir ? path.join(toDir, ...link.rel.split('/')) : path.join(prof.dir, ...link.rel.split('/'));
    const rel = link.rel;
    if (dryRun) {
      results.push({ step: 'link', rel, target: abs, result: 'would-link', exists: fs.existsSync(abs) });
      continue;
    }
    if (!fs.existsSync(link.target)) {
      missing.push(`链接目标不存在：${rel} → ${link.target}`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const exists = fs.existsSync(abs) || isLinkPath(abs);
    const current = exists ? linkTargetOf(abs) : '';
    if (exists && current === link.target) {
      results.push({ step: 'link', rel, target: abs, result: 'skip' });
      continue;
    }
    let backup = null;
    if (exists) {
      backup = `${abs}.bak-${stamp}`;
      fs.renameSync(abs, backup);
    }
    fs.symlinkSync(link.target, abs, 'junction');
    const check = linkTargetOf(abs);
    results.push({
      step: 'link',
      rel,
      target: abs,
      result: check === link.target ? 'linked' : 'link-mismatch',
      backup,
      linkTarget: link.target,
    });
  }

  // ③ patch 最后落：链接好了之后再让 patch 生效，避免「patch 引用的包还没接上」。
  const patchFile = prof.files.find((f) => f.role === 'patch');
  if (!patchFile) {
    missing.push('manifest 缺 patch 记录（profile.files 里没有 role=patch）');
  } else {
    const target = profileTarget(patchFile.rel, patchFile.path, toDir);
    const blob = blobPath(patchFile.sha256);
    if (!fs.existsSync(blob)) {
      missing.push(`缺 blob：${patchFile.rel}（${short(patchFile.sha256)}）`);
    } else if (dryRun) {
      results.push({ step: 'patch', rel: patchFile.rel, target, result: 'would-restore', exists: fs.existsSync(target) });
    } else {
      results.push({ step: 'patch', rel: patchFile.rel, target, ...materialize({ sha: patchFile.sha256, size: patchFile.size, target, stamp }) });
    }
  }

  return { ok: missing.length === 0, dryRun, profileDir: prof.dir, toDir: toDir || '', results, missing };
}

/** 从 blob 落到目标：sha 相同跳过；不同先备份；落完再校验。 */
function materialize({ sha, size, target, stamp }) {
  if (fs.existsSync(target)) {
    const cur = sha256File(target);
    if (cur === sha) return { result: 'skip', sha256: sha };
    const backup = `${target}.bak-${stamp}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(target, backup);
    if (sha256File(backup) !== cur) throw new Error(`备份校验失败（原件未动）：${backup}`);
    fs.copyFileSync(blobPath(sha), target);
    const final = sha256File(target);
    if (final !== sha) throw new Error(`还原后校验失败：${target}`);
    return { result: 'replaced', backup, sha256: sha };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(blobPath(sha), target);
  const final = sha256File(target);
  if (final !== sha) throw new Error(`还原后校验失败：${target}`);
  return { result: 'created', sha256: sha, size };
}

function asarInfo(file) {
  const { header, jsonLen, dataStart, dataLen } = readArchive(file);
  const s = summarize(header);
  return {
    jsonLen, dataStart, dataLen,
    files: s.files, dirs: s.dirs, links: s.links,
    unpacked: s.unpacked, bytesStored: s.bytesStored, bytesUnpacked: s.bytesUnpacked,
  };
}

function create(opts) {
  const tag = sanitizeTag(opts.tag);
  const inputs = (opts.paths?.length ? opts.paths : [installAsarPath()]).map((p) => path.resolve(p));
  const multiRoot = inputs.length > 1;

  const roots = [];
  const files = [];
  for (const input of inputs) {
    const { root, files: fsFiles } = collectInput(input, multiRoot ? path.basename(input) + '/' : '');
    roots.push(root);
    files.push(...fsFiles);
  }
  if (!files.length) throw new Error('待快照内容为空');

  // A5：profile 层默认不纳入，--with-profile 才进 manifest（asar-only 行为一字不变）。
  let profile = null;
  if (opts.withProfile) {
    const collected = collectProfile(opts.profileDir || DEFAULT_PROFILE_DIR);
    profile = {
      dir: collected.dir,
      presets: collected.presets,
      bundles: collected.bundles,
      links: collected.links,
      problems: collected.problems,
      files: [],
    };
    for (const f of collected.files) {
      files.push({
        path: f.path,
        rel: `profile/${f.rel}`,
        size: fs.statSync(f.path).size,
        role: f.role,
        profileRel: f.rel,
      });
    }
  }

  const relSeen = new Set();
  for (const f of files) {
    if (relSeen.has(f.rel)) throw new Error(`快照内相对路径冲突: ${f.rel}`);
    relSeen.add(f.rel);
  }

  const t0 = Date.now();
  for (const f of files) f.sha256 = sha256File(f.path);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  const fingerprint = sha256Text(JSON.stringify({
    roots: roots.map((r) => ({ path: r.path, kind: r.kind })),
    files: files.map((f) => ({ rel: f.rel, size: f.size, sha256: f.sha256 })),
  }));
  const single = roots.length === 1 && roots[0].kind === 'file';
  const sourceSha256 = single && files.length === 1 ? files[0].sha256 : fingerprint;

  if (profile) {
    profile.files = files
      .filter((f) => f.role)
      .map((f) => ({ rel: f.profileRel, path: f.path, size: f.size, sha256: f.sha256, role: f.role }));
  }

  // 幂等：同 tag + 同内容 + 同源路径 → 不重复建快照，只复用已有
  const dup = readManifests().filter((m) => m.tag === tag && m.fingerprint === fingerprint);
  if (dup.length) {
    const m = dup[dup.length - 1];
    appendLog({ op: 'create', tag, snapshot: m.dirName, sha: short(sourceSha256), result: 'skip', reason: 'same-content' });
    const out = { ok: true, skipped: true, tag, snapshot: m.dirName, dir: m.dir, sourceSha256, blobs: blobStats().n, storeBytes: dirSize(SNAPSHOTS) };
    if (opts.json) return console.log(JSON.stringify(out, null, 2));
    console.log(`未新建快照（幂等跳过）: tag=${tag} 已存在相同内容快照`);
    console.log(`  快照: ${m.dirName}`);
    console.log(`  sha256: ${sourceSha256}`);
    console.log(`  如确需再建一代，请换一个 tag。`);
    return;
  }

  const now = new Date();
  const stamp = `${stampName(now)}-${tag}`;
  let dirName = stamp;
  for (let n = 2; fs.existsSync(path.join(SNAPSHOTS, dirName)); n++) dirName = `${stamp}-${n}`;

  const stats = { added: 0, reused: 0, bytesAdded: 0 };
  for (const f of files) ensureBlob(f.sha256, f.path, f.size, stats);

  let archive = null;
  let archiveError = null;
  if (single && /\.asar$/i.test(inputs[0])) {
    try { archive = asarInfo(inputs[0]); }
    catch (err) { archiveError = err.message; }
  }

  const manifest = {
    version: 1,
    tag,
    ts: isoLocal(now),
    sourceSha256,
    fingerprint,
    files: files.map((f) => ({ path: f.path, rel: f.rel, size: f.size, sha256: f.sha256 })),
    createdBy: `${process.env.USERNAME || 'unknown'}@${os.hostname()}`,
    roots,
    ...(archive ? { archive } : {}),
    ...(archiveError ? { archiveError } : {}),
    ...(profile ? { profile } : {}),
  };

  const dir = path.join(SNAPSHOTS, dirName);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));

  appendLog({
    op: 'create', tag, snapshot: dirName, sha: short(sourceSha256),
    blobs_new: stats.added, blobs_reused: stats.reused, bytes_added: stats.bytesAdded, total_bytes: totalBytes,
  });

  const blobs = blobStats();
  const store = dirSize(SNAPSHOTS);
  const out = {
    ok: true, skipped: false, tag, snapshot: dirName, dir, sourceSha256, fingerprint,
    files: files.length, bytes: totalBytes, blobsAdded: stats.added, blobsReused: stats.reused,
    blobs: blobs.n, blobBytes: blobs.bytes, storeBytes: store, archive, archiveError,
    ...(profile
      ? {
          profile: {
            dir: profile.dir,
            files: profile.files.length,
            links: profile.links.length,
            presets: profile.presets.map((p) => p.name),
            bundles: profile.bundles,
            problems: profile.problems,
          },
        }
      : {}),
  };

  if (opts.json) return console.log(JSON.stringify(out, null, 2));
  console.log(`快照已创建: ${tag}`);
  console.log(`  路径: ${dir}`);
  console.log(`  sha256: ${sourceSha256}`);
  console.log(`  内容: ${files.length} 个文件 / ${fmt(totalBytes)} 字节 (${mib(totalBytes)})`);
  if (archive) console.log(`  asar: 条目 ${fmt(archive.files)}（unpacked ${fmt(archive.unpacked)}）目录 ${fmt(archive.dirs)} 数据区 ${fmt(archive.dataLen)} 字节`);
  if (archiveError) console.error(`  警告: asar 解析失败（快照仍已创建）: ${archiveError}`);
  console.log(`  blob: 新增 ${stats.added} / 复用 ${stats.reused}${stats.added ? `（新增 ${mib(stats.bytesAdded)}）` : '（内容未变，零新增字节）'}`);
  console.log(`  快照库: blob ${blobs.n} 个共 ${mib(blobs.bytes)}；物理总计 ${mib(store)}`);
}

function list(opts) {
  const all = readManifests();
  const blobs = blobStats();
  const store = dirSize(SNAPSHOTS);
  const logical = all.reduce((a, m) => a + m.files.reduce((x, f) => x + f.size, 0), 0);

  if (opts.json) {
    return console.log(JSON.stringify({
      ok: true,
      snapshots: all.map((m) => ({
        dir: m.dirName, tag: m.tag, ts: m.ts, sha256: m.sourceSha256,
        files: m.files.length, bytes: m.files.reduce((a, f) => a + f.size, 0),
      })),
      blobs: { count: blobs.n, bytes: blobs.bytes },
      storeBytes: store, logicalBytes: logical,
    }, null, 2));
  }

  if (!all.length) {
    console.log(`暂无快照（目录: ${SNAPSHOTS}）`);
    return;
  }
  console.log(`快照列表（共 ${all.length} 个；blob ${blobs.n} 个 ${mib(blobs.bytes)}；物理总计 ${mib(store)}）`);
  const rows = all.map((m) => {
    const bytes = m.files.reduce((a, f) => a + f.size, 0);
    return [m.ts, m.tag, short(m.sourceSha256), mib(bytes), String(m.files.length), m.dirName];
  });
  const head = ['时间', 'tag', 'sha256', '大小', '文件', '快照目录'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] + 2))).join('');
  console.log(line(head));
  console.log(line(widths.map((w) => '-'.repeat(w + 2))));
  for (const r of rows) console.log(line(r));
  if (logical > 0) console.log(`去重: 逻辑总量 ${mib(logical)} → 物理 ${mib(store)}（${(store / logical * 100).toFixed(1)}%）`);
}

function verify(opts, tag) {
  const m = resolveTag(tag);
  if (!m) throw new Error(`快照不存在: ${tag}`);
  const issues = [];
  let bytes = 0;
  for (const f of m.files) {
    const blob = blobPath(f.sha256);
    if (!fs.existsSync(blob)) { issues.push(`${f.rel}: blob 缺失 ${short(f.sha256)}`); continue; }
    const st = fs.statSync(blob);
    if (st.size !== f.size) issues.push(`${f.rel}: 大小不符 blob=${st.size} manifest=${f.size}`);
    const actual = sha256File(blob);
    if (actual !== f.sha256) issues.push(`${f.rel}: sha256 不符 blob=${short(actual)} manifest=${short(f.sha256)}`);
    bytes += f.size;
  }
  // A5：profile 段的 blob 也要参与校验，否则「快照看起来完整」但 patch 还原不回来。
  for (const f of m.profile?.files ?? []) {
    const blob = blobPath(f.sha256);
    if (!fs.existsSync(blob)) {
      issues.push(`profile/${f.rel}: blob 缺失 ${short(f.sha256)}`);
      continue;
    }
    const actual = sha256File(blob);
    if (actual !== f.sha256) issues.push(`profile/${f.rel}: sha256 不符 blob=${short(actual)} manifest=${short(f.sha256)}`);
  }
  for (const link of m.profile?.links ?? []) {
    if (!link.target || !fs.existsSync(link.target)) issues.push(`链接目标不存在：${link.rel} → ${link.target}`);
  }

  // 附加：asar 快照可解析性 + 头部统计与 manifest 记录交叉核对
  let archiveCheck = null;
  const singleAsar = m.roots?.length === 1 && m.roots[0].kind === 'file' && /\.asar$/i.test(m.roots[0].path) && m.files.length === 1;
  if (singleAsar && !issues.length) {
    try {
      const info = asarInfo(blobPath(m.files[0].sha256));
      archiveCheck = info;
      const a = m.archive;
      if (a) {
        for (const k of ['jsonLen', 'dataStart', 'files', 'dirs', 'unpacked', 'bytesStored', 'bytesUnpacked']) {
          if (a[k] !== info[k]) issues.push(`archive.${k}: manifest=${a[k]} 实测=${info[k]}`);
        }
      }
    } catch (err) {
      issues.push(`asar 解析失败: ${err.message}`);
    }
  }

  appendLog({ op: 'verify', tag, snapshot: m.dirName, result: issues.length ? 'fail' : 'ok', files: m.files.length, errors: issues.length });
  const out = { ok: issues.length === 0, tag, snapshot: m.dirName, files: m.files.length, bytes, sha256: m.sourceSha256, issues, archive: archiveCheck };
  if (opts.json) return console.log(JSON.stringify(out, null, 2));
  if (issues.length) {
    console.error(`快照 verify 失败: ${tag}（${issues.length} 处问题）`);
    for (const i of issues) console.error(`  - ${i}`);
    process.exitCode = 1;
    return;
  }
  console.log(`快照 verify 通过: ${tag}`);
  console.log(`  快照: ${m.dirName}`);
  console.log(`  sha256: ${m.sourceSha256}`);
  console.log(`  文件: ${m.files.length} 个 / ${fmt(bytes)} 字节 (${mib(bytes)})，blob 全部存在且校验一致`);
  if (archiveCheck) console.log(`  asar: 条目 ${fmt(archiveCheck.files)}（unpacked ${fmt(archiveCheck.unpacked)}）目录 ${fmt(archiveCheck.dirs)}，头部统计与 manifest 一致`);
}

function planRestore(m, opts) {
  const multi = !(m.roots?.length === 1 && m.roots[0].kind === 'file');
  if (multi) {
    if (!opts.to) throw new Error('目录/多文件快照还原必须指定 --to <目标目录>');
    const root = path.resolve(opts.to);
    return m.files.map((f) => ({ file: f, target: path.join(root, ...f.rel.split('/')) }));
  }
  const f = m.files[0];
  const target = opts.to ? path.resolve(opts.to) : path.resolve(f.path);
  return [{ file: f, target }];
}

function restore(opts, tag) {
  const m = resolveTag(tag);
  if (!m) throw new Error(`快照不存在: ${tag}`);

  // A5：--with-profile 时先跑 profile 层（文件 → 链接 → patch），再做 asar 层。
  let profile = null;
  if (opts.withProfile) {
    profile = restoreProfile(m, opts);
    const stampLabel = profile.dryRun ? '[DRY-RUN] ' : '';
    for (const r of profile.results) console.log(`${stampLabel}profile/${r.rel}: ${r.result} → ${r.target}`);
    for (const miss of profile.missing) console.error(`  缺项: ${miss}`);
    if (profile.results.some((r) => r.result === 'link-mismatch')) {
      console.error('  警告: 有链接创建后目标不一致（可能是权限或被占用）');
    }
    if (opts.dryRun) {
      const out = { ok: profile.ok, dryRun: true, tag, snapshot: m.dirName, profile };
      if (opts.json) return console.log(JSON.stringify(out, null, 2));
      console.log(`[DRY-RUN] profile 层校验完成：${profile.results.length} 步，缺项 ${profile.missing.length} 处`);
      return;
    }
  }

  const plan = planRestore(m, opts);
  const stamp = stampName(new Date());

  // 1) 写入前先全量校验 blob，任何不一致都不动目标文件
  for (const { file, target } of plan) {
    const blob = blobPath(file.sha256);
    if (!fs.existsSync(blob)) throw new Error(`blob 缺失，拒绝还原: ${short(file.sha256)}（${file.rel}）`);
    const st = fs.statSync(blob);
    if (st.size !== file.size) throw new Error(`blob 大小不符，拒绝还原: ${file.rel} blob=${st.size} manifest=${file.size}`);
    const actual = sha256File(blob);
    if (actual !== file.sha256) throw new Error(`blob sha256 不符，拒绝还原: ${file.rel} 期望=${short(file.sha256)} 实际=${short(actual)}`);
  }

  if (opts.dryRun) {
    for (const { file, target } of plan) {
      appendLog({ op: 'restore', tag, snapshot: m.dirName, target, sha: short(file.sha256), mode: 'dry-run', result: 'verified' });
    }
    const out = {
      ok: true, dryRun: true, tag, snapshot: m.dirName,
      targets: plan.map(({ file, target }) => ({ target, sha256: file.sha256, size: file.size, exists: fs.existsSync(target) })),
      wouldBackup: plan.filter(({ target }) => fs.existsSync(target)).map(({ target }) => `${target}.bak-${stamp}`),
    };
    if (opts.json) return console.log(JSON.stringify(out, null, 2));
    console.log(`[DRY-RUN] 快照 ${tag} 校验通过，未写入任何文件`);
    for (const { file, target } of plan) {
      const exists = fs.existsSync(target);
      console.log(`  将还原: ${target} ← blob ${short(file.sha256)} (${mib(file.size)})${exists ? '；原文件先备份' : '；目标不存在，新建'}`);
    }
    console.log(`  备份前缀: <目标>.bak-${stamp}`);
    return;
  }

  const results = [];
  let skipped = 0;
  for (const { file, target } of plan) {
    if (fs.existsSync(target)) {
      const cur = sha256File(target);
      if (cur === file.sha256) {
        skipped++;
        appendLog({ op: 'restore', tag, snapshot: m.dirName, target, result: 'skip', reason: 'already-same-sha' });
        results.push({ target, action: 'skip', sha256: file.sha256, backup: null });
        continue;
      }
      const backup = `${target}.bak-${stamp}`;
      const bak = fs.existsSync(backup) ? `${backup}-${filesSuffix(backup)}` : backup;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(target, bak);
      const bakSha = sha256File(bak);
      if (bakSha !== cur) throw new Error(`备份校验失败（原件未动）: ${bak} 期望=${short(cur)} 实际=${short(bakSha)}`);
      appendLog({ op: 'restore', tag, snapshot: m.dirName, target, backup: bak, result: 'backup', sha: short(cur) });
      results.push({ target, action: 'backup', backup: bak, sha256: file.sha256 });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      results.push({ target, action: 'create', backup: null, sha256: file.sha256 });
    }

    const tmp = `${target}.tmp-${stamp}`;
    try {
      fs.copyFileSync(blobPath(file.sha256), tmp);
      const tmpSha = sha256File(tmp);
      if (tmpSha !== file.sha256) throw new Error(`临时文件校验失败（原件未动）: ${tmp}`);
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结论 */ }
      appendLog({ op: 'restore', tag, snapshot: m.dirName, target, result: 'fail', reason: err.message });
      throw err;
    }
    const finalSha = sha256File(target);
    if (finalSha !== file.sha256) throw new Error(`还原后校验失败: ${target} 期望=${short(file.sha256)} 实际=${short(finalSha)}`);
    appendLog({ op: 'restore', tag, snapshot: m.dirName, target, result: 'ok', sha: short(file.sha256) });
  }

  const out = {
    ok: true, dryRun: false, tag, snapshot: m.dirName,
    restored: results.filter((r) => r.action !== 'skip').length, skipped, results,
    ...(profile ? { profile } : {}),
  };
  if (opts.json) return console.log(JSON.stringify(out, null, 2));
  console.log(`还原完成: ${tag}`);
  for (const r of results) {
    const label = r.action === 'skip' ? '已是目标内容，跳过（未备份）' : r.action === 'backup' ? `已备份为 ${r.backup} 后替换` : '目标不存在，新建';
    console.log(`  ${r.target}  ${label}`);
  }
  console.log(`  快照: ${m.dirName}；sha256: ${m.sourceSha256}`);
  if (skipped) console.log(`  幂等: ${skipped} 个目标内容已一致，未做任何写入。`);
}

/** 读 arm.json 的 tag：当前唯一被看护引用的回滚点，prune 必须保住。 */
function readArmTag() {
  try {
    const file = path.join(path.dirname(SNAPSHOTS), 'arm.json');
    if (!fs.existsSync(file)) return '';
    const raw = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
    return typeof raw?.tag === 'string' ? raw.tag : '';
  } catch {
    return '';
  }
}

/**
 * prune：清理旧快照并回收孤儿 blob。
 *
 * 快照库没有自动 GC，asar 每变一次就多一份 ~200 MB 的 blob，所以这里把「删」做成
 * 一条有护栏的显式命令，而不是让它无限长。安全规则按顺序：
 *   1. `arm.json` 引用的 tag **永不删除**——那是当前唯一的回滚点；
 *   2. `--keep-tag`（默认 `baseline`）**永不删除**——已知好版本；
 *   3. 其余按 ts 从新到旧保留 `--keep` 份（默认 3），更早的才进删除名单；
 *   4. blob 回收放在最后：只用**删完之后剩余**的 manifest 建引用集合，
 *      不在集合里的才算孤儿——宁可少删一个孤块，也不删错一个活块。
 */
function prune(opts) {
  const dryRun = opts.dryRun === true;
  const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : 3;
  const keepTags = new Set(['baseline', ...(opts.keepTags || [])]);
  const armTag = readArmTag();
  if (armTag) keepTags.add(armTag);

  const all = readManifests(); // ts 升序：最旧在前
  const newestFirst = [...all].reverse();

  const survivors = new Set();
  let kept = 0;
  for (const m of newestFirst) {
    if (keepTags.has(m.tag)) {
      survivors.add(m.dirName);
      continue;
    }
    if (kept < keep) {
      survivors.add(m.dirName);
      kept++;
      continue;
    }
  }

  const doomed = all.filter((m) => !survivors.has(m.dirName));

  const referenced = new Set();
  for (const m of all) {
    if (!survivors.has(m.dirName)) continue;
    for (const f of m.files || []) {
      if (f && typeof f.sha256 === 'string') referenced.add(f.sha256);
    }
  }

  let blobAll = [];
  try {
    blobAll = fs.readdirSync(BLOBS).filter((name) => !name.startsWith('.'));
  } catch {
    blobAll = [];
  }
  const orphans = blobAll.filter((sha) => !referenced.has(sha));
  let orphanBytes = 0;
  for (const sha of orphans) {
    try {
      orphanBytes += fs.statSync(path.join(BLOBS, sha)).size;
    } catch {
      /* 统计失败不影响判断 */
    }
  }

  const removedDirs = [];
  const removedBlobs = [];
  if (!dryRun) {
    for (const m of doomed) {
      try {
        fs.rmSync(m.dir, { recursive: true, force: true });
        removedDirs.push(m.dirName);
        appendLog({ op: 'prune', snapshot: m.dirName, tag: m.tag, result: 'removed' });
      } catch (err) {
        appendLog({ op: 'prune', snapshot: m.dirName, tag: m.tag, result: 'fail', note: err.message });
      }
    }
    for (const sha of orphans) {
      try {
        fs.unlinkSync(path.join(BLOBS, sha));
        removedBlobs.push(sha);
        appendLog({ op: 'prune', blob: short(sha), result: 'removed' });
      } catch (err) {
        appendLog({ op: 'prune', blob: short(sha), result: 'fail', note: err.message });
      }
    }
  }

  const summary = {
    ok: true,
    dryRun,
    keep,
    keepTags: [...keepTags],
    armTag,
    total: all.length,
    survivors: all
      .filter((m) => survivors.has(m.dirName))
      .map((m) => ({ tag: m.tag, snapshot: m.dirName, ts: m.ts })),
    doomed: doomed.map((m) => ({ tag: m.tag, snapshot: m.dirName, ts: m.ts })),
    blobs: { total: blobAll.length, orphans: orphans.map((sha) => short(sha)), orphanBytes },
    removed: { dirs: removedDirs, blobs: removedBlobs.length },
  };

  // silent：给测试与程序化调用用，不往 stdout 打报告。
  if (opts.silent === true) return summary;

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const head = dryRun ? '[DRY-RUN] ' : '';
  console.log(
    `${head}快照库：${summary.total} 份 → 保留 ${summary.survivors.length} 份，清理 ${summary.doomed.length} 份`,
  );
  if (armTag) console.log(`  当前看护引用：${armTag}（强制保留）`);
  for (const m of summary.survivors) console.log(`  保留  ${m.snapshot}  (${m.tag}, ${m.ts})`);
  for (const m of summary.doomed) console.log(`  ${dryRun ? '将删' : '已删'}  ${m.snapshot}  (${m.tag}, ${m.ts})`);
  console.log(
    `  blob：共 ${summary.blobs.total} 个，孤儿 ${summary.blobs.orphans.length} 个（${mib(summary.blobs.orphanBytes)}）` +
      (dryRun ? '，将回收' : `，已回收 ${removedBlobs.length} 个`),
  );
  if (dryRun) console.log('  未写入任何文件；确认无误后去掉 --dry-run 再跑一次。');
  return summary;
}

function filesSuffix(base) {
  for (let n = 2; ; n++) if (!fs.existsSync(`${base}-${n}`)) return String(n);
}

function usage() {
  console.log('ownshield 快照器（内容寻址）');
  console.log('  node snapshot.mjs create --tag <名字> [--paths <文件或目录>]... [--with-profile [--profile-dir D]] [--json]');
  console.log('  node snapshot.mjs list [--json]');
  console.log('  node snapshot.mjs restore <tag> [--to <目标>] [--with-profile [--profile-dir D]] [--dry-run] [--json]');
  console.log('  node snapshot.mjs verify <tag> [--json]');
  console.log('  node snapshot.mjs prune [--keep <N>] [--keep-tag <tag>]... [--dry-run] [--json]');
  console.log('');
  console.log('  prune 安全规则：arm.json 引用的 tag 与 --keep-tag（默认 baseline）永不删除；');
  console.log('                 其余按时间保留最近 --keep 份（默认 3）；最后只回收没有 manifest 引用的 blob。');
  console.log('                 快照库不会自动缩小，容量大了就手动跑一次 prune。');
  console.log('');
  console.log(`  默认对象: ${resolveInstallAsar() || '(未探测到——请设 OWNSHIELD_ASAR 或 OWNSHIELD_EXE，或用 --paths)'}`);
  console.log('  --with-profile 额外纳入 cordis.patch.yml（含备份链）、预设目录、插件链接表；默认关闭');
  console.log(`  profile 目录默认: ${DEFAULT_PROFILE_DIR}`);
  console.log(`  快照库:   ${SNAPSHOTS}`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
    const opts = parseArgs(rest);
    if (opts.help) { usage(); return; }
    if (cmd === 'create') return create(opts);
    if (cmd === 'list') return list(opts);
    if (cmd === 'verify') {
      const tag = opts._[0];
      if (!tag) throw new Error('verify 需要 <tag>');
      return verify(opts, tag);
    }
    if (cmd === 'restore') {
      const tag = opts._[0];
      if (!tag) throw new Error('restore 需要 <tag>');
      return restore(opts, tag);
    }
    if (cmd === 'prune') return prune(opts);
    throw new Error(`未知子命令: ${cmd}`);
  } catch (err) {
    console.error(`失败: ${err.message}`);
    process.exit(1);
  }
}

const SELF_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF_PATH)) {
  main();
}

export { create, list, restore, verify, prune, main };
