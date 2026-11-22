#!/usr/bin/env node
/**
 * ownshield watch —— DSH 本体自愈看门狗（局外进程）
 *
 * 形态：由 Windows 计划任务每 60 秒调用一次，做一次检查后立刻退出。
 * 它必须与 DSH 进程树无关（Harness 会把子进程放进 Windows Job Object，
 * DSH 一死子进程一起被带走），因此只能由 schtasks 拉起，不能是 DSH 的子进程。
 *
 * 用法：
 *   node watch.mjs                 一次性检查（计划任务用这一条）
 *   node watch.mjs --dry-run       完整判定，但不写任何文件、不还原、不重启
 *   node watch.mjs --json          机器可读输出（可与 --dry-run 组合）
 *   node watch.mjs --state-dir <目录>   覆盖 ~/.dsh/ownshield（验收/测试用）
 *   node watch.mjs --exe <路径>    覆盖 DSH 可执行文件路径
 *
 * 计划任务（本任务只写命令，不执行；安装留给 T6 验收）：
 *   必须经 watch-silent.vbs 启动：任务以 InteractiveToken 跑，直接调 node.exe
 *   会每分钟创建一个控制台窗口，桌面闪一下（2026-11-19 实测踩到）。
 *   schtasks /Create /TN ownshield-watch /SC MINUTE /MO 1 /F \
 *     /TR "C:\Windows\System32\wscript.exe //B //Nologo \"<stateDir>\watch-silent.vbs\""
 *   schtasks /Delete /TN ownshield-watch /F      # 停止看护/卸载时
 *
 * 输入（~/.dsh/ownshield/）：
 *   arm.json       看护状态 { tag, armedAt, graceSeconds, maxLevel, failures }
 *                  可选：baselineTag(默认 baseline)、maxRecoveryAttempts(默认 3)、
 *                        maxFailures(默认 3)、verifyTimeoutSeconds、
 *                        exePath、crashLogDir、confirmations
 *   boot.json      启动看护后那次启动的记录（本工具写；也接受外部预置）
 *   hb-*.json      心跳（由注入器/探针侧写；时间取 ts/at/time/createdAt，退回文件名或 mtime）
 *   probe-*.json   探针结果（T2）：{ ok, ts, checks:[{name,ok,error,detail}], durationMs }
 *   %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log   崩溃日志（只看文件名时间）
 *
 * 四类判定（参照预研 5.3.1 / 5.6）：
 *   1. process-gone   进程在宽限期内消失（硬失败：进程表查询成功后的缺席是确定的）
 *   2. new-crash-log  出现新 crash-*.log（硬失败）
 *   3. no-heartbeat   宽限期结束仍无心跳（软失败：需复现或与其他信号同时成立）
 *   4. probe-failure  探针报结构性失败（agent-preset/invalid|not-found、Duplicate tool group、
 *                     resume failed、session/not-found、预期工具缺失）（硬失败）
 *   网络/限流/超时等 C 类故障不算结构性失败，不回滚。
 *
 * 分级恢复（本任务实现 L1/L2；L3–L5 留接口）：
 *   L1 = snapshot.mjs restore <arm.tag> → 重启 DSH → 复检
 *   L2 = snapshot.mjs restore <arm.baselineTag> → 重启 DSH → 复检
 *   同一 arm 轮次内 L1 只用一次；每级重启后复检；最多 maxRecoveryAttempts 次（默认 3，
 *   顺序 L1 → L2 → L2）；全部失败写 needs-human.json 并停止看护。
 *   连续失败 maxFailures 次（默认 3）熔断。
 *
 * 状态/审计文件（~/.dsh/ownshield/）：
 *   watch-state.json  判定计数（strikes）、已用级别、恢复尝试（内部遥测，原子覆盖）
 *   boots/            旧 boot.json 归档（移动，不删除）
 *   disarm/           停止看护后的 arm.json 归档（移动，不删除）
 *   recovery.log      每次动作的审计行：时间 事件 级别 动作 结果
 *   recovered.json    恢复成功记录
 *   needs-human.json  熔断/无路可走时的交接文件
 *
 * 硬约束：
 *   - 不删除任何文件；停止看护 = 把 arm.json 移动到 disarm/，换 boot.json 前归档旧文件。
 *   - 所有动作幂等：restore 同内容跳过、重启前先确认 exe、重复检查不叠加副作用。
 *   - 本文件不直接写安装目录；asar 还原一律调用 snapshot.mjs（它自己备份后原子替换）。
 *   - --dry-run 保证零写入、零进程操作。
 *
 * 退出码：0 正常/未在看护/观察中；2 错误；3 交人（needs-human）；4 本轮恢复成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  attribute as debrideAttribute,
  quarantineEvents as debrideQuarantineEvents,
  quarantineLines as debrideQuarantineLines,
  readLedger as debrideReadLedger,
  nowTs as debrideNowTs,
  recordQuarantine as debrideRecordQuarantine,
  recordRecovered as debrideRecordRecovered,
  recordRolledBack as debrideRecordRolledBack,
  runProbeCommand as debrideRunProbeCommand,
} from './debride.mjs';
import { renderResume } from './resume-prompt.mjs';

const SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = fs.realpathSync(path.dirname(SELF));
const SNAPSHOT_CLI = path.join(SCRIPT_DIR, 'snapshot.mjs');
const WORKROOM_DIR = path.resolve(SCRIPT_DIR, '..', '..');
/** 旧版快照库位置（脚本目录上溯两级），只用于兼容存量；发布后不会误指向开发机。 */
const LEGACY_SNAPSHOTS_DIR = path.join(WORKROOM_DIR, 'snapshots');

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
 * 快照库解析顺序（与 snapshot.mjs 保持一致）：
 * 1. OWNSHIELD_SNAPSHOTS；2. 新默认 ~/.dsh/ownshield/snapshots 且含快照；
 * 3. 旧位置含快照则沿用并向 stderr 告警；4. 都没有 → 新默认（首次 create 会建）。
 */
export function resolveSnapshotsDir() {
  const override = String(process.env.OWNSHIELD_SNAPSHOTS || '').trim();
  if (override) return path.resolve(override);
  const preferred = path.join(os.homedir(), '.dsh', 'ownshield', 'snapshots');
  if (hasSnapshotDirs(preferred)) return preferred;
  if (hasSnapshotDirs(LEGACY_SNAPSHOTS_DIR)) {
    console.error(
      `[ownshield] 快照库仍位于旧路径 ${LEGACY_SNAPSHOTS_DIR}，建议迁移到 ${preferred}（或设 OWNSHIELD_SNAPSHOTS）`,
    );
    return LEGACY_SNAPSHOTS_DIR;
  }
  return preferred;
}

const SNAPSHOTS_DIR = resolveSnapshotsDir();

/** 列出快照库里所有 manifest 声明的 tag；目录名带时间戳前缀，tag 才是恢复用的名字。 */
export function listSnapshotTags(dir = SNAPSHOTS_DIR) {
  const tags = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return tags;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'blobs') continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, ent.name, 'manifest.json'), 'utf8'));
      if (raw && typeof raw.tag === 'string' && raw.tag) tags.push(raw.tag);
    } catch {
      /* 坏 manifest 跳过，不阻断其它快照 */
    }
  }
  return tags;
}

/** 流式算 sha256：asar 有 208 MB，避免整块读进内存。 */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 按 tag 找快照目录（目录名带时间戳前缀，tag 才是恢复用的名字）。 */
export function resolveSnapshotDir(tag, dir = SNAPSHOTS_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'blobs') continue;
    const manifestPath = path.join(dir, ent.name, 'manifest.json');
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (raw && raw.tag === tag) return path.join(dir, ent.name);
    } catch {
      /* 坏 manifest 跳过 */
    }
  }
  return '';
}

/**
 * 快照过期闸（2026-11-21 加）。
 *
 * 快照是「某一时刻的 app.asar」。DSH 升级之后，这份快照就是旧包——
 * 此时回滚不是修复，是把新版换成旧版。所以恢复前先确认两边是同一份，
 * 不一致就拒绝动手、转人工，宁可不动也不降级。
 */
export function checkSnapshotGuard(tag, { dir = SNAPSHOTS_DIR, asarPath = '' } = {}) {
  const targetAsar = String(asarPath || '').trim() || resolveInstallAsar();
  if (targetAsar === '') {
    return {
      ok: false,
      reason: 'asar-unresolved',
      detail:
        '找不到 DSH 安装位置（需要 app.asar）。请设置 OWNSHIELD_ASAR 或 OWNSHIELD_EXE，或确认 DSH 正在运行（用于探测安装目录）。',
    };
  }
  const snapDir = resolveSnapshotDir(tag, dir);
  if (!snapDir) {
    const known = listSnapshotTags(dir);
    return {
      ok: false,
      reason: 'snapshot-missing',
      detail: `快照 tag「${tag}」不存在（可用：${known.join(', ') || '无'}）`,
    };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'manifest-broken', detail: `manifest 无法解析：${err.message}` };
  }
  const entry = (manifest?.files || []).find((file) => /app\.asar$/i.test(String(file?.rel || file?.path || '')));
  if (!entry) return { ok: false, reason: 'manifest-no-asar', detail: 'manifest 里没有 app.asar 条目' };
  let actual = '';
  try {
    actual = sha256File(targetAsar);
  } catch (err) {
    return { ok: false, reason: 'asar-unreadable', detail: `读不到当前 app.asar：${err.message}` };
  }
  const short = (sha) => String(sha || '').slice(0, 12);
  if (actual !== entry.sha256) {
    return {
      ok: false,
      reason: 'asar-mismatch',
      detail: `快照 ${short(entry.sha256)} ≠ 当前 ${short(actual)}（DSH 可能已升级，用旧包回滚会降级）`,
      expected: entry.sha256,
      actual,
    };
  }
  return { ok: true, reason: 'match', detail: `asar ${short(actual)} 与快照一致`, sha256: actual };
}
export const WATCH_VERSION = '0.1.0';

export const DEFAULT_PROCESS_NAME = 'DeepSeek Harness';
/** 进程名可配：--process-name / OWNSHIELD_PROC_NAME / 默认（与 arm.mjs 规则一致）。 */
export function resolveProcessName(opts = {}) {
  const given = String((opts && opts.processName) || process.env.OWNSHIELD_PROC_NAME || '').trim();
  return given || DEFAULT_PROCESS_NAME;
}
export const PROCESS_NAME = resolveProcessName();

/** 常见安装位置里的 DSH 可执行文件（兜底候选，不写死某台机器的盘符）。 */
export function commonExeCandidates() {
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

/** 从运行中的 DSH 进程取可执行文件路径（没有显式配置时的最可靠来源）。只探一次。 */
let PROBED_EXE = null;
let PROBED_EXE_DONE = false;
function probeInstalledExe() {
  if (PROBED_EXE_DONE) return PROBED_EXE;
  PROBED_EXE_DONE = true;
  try {
    const procs = listProcesses(resolveProcessName());
    const found = procs.ok ? procs.list.find((proc) => proc.path && fs.existsSync(proc.path)) : null;
    PROBED_EXE = found ? found.path : null;
  } catch {
    PROBED_EXE = null;
  }
  return PROBED_EXE;
}

/**
 * 由 exe 推导安装根下的 app.asar；OWNSHIELD_ASAR 优先。
 * 没有显式 exe 时按 进程表 → 常见安装位置 顺序找；都找不到返回 ''（调用方必须明确报错）。
 */
export function resolveInstallAsarFromEnv(exe) {
  const override = String(process.env.OWNSHIELD_ASAR || '').trim();
  if (override) return path.resolve(override);
  const base = String(exe || process.env.OWNSHIELD_EXE || '').trim();
  return base === '' ? '' : path.join(path.dirname(base), 'resources', 'app.asar');
}

export function resolveInstallAsar(exe) {
  const fromEnv = resolveInstallAsarFromEnv(exe);
  if (fromEnv !== '') return fromEnv;
  const base =
    String(exe || process.env.OWNSHIELD_EXE || '').trim() ||
    probeInstalledExe() ||
    commonExeCandidates().find((candidate) => fs.existsSync(candidate)) ||
    '';
  if (base === '') return '';
  return path.join(path.dirname(base), 'resources', 'app.asar');
}
const SKEW_MS = 5000;

export const DEFAULTS = {
  graceSeconds: 120,
  maxLevel: 2,
  maxFailures: 3,
  maxRecoveryAttempts: 3,
  verifyTimeoutSeconds: 120,
  verifyPollMs: 5000,
  verifyQuietMs: 10000,
  killTimeoutSeconds: 20,
  singleInstanceWaitSeconds: 3,
  launchWaitSeconds: 8,
  attemptBudgetMs: 10 * 60 * 1000,
  lockStaleMs: 10 * 60 * 1000,
  /**
   * 软信号需要复现的次数。硬信号（process-gone / new-crash-log /
   * probe-failure）本身是确定事件，一次即成立。
   */
  softConfirmations: 2,
  /**
   * 心跳超过这个时长没刷新 = 进程还活着但事件循环可能卡死（挂死形态）。
   * 插件每 30 秒刷新一次，90 秒 = 连续漏 3 次，避开单次 GC/磁盘抖动。
   */
  heartbeatStaleMs: 90_000,
};

export const EXIT = { OK: 0, ERROR: 2, NEEDS_HUMAN: 3, RECOVERED: 4 };

const HARD_SIGNALS = new Set(['process-gone', 'new-crash-log', 'probe-failure', 'cookie-stale']);
const SIGNAL_LABEL = {
  'process-gone': '进程在宽限期内消失',
  'new-crash-log': '出现新 crash log',
  'no-heartbeat': '宽限期内无心跳',
  'probe-failure': '探针结构性失败',
  'cookie-stale': '本地 Web 登录 cookie 已过寿命（刷新页面会 401，只重启不回滚）',
  'heartbeat-stale': '进程存活但心跳停止（疑似挂死）',
  'renderer-crash': '渲染进程崩溃（可只重载窗口）',
  'graceful-exit': '显式声明的正常退出',
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString();

export function stampName(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** ISO / epoch(秒或毫秒) / Date 都接受；无法解析返回 null。 */
export function parseTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  // V8 只保证 3 位小数；PowerShell 的 ToString('o') 给 7 位。
  const normalized = text.replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function parseJsonText(text) {
  // PowerShell 5.1 的 `Set-Content -Encoding utf8` 会带 BOM；所有 JSON 读取都先剥掉。
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null, error: '' };
  try {
    return { exists: true, value: parseJsonText(fs.readFileSync(file, 'utf8')), error: '' };
  } catch (err) {
    return { exists: true, value: null, error: err.message };
  }
}

function writeJsonAtomic(file, value, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) {
    fs.copyFileSync(file, uniquePath(`${file}.bak-${stampName(Date.now())}`));
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function moveNoClobber(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const dest = uniquePath(to);
  fs.renameSync(from, dest);
  return dest;
}

function oneLine(value, limit = 500) {
  const text = String(value ?? '').replace(/\s+/g, '_');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 追加一行 recovery.log；dry-run 时永远不会走到这里。 */
function appendLog(paths, fields) {
  const line = `[${iso(Date.now())}] ${Object.entries(fields)
    .map(([k, v]) => `${k}=${oneLine(v)}`)
    .join(' ')}\n`;
  try {
    fs.mkdirSync(paths.ownshield, { recursive: true });
    fs.appendFileSync(paths.log, line, 'utf8');
  } catch (err) {
    console.error(`[ownshield-watch] recovery.log 写入失败: ${err.message}`);
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
    version: false,
    stateDir: '',
    exe: '',
    /** 覆盖 DSH 进程名（默认 $env:OWNSHIELD_PROC_NAME 或 DeepSeek Harness）。 */
    processName: '',
    /** A4：结构性检测的处置链默认真隔离；只有显式给这个开关才动 patch。 */
    allowQuarantine: false,
    /** A4：隔离后的复核命令（退出码 0 = 通过）；空则跳过复核。 */
    probeCmd: '',
    /** 只做快照一致性核对（启动看护前用），不进入判定流程。 */
    checkSnapshot: '',
    /** 未在看护时也守本地 Web cookie 过期（真到寿命就重启）；--no-cookie-guard 关闭。 */
    cookieGuard: true,
    /** 覆盖 DSH 家目录（演练用），默认 $DSH_HOME 或 ~/.dsh。 */
    dshHome: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-v') opts.version = true;
    else if (arg === '--state-dir') opts.stateDir = argv[++i] ?? '';
    else if (arg === '--exe') opts.exe = argv[++i] ?? '';
    else if (arg === '--process-name') opts.processName = argv[++i] ?? '';
    else if (arg === '--allow-quarantine') opts.allowQuarantine = true;
    else if (arg === '--probe-cmd') opts.probeCmd = argv[++i] ?? '';
    else if (arg === '--check-snapshot') opts.checkSnapshot = argv[++i] ?? '';
    else if (arg === '--no-cookie-guard') opts.cookieGuard = false;
    else if (arg === '--dsh-home') opts.dshHome = argv[++i] ?? '';
    else if (arg.startsWith('--check-snapshot=')) opts.checkSnapshot = arg.slice('--check-snapshot='.length);
    else if (arg.startsWith('--state-dir=')) opts.stateDir = arg.slice('--state-dir='.length);
    else if (arg.startsWith('--exe=')) opts.exe = arg.slice('--exe='.length);
    else if (arg.startsWith('--process-name=')) opts.processName = arg.slice('--process-name='.length);
    else throw new Error(`未知参数: ${arg}（--help 查看用法）`);
  }
  return opts;
}

function usage() {
  console.log(`ownshield watch ${WATCH_VERSION} —— 本体自愈看门狗（一次性检查）

用法:
  node watch.mjs [--dry-run] [--json] [--state-dir <目录>] [--exe <路径>] [--process-name <名字>]

  --dry-run        完整判定，但不写文件、不还原 asar、不重启 DSH
  --json           输出 JSON（与 --dry-run 组合可安全演练）
  --state-dir      覆盖 ~/.dsh/ownshield（默认 %USERPROFILE%\\.dsh\\ownshield）
  --exe            覆盖 DSH 可执行文件（默认从运行中的 DSH 进程 / 常见安装位置探测）
  --process-name   覆盖 DSH 进程名（默认 $env:OWNSHIELD_PROC_NAME 或 DeepSeek Harness）
  --allow-quarantine  结构性检测命中时真的隔离 patch 行（默认只干跑，不写盘）
  --probe-cmd <cmd>   隔离后的复核命令，退出码 0 = 通过；不给则记「未复核」
  --check-snapshot <tag>  只核对快照能否用于回滚（启动看护前用）；0=可用，3=拒绝
  --no-cookie-guard       关闭「未在看护时的 cookie 过期守卫」（默认开启）
  --dsh-home <目录>       覆盖 DSH 家目录（默认 $DSH_HOME 或 ~/.dsh，演练用）

未在看护（arm.json 不存在）时不做判定，只跑一次 cookie 过期守卫（读 host.log + profile 补丁，
过期则重启 DSH 并写 recovery.log；失败退避 10 分钟）。
计划任务由安装方创建，本脚本不注册/删除任何计划任务。`);
}

function resolvePaths(opts) {
  const home = os.homedir();
  const ownshield = path.resolve(
    opts.stateDir || process.env.OWNSHIELD_DIR || path.join(home, '.dsh', 'ownshield'),
  );
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  // 崩溃日志目录统一为：OWNSHIELD_LOG_DIR > OWNSHIELD_CRASH_DIR > %APPDATA%\@deepseek-ai\dsh-desktop\logs
  const logOverride = String(process.env.OWNSHIELD_LOG_DIR || '').trim();
  const crashOverride = String(process.env.OWNSHIELD_CRASH_DIR || '').trim();
  const crashDir = logOverride
    ? path.resolve(logOverride)
    : crashOverride
      ? path.resolve(crashOverride)
      : path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs');
  const logSource = logOverride ? 'OWNSHIELD_LOG_DIR' : crashOverride ? 'OWNSHIELD_CRASH_DIR' : 'default';
  return {
    home,
    ownshield,
    arm: path.join(ownshield, 'arm.json'),
    boot: path.join(ownshield, 'boot.json'),
    state: path.join(ownshield, 'watch-state.json'),
    lock: path.join(ownshield, 'watch.lock'),
    cookieGuard: path.join(ownshield, 'cookie-guard.json'),
    log: path.join(ownshield, 'recovery.log'),
    needsHuman: path.join(ownshield, 'needs-human.json'),
    recovered: path.join(ownshield, 'recovered.json'),
    bootsDir: path.join(ownshield, 'boots'),
    disarmDir: path.join(ownshield, 'disarm'),
    crashDir,
    logSource,
    snapshotCli: SNAPSHOT_CLI,
    // 这里只按「显式配置」推导，不做进程表探测（未在看护时每分钟跑一次，不能加开机成本）。
    installAsar: resolveInstallAsarFromEnv(opts.exe),
  };
}

// ---------------------------------------------------------------------------
// arm.json / 状态
// ---------------------------------------------------------------------------

function numberField(raw, key, fallback, min, max, problems) {
  const value = Number(raw?.[key]);
  if (!Number.isFinite(value)) return fallback;
  if (value < min || value > max) problems.push(`${key}=${value} 超出范围 ${min}..${max}，按 ${fallback} 处理`);
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeArm(raw, fallbackArmedAt = Date.now()) {
  const problems = [];
  const source = raw && typeof raw === 'object' ? raw : {};
  const tag = typeof source.tag === 'string' && source.tag.trim() !== '' ? source.tag.trim() : '';
  if (tag === '') problems.push('tag 为空');
  const armedAtMs = parseTime(source.armedAt) ?? parseTime(source.at) ?? fallbackArmedAt;
  const graceSeconds = numberField(source, 'graceSeconds', DEFAULTS.graceSeconds, 10, 3600, problems);
  const maxLevel = numberField(source, 'maxLevel', DEFAULTS.maxLevel, 1, 2, problems);
  const failures = numberField(source, 'failures', 0, 0, 1000, problems);
  return {
    tag: tag || 'unknown',
    armedAtMs,
    armedAt: iso(armedAtMs),
    graceSeconds,
    maxLevel,
    failures,
    baselineTag:
      typeof source.baselineTag === 'string' && source.baselineTag.trim() !== ''
        ? source.baselineTag.trim()
        : 'baseline',
    maxRecoveryAttempts: numberField(
      source,
      'maxRecoveryAttempts',
      DEFAULTS.maxRecoveryAttempts,
      1,
      5,
      problems,
    ),
    maxFailures: numberField(source, 'maxFailures', DEFAULTS.maxFailures, 1, 10, problems),
    verifyTimeoutSeconds: numberField(
      source,
      'verifyTimeoutSeconds',
      DEFAULTS.verifyTimeoutSeconds,
      10,
      600,
      problems,
    ),
    exePath: typeof source.exePath === 'string' ? source.exePath.trim() : '',
    crashLogDir: typeof source.crashLogDir === 'string' ? source.crashLogDir.trim() : '',
    heartbeatStaleMs: numberField(
      source,
      'heartbeatStaleMs',
      DEFAULTS.heartbeatStaleMs,
      30_000,
      1_800_000,
      problems,
    ),
    /**
     * 显式声明「本次看护期间会有人正常退出 DSH」。
     * 外部看门狗无法区分「用户按 X 关闭」与「进程被强杀」，所以不猜：
     * 默认一律按故障拉起；要正常退出就先把这个标志写进 arm.json。
     */
    expectGracefulExit: source.expectGracefulExit === true,
    /**
     * A3：F4 的自动判据。
     *   'exit-code'（默认）= 拿到退出码 0 才判正常退出；
     *   'no-crash-evidence' = 没有崩溃证据即判正常退出（显式降级，接受 F1 误判风险）；
     *   false = 关闭，回到「一律按故障拉起」。
     */
    autoGracefulExit:
      source.autoGracefulExit === 'no-crash-evidence'
        ? 'no-crash-evidence'
        : source.autoGracefulExit === false
          ? false
          : 'exit-code',
    /** A2：熔断后要把消息回注到哪个会话；空则退化为写 needs-human.md。 */
    notifySessionId: typeof source.notifySessionId === 'string' ? source.notifySessionId.trim() : '',
    /** A4：结构性检测的处置链开关（默认开；dry-run 由 --allow-quarantine 决定是否真隔离）。 */
    structuralDebride: source.structuralDebride !== false,
    confirmations:
      source.confirmations && typeof source.confirmations === 'object' ? source.confirmations : {},
    raw: source,
    problems,
  };
}

export function armIdOf(arm) {
  return crypto
    .createHash('sha1')
    .update(`${arm.tag}|${arm.armedAt}|${arm.graceSeconds}|${arm.maxLevel}`)
    .digest('hex')
    .slice(0, 12);
}

export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    armId: typeof source.armId === 'string' ? source.armId : '',
    strikes: source.strikes && typeof source.strikes === 'object' ? source.strikes : {},
    levelsUsed: source.levelsUsed && typeof source.levelsUsed === 'object' ? source.levelsUsed : {},
    recoveryAttempts: Number.isFinite(Number(source.recoveryAttempts))
      ? Math.max(0, Math.trunc(Number(source.recoveryAttempts)))
      : 0,
    failures: Number.isFinite(Number(source.failures)) ? Math.max(0, Math.trunc(Number(source.failures))) : 0,
    attempts: Array.isArray(source.attempts) ? source.attempts : [],
    lastCheckAt: typeof source.lastCheckAt === 'string' ? source.lastCheckAt : '',
    lastResult: typeof source.lastResult === 'string' ? source.lastResult : '',
    lastSignals: Array.isArray(source.lastSignals) ? source.lastSignals : [],
  };
}

function freshState(armId) {
  const state = normalizeState(null);
  state.armId = armId;
  return state;
}

// ---------------------------------------------------------------------------
// 输入采集：进程 / crash log / 心跳 / 探针
// ---------------------------------------------------------------------------

const PS_TMP_DIR = path.join(os.tmpdir(), 'ownshield-watch');

const PS_LIST_PROCS = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$name = $env:OWN_PROC_NAME
$list = @()
$procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
$ids = @($procs | ForEach-Object { $_.Id })
$parent = @{}
# 主进程判定：同名进程里父进程不在同名集合内的那个（Windows 主进程的父是 explorer）。
# 只看进程名不够：host 子进程、崩溃对话框与主进程同名，会把「主进程已死」误判成「还活着」。
try {
  foreach ($ci in (Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue)) {
    $parent[[int]$ci.ProcessId] = [int]$ci.ParentProcessId
  }
} catch {}
foreach ($p in $procs) {
  try {
    $ppid = 0
    if ($parent.ContainsKey([int]$p.Id)) { $ppid = $parent[[int]$p.Id] }
    $isBrowser = ($ppid -eq 0) -or (-not ($ids -contains $ppid))
    $list += [pscustomobject]@{
      pid = $p.Id
      start = $p.StartTime.ToUniversalTime().ToString('o')
      path = $p.Path
      browser = $isBrowser
    }
  } catch {}
}
ConvertTo-Json -InputObject $list -Compress
`;

const PS_RESTART = String.raw`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$exe = $env:OWN_EXE
$name = $env:OWN_PROC_NAME
$killTimeout = [int]$env:OWN_KILL_TIMEOUT
$lockWait = [int]$env:OWN_LOCK_WAIT
$launchWait = [int]$env:OWN_LAUNCH_WAIT
$result = [ordered]@{ ok = $false; killed = 0; browserPid = $null; launched = $false; running = 0; errors = @() }

function Procs { @(Get-Process -Name $name -ErrorAction SilentlyContinue) }

$before = Procs
$ids = @($before | ForEach-Object { $_.Id })
if ($ids.Count -gt 0) {
  $parent = @{}
  foreach ($id in $ids) {
    try { $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop; $parent[$id] = [int]$ci.ParentProcessId } catch {}
  }
  $browser = $null
  foreach ($id in $ids) {
    if ($parent.ContainsKey($id) -and ($ids -notcontains $parent[$id])) { $browser = $id; break }
  }
  if ($browser -eq $null) {
    $oldest = $before | Sort-Object StartTime | Select-Object -First 1
    if ($oldest) { $browser = $oldest.Id }
  }
  if ($browser -ne $null) {
    try { Stop-Process -Id $browser -Force -ErrorAction Stop; $result.browserPid = $browser }
    catch { $result.errors += "browser kill failed: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 900
  }
  foreach ($id in $ids) {
    if ($id -eq $browser) { continue }
    try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { $result.errors += "kill pid $id failed: $($_.Exception.Message)" }
  }
  $waited = 0
  while ((Procs).Count -gt 0 -and $waited -lt $killTimeout) { Start-Sleep -Milliseconds 500; $waited += 0.5 }
  $result.killed = $ids.Count
}

Start-Sleep -Seconds $lockWait
try {
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -LiteralPath $exe) -ErrorAction Stop
  $result.launched = $true
} catch {
  $result.errors += "launch failed: $($_.Exception.Message)"
}
Start-Sleep -Seconds $launchWait
$result.running = (Procs).Count
$result.ok = ($result.launched -and $result.running -gt 0)
ConvertTo-Json -InputObject $result -Compress
`;

/**
 * 用文件描述符捕获子进程输出（不走管道，DSH 沙箱同样可用）。
 */
function runCaptured(command, args, { timeoutMs = 30000, env = {}, tag = 'cmd' } = {}) {
  fs.mkdirSync(PS_TMP_DIR, { recursive: true });
  const base = path.join(PS_TMP_DIR, `${tag}-${process.pid}`);
  const outFile = `${base}.out`;
  const errFile = `${base}.err`;
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  let stdout = '';
  let stderr = '';
  try {
    stdout = fs.readFileSync(outFile, 'utf8');
    stderr = fs.readFileSync(errFile, 'utf8');
  } catch {
    /* 读不到就按空处理 */
  }
  return {
    ok: !result.error && result.status === 0,
    status: result.error ? -1 : result.status,
    stdout,
    stderr,
    error: result.error?.message || '',
  };
}

/**
 * 运行一段 PowerShell 并拿到输出。
 *
 * DSH 沙箱禁止 Node 开管道（child_process 的默认 stdio 会 EPERM），所以这里
 * 把 stdout/stderr 重定向到临时文件描述符。计划任务环境同样适用。
 */
function runPowerShell(script, { timeoutMs = 20000, env = {} } = {}) {
  const shells = [process.env.OWNSHIELD_PS, 'powershell.exe', 'pwsh'].filter(
    (value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
  );
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  let lastError = '';
  for (const shell of shells) {
    const result = runCaptured(shell, args, { timeoutMs, env, tag: 'ps' });
    if (result.error && result.status === -1) {
      lastError = result.error;
      if (/ENOENT/.test(result.error)) continue;
      return { ...result, ok: false };
    }
    return {
      ...result,
      ok: result.ok && result.stdout.trim() !== '',
      error: result.ok && result.stdout.trim() !== '' ? '' : `PowerShell exit=${result.status}: ${result.stderr.trim().slice(-500)}`,
    };
  }
  return { ok: false, status: -1, stdout: '', stderr: '', error: `找不到可用的 PowerShell: ${lastError}` };
}

function parseJsonChunk(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') return null;
  const start = trimmed.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

export function normalizeProcList(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list
    .map((item) => ({
      pid: Number(item?.pid) || 0,
      start: parseTime(item?.start),
      path: typeof item?.path === 'string' ? item.path : '',
      // 旧版列表没有 browser 字段；缺省视为 true，保持向后兼容。
      browser: item?.browser !== false,
    }))
    .filter((item) => item.pid > 0 && item.start !== null);
}

export function listProcesses(name = PROCESS_NAME) {
  const result = runPowerShell(PS_LIST_PROCS, { timeoutMs: 20000, env: { OWN_PROC_NAME: name } });
  if (!result.ok) return { ok: false, list: [], error: result.error || result.stderr };
  const parsed = parseJsonChunk(result.stdout);
  return { ok: true, list: normalizeProcList(parsed), error: '' };
}

export function parseCrashTime(name) {
  const match = /^crash-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(name));
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

function nameTime(name, prefix) {
  const match = new RegExp(
    `^${prefix}-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z`,
  ).exec(String(name));
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

export function scanCrashLogs(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, files: [], error: `目录不存在: ${dir}` };
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^crash-.*\.log$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      files.push({ name: entry.name, ts: parseCrashTime(entry.name) ?? mtimeMs, mtimeMs });
    }
  } catch (err) {
    return { ok: false, files: [], error: err.message };
  }
  files.sort((a, b) => b.ts - a.ts);
  return { ok: true, files, error: '' };
}

export function scanHeartbeats(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, files: [] };
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, files: [], error: err.message };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^hb-.*\.json$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let content = null;
    let mtimeMs = null;
    try {
      content = parseJsonText(fs.readFileSync(full, 'utf8'));
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const ts =
      parseTime(content?.ts) ??
      parseTime(content?.at) ??
      parseTime(content?.time) ??
      parseTime(content?.timestamp) ??
      parseTime(content?.createdAt) ??
      parseTime(content?.beatAt) ??
      nameTime(entry.name, 'hb') ??
      mtimeMs;
    files.push({ name: entry.name, ts, mtimeMs });
  }
  files.sort((a, b) => b.ts - a.ts);
  return { ok: true, files };
}

export function scanProbes(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, files: [] };
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, files: [], error: err.message };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^probe-.*\.json$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let content = null;
    let mtimeMs = null;
    try {
      content = parseJsonText(fs.readFileSync(full, 'utf8'));
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const ts = parseTime(content?.ts) ?? nameTime(entry.name, 'probe') ?? mtimeMs;
    files.push({
      name: entry.name,
      ts,
      mtimeMs,
      ok: content?.ok === true ? true : content?.ok === false ? false : null,
      checks: Array.isArray(content?.checks) ? content.checks : [],
      raw: content,
    });
  }
  files.sort((a, b) => b.ts - a.ts);
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// 本地 Web 登录 cookie 寿命
// ---------------------------------------------------------------------------

const HOST_LOG_PARTS = ['logs', 'ds-harness-remote', 'host.log'];
const HOST_LOG_IDLE_MS = 30 * 60 * 1000;
const HOST_LOG_TAIL_BYTES = 512 * 1024;

/** DSH 家目录：$DSH_HOME，否则 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh');
}

/** 从 profile 补丁里取 cookieMaxAgeDays；没显式配置就返回 undefined（不猜默认值）。 */
export function readCookieMaxAgeDays(home = resolveDshHome()) {
  let names = [];
  try {
    names = fs
      .readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(home, 'profiles', name, 'cordis.patch.yml'), 'utf8');
    } catch {
      continue;
    }
    const match = /cookieMaxAgeDays:\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

/**
 * 本地 Web 登录 cookie 是否已过寿命。
 *
 * 判据与 `dsh-ownshield/lib/auth-gate.js` 的 `checkWebCookieAge` 一致——插件包不能反向
 * 依赖工作区脚本，所以各留一份；`web-cookie-parity` 测试用同一组 fixture 断言两边结论相同。
 *
 * cookie 实际在页面首次打开时签发，用进程年龄是**近似**；因此本项只用于「该重启了」的
 * 提示，不参与 `probe-failure` 那类硬判定。
 */
export function evaluateWebCookie({ home = resolveDshHome(), now = Date.now() } = {}) {
  const hostLog = path.join(home, ...HOST_LOG_PARTS);
  if (!fs.existsSync(hostLog)) {
    return { state: 'no-log', detail: '没有 host.log，跳过本地 Web cookie 寿命推断' };
  }
  let text = '';
  try {
    // 每分钟跑一次，只读尾部；host.log 会长到几 MB，全读没必要。
    const buf = fs.readFileSync(hostLog);
    text = buf.subarray(Math.max(0, buf.length - HOST_LOG_TAIL_BYTES)).toString('utf8');
  } catch {
    return { state: 'unreadable', detail: 'host.log 读取失败，跳过本地 Web cookie 寿命推断' };
  }
  let lastStart;
  let lastTime;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = parseTime(line.slice(0, 24));
    if (at !== null) lastTime = at;
    if (line.includes('host identity ready')) {
      const started = parseTime(line.slice(0, 24));
      if (started !== null) lastStart = started;
    }
  }
  if (lastTime === undefined || now - lastTime > HOST_LOG_IDLE_MS) {
    return { state: 'idle', detail: 'host.log 不活跃，跳过本地 Web cookie 寿命推断' };
  }
  if (lastStart === undefined) {
    return { state: 'unknown', detail: 'host.log 里没有 host identity ready，无法确定进程启动时间' };
  }
  const limitDays = readCookieMaxAgeDays(home);
  if (limitDays === undefined) {
    return { state: 'unconfigured', detail: 'profile 未显式配置 cookieMaxAgeDays，跳过过期推断' };
  }
  const ageHours = (now - lastStart) / 3_600_000;
  const limitHours = limitDays * 24;
  if (ageHours <= limitHours) {
    return {
      state: 'ok',
      ageHours,
      limitHours,
      detail: `进程已运行 ${ageHours.toFixed(1)}h，cookie 寿命 ${limitHours}h，未过期`,
    };
  }
  return {
    state: 'stale',
    ageHours,
    limitHours,
    detail: `进程已连续运行 ${ageHours.toFixed(1)}h，超过 dsh-auth cookie 寿命 ${limitHours}h（按进程年龄近似）；刷新页面会 401，处置是重启（不回滚 asar）`,
  };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 探针是否结构性失败（A/B 类）。网络/限流/超时不算，不回滚。 */
export function classifyProbe(probe) {
  if (!probe || probe.ok !== false) return { structural: false, reason: '' };
  const checks = Array.isArray(probe.checks) ? probe.checks : [];
  const failed = checks.filter((check) => check && check.ok === false);
  const joined = failed
    .map((check) => `${check.name ?? ''} ${check.error ?? ''} ${check.detail ?? ''}`)
    .join('\n');
  if (/agent-preset\/(invalid|not-found)/i.test(joined)) return { structural: true, reason: 'agent-preset' };
  if (/duplicate tool group/i.test(joined)) return { structural: true, reason: 'duplicate-tool-group' };
  if (/resume failed|resume\s+失败/i.test(joined)) return { structural: true, reason: 'resume-failed' };
  if (/session\/not-found/i.test(joined)) return { structural: true, reason: 'session-not-found' };
  const inventory = failed.find((check) => check.name === 'tool-inventory');
  if (inventory) return { structural: true, reason: 'tool-inventory-missing' };
  return { structural: false, reason: '' };
}

/**
 * 「主动重启」标记的有效期（10 分钟）。与 `lib/arm-bridge.js` 的 `GRACEFUL_MARK_TTL_MS`
 * 保持一致——本脚本要能脱离包结构独立跑（开发目录也直接用它），所以各留一份。
 *
 * 2026-11-22 真机教训：`restart_now` 打标记后，如果看门狗那一轮跑的时候新进程已经起来，
 * `resolveBoot` 会重建 boot、判 `signals=none`，既不走 graceful-exit 也不停止看护，
 * 标记就永久留在 arm.json 里；之后**真崩溃**会被当成正常退出而不救。标记必须自己会过期。
 */
const GRACEFUL_MARK_TTL_MS = 10 * 60 * 1000;

/** 标记此刻还算不算数。没写时间戳的一律不认——宁可多救，不可漏救。 */
function gracefulMarkValid(arm, now) {
  if (!arm || arm.expectGracefulExit !== true) return false;
  const raw = arm.expectGracefulExitAt;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const at = parseTime(raw);
  if (at === null) return false;
  return now - at <= GRACEFUL_MARK_TTL_MS;
}

export function sameBoot(proc, boot) {
  if (!proc || !boot) return false;
  const start = proc.start;
  if (start === null || start === undefined) return false;
  if (boot.pid && proc.pid === boot.pid) return Math.abs(start - boot.startedAt) < SKEW_MS;
  return Math.abs(start - boot.startedAt) < SKEW_MS - 2000;
}

/**
 * 四类判定。返回 signals（空数组 = 本轮无异常）。
 * 只在 authed boot 存在且进程表查询成功时判定，避免误判。
 */
export function evaluateSignals({
  arm,
  boot,
  now,
  procs,
  procsOk,
  crash,
  heartbeats,
  probes,
  /**
   * A3：进程消失时才调用的证据采集（查事件日志 + 读退出码）。
   * 传函数而不是值：进程活着时一次 PowerShell 都不该跑。
   */
  exitEvidence,
}) {
  const signals = [];
  if (!boot || !procsOk) return signals;
  const graceUntil = boot.graceUntil ?? boot.startedAt + arm.graceSeconds * 1000;

  const live = (procs || []).filter((proc) => proc.browser !== false && sameBoot(proc, boot));
  // boot 只在「进程表里真的见过它」时才会建立，所以 live 为空即确定消失。
  // 宽限期曾把这条判定限制在启动后 120 秒内，导致看护超过两分钟后崩溃完全无信号。
  if (live.length === 0) {
    if (gracefulMarkValid(arm, now)) {
      signals.push({
        type: 'graceful-exit',
        hard: false,
        detail: `进程已退出（pid ${boot.pid || '?'}），arm.expectGracefulExit=true，按正常退出处理，不拉起`,
      });
    } else {
      let evidence = null;
      if (typeof exitEvidence === 'function') {
        try {
          evidence = exitEvidence();
        } catch (err) {
          evidence = { crashEvents: { ok: false, crashed: null, events: [], error: err.message } };
        }
      }
      const verdict = classifyExit({ arm, boot, now, crash, evidence });
      if (verdict.graceful) {
        signals.push({
          type: 'graceful-exit',
          hard: false,
          detail: `进程已退出（pid ${boot.pid || '?'}），无崩溃证据（${verdict.reason}，模式 ${verdict.mode}），按正常退出处理，不拉起`,
          verdict,
        });
      } else {
        signals.push({
          type: 'process-gone',
          hard: true,
          detail: `boot 记录的进程 pid ${boot.pid || '?'} 已消失（boot 于 ${iso(boot.startedAt)}，宽限至 ${iso(graceUntil)}）；未判正常退出：${verdict.reason}`,
          verdict,
        });
      }
    }
  }

  const crashFiles = crash?.ok ? crash.files || [] : null;
  if (crashFiles) {
    const baseline = boot.crashBaseline ? boot.crashBaseline.newestTime : boot.detectedAt;
    const fresh = crashFiles.filter(
      (file) => file.ts > (baseline ?? 0) && file.ts >= boot.startedAt - 60_000,
    );
    if (fresh.length > 0) {
      // 分级：渲染进程崩溃只影响窗口，主进程与 Host 仍活，会话数据全在磁盘。
      // 这类故障的正确处置是「重载窗口」（秒级），不是整机重启（会中断会话）。
      // 但 Host 侧没有 main 进程的 webContents 句柄，做不了 reload，
      // 所以退一步：只报软信号、不立刻重启；连续两次才升级为整机重启兜底。
      const hardCrash = fresh.find((file) => !/-renderer\.log$/i.test(file.name));
      if (hardCrash) {
        signals.push({
          type: 'new-crash-log',
          hard: true,
          detail: `新 crash log: ${hardCrash.name}（基线 ${boot.crashBaseline?.newestName || '无'}）`,
          files: fresh.slice(0, 5).map((file) => file.name),
        });
      } else {
        signals.push({
          type: 'renderer-crash',
          hard: false,
          detail: `渲染进程崩溃 ${fresh[0].name}：主进程与 Host 仍活，可只重载窗口；连续两次才整机重启`,
          files: fresh.slice(0, 5).map((file) => file.name),
        });
      }
    }
  }

  const hbFiles = heartbeats?.ok ? heartbeats.files || [] : null;
  const staleMs = arm.heartbeatStaleMs ?? DEFAULTS.heartbeatStaleMs;
  if (hbFiles && hbFiles.length > 0 && live.length > 0) {
    // 心跳在、进程也在，但心跳不刷新 = 事件循环卡死（挂死形态）。
    // 进程消失由 process-gone 负责，这里只判「活着但不响应」。
    const newest = hbFiles[0];
    if (newest.ts >= boot.startedAt - SKEW_MS && now - newest.ts > staleMs) {
      signals.push({
        type: 'heartbeat-stale',
        hard: false,
        detail: `进程仍在，但最新心跳 ${iso(newest.ts)} 距今 ${Math.round((now - newest.ts) / 1000)}s > ${Math.round(staleMs / 1000)}s，疑似挂死`,
      });
    }
  }
  if (hbFiles && now > graceUntil) {
    const fresh = hbFiles.filter((file) => file.ts >= boot.startedAt - SKEW_MS);
    if (fresh.length === 0) {
      signals.push({
        type: 'no-heartbeat',
        hard: false,
        detail: `宽限至 ${iso(graceUntil)} 仍无心跳（boot=${iso(boot.startedAt)}，库内 ${hbFiles.length} 个 hb 文件）`,
      });
    }
  }

  const probeFiles = probes?.ok ? probes.files || [] : null;
  if (probeFiles) {
    const since = Math.max(boot.startedAt - SKEW_MS, arm.armedAtMs ?? 0);
    const fresh = probeFiles.filter((file) => file.ts >= since && file.ok === false);
    const bad = fresh.find((file) => classifyProbe(file).structural);
    if (bad) {
      signals.push({
        type: 'probe-failure',
        hard: true,
        detail: `探针结构性失败 ${bad.name}: ${classifyProbe(bad).reason}`,
        probe: bad.name,
      });
    }
    // cookie 过期是「该重启」而不是「该回滚」：ok 仍为 true，只靠结构化标记识别。
    const staleProbe = probeFiles.find(
      (file) =>
        file.ts >= since &&
        (Array.isArray(file.checks) ? file.checks : []).some((check) => check && check.cookieStale === true),
    );
    if (staleProbe) {
      const check = staleProbe.checks.find((item) => item && item.cookieStale === true);
      signals.push({
        type: 'cookie-stale',
        hard: true,
        detail: check?.warn || check?.detail || '本地 Web 登录 cookie 已过寿命',
        probe: staleProbe.name,
      });
    }
  }

  return signals;
}

/** 更新软信号计数：本轮出现的 +1，消失的清零。 */
export function updateStrikes(previous, signals, now) {
  const next = { ...(previous && typeof previous === 'object' ? previous : {}) };
  const types = new Set(signals.map((signal) => signal.type));
  for (const key of Object.keys(next)) if (!types.has(key)) delete next[key];
  for (const signal of signals) {
    if (HARD_SIGNALS.has(signal.type)) continue;
    const before = next[signal.type];
    next[signal.type] = {
      count: (before?.count ?? 0) + 1,
      firstSeenAt: before?.firstSeenAt ?? iso(now),
      lastSeenAt: iso(now),
    };
  }
  return next;
}

/**
 * 触发规则（预研 5.3 / 5.6）：
 *   - 硬信号（进程在宽限期内消失 / 新 crash log / 探针结构性失败）一次即成立；
 *   - 软信号（无心跳）需要复现 softConfirmations 次，或两个软信号同时成立。
 */
export function decideRecovery({ signals, strikes, confirmations = {} }) {
  if (!signals || signals.length === 0) return { action: 'none', reason: 'no-signal' };
  const hard = signals.find((signal) => signal.hard || HARD_SIGNALS.has(signal.type));
  if (hard) return { action: 'recover', reason: `硬失败信号: ${hard.type}` };

  const soft = signals.filter((signal) => !signal.hard);
  const distinct = new Set(soft.map((signal) => signal.type));
  if (distinct.size >= 2) {
    return { action: 'recover', reason: `两个软信号同时成立: ${[...distinct].join(',')}` };
  }
  const repeated = soft.find((signal) => {
    const need = Number(confirmations[signal.type]) > 0 ? Number(confirmations[signal.type]) : DEFAULTS.softConfirmations;
    return (strikes?.[signal.type]?.count ?? 0) >= need;
  });
  if (repeated) return { action: 'recover', reason: `软信号复现: ${repeated.type}` };
  const pending = soft[0];
  return {
    action: 'observe',
    reason: `首见软信号 ${pending?.type ?? ''}，等待复现`,
    pending: { type: pending?.type ?? '', count: strikes?.[pending?.type]?.count ?? 0 },
  };
}

/** 下一级恢复动作；null = 无路可走（交人）。 */
export function nextLevel(arm, state) {
  const attempts = state?.recoveryAttempts ?? 0;
  if (attempts >= arm.maxRecoveryAttempts) return null;
  const used = state?.levelsUsed ?? {};
  // L1 清创/回滚 → L2 回 baseline → L3 只还原 profile 层（asar 已回滚过，根因在 profile 时才管用）。
  if (arm.maxLevel >= 1 && !used.L1) return 'L1';
  if (arm.maxLevel >= 3 && !used.L3 && (used.L2 ?? 0) >= 1) return 'L3';
  if (arm.maxLevel >= 2) return 'L2';
  return null;
}

/** 某一级用哪份快照：L1 = 看护时那版，L2 = baseline，L3 = profile 层（缺省沿用 L1 那版）。 */
export function levelTag(arm, level) {
  if (level === 'L1') return arm.tag;
  if (level === 'L3') return arm.profileTag || arm.tag;
  return arm.baselineTag;
}

// ---------------------------------------------------------------------------
// boot.json
// ---------------------------------------------------------------------------

export function normalizeBoot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt =
    parseTime(raw.startedAt) ?? parseTime(raw.startTime) ?? parseTime(raw.bootAt) ?? null;
  if (startedAt === null) return null;
  const crashBaseline =
    raw.crashBaseline && typeof raw.crashBaseline === 'object'
      ? {
          newestTime: Number(raw.crashBaseline.newestTime) || 0,
          newestName: typeof raw.crashBaseline.newestName === 'string' ? raw.crashBaseline.newestName : '',
          count: Number(raw.crashBaseline.count) || 0,
        }
      : null;
  return {
    armId: typeof raw.armId === 'string' ? raw.armId : '',
    pid: Number(raw.pid) || 0,
    path: typeof raw.path === 'string' ? raw.path : '',
    startedAt,
    detectedAt: parseTime(raw.detectedAt) ?? startedAt,
    graceUntil: parseTime(raw.graceUntil) ?? startedAt + DEFAULTS.graceSeconds * 1000,
    crashBaseline,
  };
}

function buildBoot({ arm, armId, proc, now, crash }) {
  // 基线必须取「启动看护时刻之前」的最新 crash：若取「第一次检查时」的最新文件，
  // 启动看护后立刻发生的故障（2026-11-20 F2：kill renderer 9 秒后第一个 check）
  // 会被当成基线吞掉，之后再也不会报。
  const cutoff = arm.armedAtMs ?? now;
  const beforeArm = crash?.ok ? (crash.files.filter((file) => file.ts <= cutoff)[0] ?? null) : null;
  return {
    armId,
    pid: proc.pid,
    path: proc.path || '',
    startedAt: proc.start,
    detectedAt: now,
    graceUntil: proc.start + arm.graceSeconds * 1000,
    crashBaseline: {
      newestTime: beforeArm?.ts ?? 0,
      newestName: beforeArm?.name ?? '',
      count: crash?.ok ? crash.files.length : 0,
    },
  };
}

function archiveBoot(paths, existing) {
  if (!existing || !fs.existsSync(paths.boot)) return null;
  try {
    return moveNoClobber(paths.boot, path.join(paths.bootsDir, `boot-${stampName(existing.startedAt)}.json`));
  } catch (err) {
    return { error: err.message };
  }
}

function persistBoot(paths, boot, existing, { backup = true } = {}) {
  archiveBoot(paths, existing);
  writeJsonAtomic(paths.boot, boot, { backup });
}

/**
 * 选定「本次看护轮次下的那次启动」。
 * 启动看护前就存在的进程不算：必须 startedAt >= armedAt - 5s，否则视为尚未重启。
 */
function resolveBoot({ paths, arm, armId, procs, crash, now, dryRun }) {
  const existingRaw = readJsonSafe(paths.boot);
  const existing = normalizeBoot(existingRaw.value);
  const armedAt = arm.armedAtMs;
  const candidates = procs.ok
    ? procs.list.filter((proc) => proc.browser !== false && proc.start >= armedAt - SKEW_MS)
    : [];

  const current =
    existing && (!existing.armId || existing.armId === armId) && existing.startedAt >= armedAt - SKEW_MS
      ? existing
      : null;

  if (current) {
    const match = candidates.find((proc) => sameBoot(proc, current));
    if (match) {
      return { boot: { ...current, pid: match.pid, path: match.path || current.path }, changed: false };
    }
    const newer = candidates
      .filter((proc) => proc.start > current.startedAt + SKEW_MS)
      .sort((a, b) => a.start - b.start);
    if (newer.length > 0) {
      const boot = buildBoot({ arm, armId, proc: newer[0], now, crash });
      if (!dryRun) persistBoot(paths, boot, current);
      return { boot, changed: true, archived: current };
    }
    return { boot: current, changed: false };
  }

  if (candidates.length > 0) {
    // 主进程优先：崩溃对话框与 renderer 子进程同名，取错会把 boot 锚在短命的子进程上。
    const earliest = [...candidates].sort(
      (a, b) => Number(b.browser === true) - Number(a.browser === true) || a.start - b.start,
    )[0];
    const boot = buildBoot({ arm, armId, proc: earliest, now, crash });
    if (!dryRun) persistBoot(paths, boot, existing);
    return { boot, changed: true, archived: existing };
  }

  return { boot: null, changed: false, waiting: true };
}

// ---------------------------------------------------------------------------
// 恢复动作
// ---------------------------------------------------------------------------

function restoreSnapshot(tag, { profileOnly = false } = {}) {
  if (!fs.existsSync(SNAPSHOT_CLI)) {
    return { ok: false, error: `快照器不存在: ${SNAPSHOT_CLI}` };
  }
  // 先校验 tag：arm.tag 常被误填成快照目录名（20261117T232621-baseline），
  // 真到要恢复时才发现，等于救不了场。这里把可用 tag 直接摆出来。
  const known = listSnapshotTags();
  if (!known.includes(tag)) {
    return {
      ok: false,
      error: `快照 tag 不存在: ${tag}（可用: ${known.join(', ') || '无'}）。arm.tag 要填 manifest 里的 tag，不是快照目录名`,
    };
  }
  const args = [SNAPSHOT_CLI, 'restore', tag, '--json'];
  if (profileOnly) args.push('--profile-only');
  const result = runCaptured(process.execPath, args, {
    timeoutMs: 300_000,
    tag: 'restore',
  });
  if (!result.ok) {
    const tail = `${result.stderr}\n${result.stdout}`
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-4)
      .join(' | ');
    return {
      ok: false,
      exitCode: result.status,
      error: result.error || tail || 'snapshot restore 失败',
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    /* 人类可读输出，JSON 解析失败不算错误 */
  }
  return { ok: true, result: parsed, stdout: result.stdout.trim() };
}

/**
 * DSH 可执行文件解析：--exe → arm.exePath → OWNSHIELD_EXE → 进程表 → 常见安装位置。
 *
 * 显式配置的路径原样返回（哪怕不存在）：这类错误必须明确报出来，不能悄悄换成
 * 另一台机器上的默认路径——那会让恢复在错误的安装上动手。
 */
function resolveExe(opts, arm, procs) {
  const explicit = [opts?.exe, arm?.exePath, process.env.OWNSHIELD_EXE].filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (explicit.length > 0) return explicit[0].trim();
  const probed = (procs?.list ?? []).find((proc) => proc.path && fs.existsSync(proc.path))?.path;
  if (probed) return probed;
  const common = commonExeCandidates().find((candidate) => fs.existsSync(candidate));
  return common || '';
}

function restartDsh(exe, procName = PROCESS_NAME) {
  if (!exe || !fs.existsSync(exe)) {
    return {
      ok: false,
      error: exe
        ? `可执行文件不存在: ${exe}`
        : '未能探测到 DSH 可执行文件：请设置 OWNSHIELD_EXE 或 arm.json 的 exePath，或确认 DSH 正在运行',
    };
  }
  const launchStart = Date.now();
  const result = runPowerShell(PS_RESTART, {
    timeoutMs: 120_000,
    env: {
      OWN_EXE: exe,
      OWN_PROC_NAME: procName,
      OWN_KILL_TIMEOUT: String(DEFAULTS.killTimeoutSeconds),
      OWN_LOCK_WAIT: String(DEFAULTS.singleInstanceWaitSeconds),
      OWN_LAUNCH_WAIT: String(DEFAULTS.launchWaitSeconds),
    },
  });
  const parsed = parseJsonChunk(result.stdout) ?? {};
  const after = listProcesses(procName);
  const fresh = after.ok ? after.list.filter((proc) => proc.start >= launchStart - SKEW_MS) : [];
  const startedAt = fresh.length > 0 ? Math.min(...fresh.map((proc) => proc.start)) : null;
  return {
    ok: Boolean(parsed.ok) && after.ok && fresh.length > 0,
    launched: Boolean(parsed.launched),
    running: Number(parsed.running) || 0,
    killed: Number(parsed.killed) || 0,
    startedAt,
    pid: fresh[0]?.pid ?? 0,
    exe,
    error: result.ok ? '' : result.error || '重启脚本失败',
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
  };
}

function verifyAfterRestart({ paths, arm, bootStart, crashBaseline, hbSeenBefore, expectStartedAt, procName = PROCESS_NAME }) {
  const deadline = Date.now() + arm.verifyTimeoutSeconds * 1000;
  const checks = [];
  for (;;) {
    const now = Date.now();
    const procs = listProcesses(procName);
    if (procs.ok) {
      const live = procs.list.filter((proc) => proc.start >= bootStart - SKEW_MS);
      checks.push({ at: iso(now), live: live.length });
      if (live.length === 0) {
        return { ok: false, reason: 'process-gone', detail: '重启后进程未存活', checks };
      }
      const crash = scanCrashLogs(paths.crashDir);
      if (crash.ok) {
        const fresh = crash.files.find((file) => file.ts > crashBaseline);
        if (fresh) return { ok: false, reason: 'new-crash-log', detail: fresh.name, checks };
      }
      const probes = scanProbes(paths.ownshield);
      if (probes.ok) {
        const since = Math.max(bootStart - SKEW_MS, expectStartedAt ?? 0);
        const bad = probes.files.find(
          (file) => file.ts >= since && file.ok === false && classifyProbe(file).structural,
        );
        if (bad) return { ok: false, reason: 'probe-failure', detail: bad.name, checks };
      }
      if (hbSeenBefore) {
        const heartbeats = scanHeartbeats(paths.ownshield);
        const fresh = heartbeats.ok
          ? heartbeats.files.find((file) => file.ts >= bootStart - SKEW_MS)
          : null;
        if (!fresh && now - bootStart > arm.graceSeconds * 1000) {
          return { ok: false, reason: 'no-heartbeat', detail: '重启后宽限期内无心跳', checks };
        }
        if (!fresh) {
          sleepSync(Math.min(DEFAULTS.verifyPollMs, Math.max(0, deadline - now)));
          continue;
        }
      }
      if (now - bootStart >= DEFAULTS.verifyQuietMs) {
        return {
          ok: true,
          reason: hbSeenBefore ? 'process+crash+heartbeat' : 'process+crash',
          checks,
        };
      }
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'verify-timeout', detail: '复检超时', checks };
    }
    sleepSync(Math.min(DEFAULTS.verifyPollMs, Math.max(0, deadline - Date.now())));
  }
}

function updateArmFailures(paths, failures) {
  try {
    const current = readJsonSafe(paths.arm);
    if (!current.exists || !current.value || typeof current.value !== 'object') return false;
    writeJsonAtomic(paths.arm, { ...current.value, failures }, { backup: true });
    return true;
  } catch (err) {
    appendLog(paths, { event: 'arm', action: 'update-failures', result: 'fail', detail: err.message });
    return false;
  }
}

/**
 * 清掉「主动重启」标记：新 boot 已建立（预期兑现）时调用。
 * 只删这两个字段，arm.json 其余内容原样保留——看护状态继续有效。
 */
function clearGracefulMark(paths) {
  const read = readJsonSafe(paths.arm);
  const value = read.exists && read.value && typeof read.value === 'object' ? read.value : null;
  if (!value || value.expectGracefulExit !== true) return false;
  const next = { ...value };
  delete next.expectGracefulExit;
  delete next.expectGracefulExitAt;
  try {
    writeJsonAtomic(paths.arm, next);
    return true;
  } catch {
    return false;
  }
}

function disarm(paths, reason) {
  try {
    if (!fs.existsSync(paths.arm)) return '';
    return moveNoClobber(
      paths.arm,
      path.join(paths.disarmDir, `arm-${stampName(Date.now())}-${reason}.json`),
    );
  } catch (err) {
    return `error: ${err.message}`;
  }
}

function writeRecovered(paths, arm, attempt, attempts) {
  const payload = {
    at: iso(Date.now()),
    level: attempt.level,
    tag: attempt.tag,
    arm: { tag: arm.tag, armedAt: arm.armedAt },
    verify: attempt.verify,
    attempts,
  };
  writeJsonAtomic(paths.recovered, payload, { backup: true });
  return payload;
}

export function writeNeedsHuman(paths, arm, signals, attempts, failures) {
  const payload = {
    at: iso(Date.now()),
    reason: `连续恢复失败 ${failures} 次，已停止看护停手`,
    hint: '人工检查 recovery.log 与已备份的 asar；确认后在主人到场时执行 snapshot restore 或重新 arm。',
    arm: { tag: arm.tag, armedAt: arm.armedAt, failures },
    signals: signals.map((signal) => ({ type: signal.type, detail: signal.detail })),
    attempts,
  };
  // A2：熔断后必须有人知道。通知失败绝不改变判定与退出码。
  // 先算通知再落盘，needs-human.json 里才带得上「走了哪条通道」。
  try {
    payload.notify = notifyNeedsHuman({ paths, arm, payload });
    appendLog(paths, {
      event: 'notify',
      arm: arm.tag,
      channel: payload.notify.channel,
      file: payload.notify.file,
      result: payload.notify.ok ? 'ok' : 'degraded',
    });
  } catch (err) {
    payload.notify = { ok: false, channel: 'none', error: err.message };
    appendLog(paths, { event: 'notify', arm: arm.tag, channel: 'none', result: 'fail', detail: err.message });
  }
  writeJsonAtomic(paths.needsHuman, payload, { backup: true });
  return payload;
}


// ---------------------------------------------------------------------------
// A2：熔断通知 —— 停手不能只在磁盘上留一份 JSON
// ---------------------------------------------------------------------------

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 最后一次尝试的一句话摘要：verify 的 reason/detail 优先，其次 restart/restore 的 error。 */
export function lastAttemptSummary(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const last = list[list.length - 1];
  if (!last) return '';
  const verify = last.verify || {};
  const parts = [verify.reason, verify.detail].filter(Boolean);
  if (parts.length === 0) parts.push(last.restart?.error, last.restore?.error);
  const detail = parts.filter(Boolean).join(' / ');
  return `${last.level ?? '?'} @${last.at ?? '?'} ${detail || '未记录 detail'}`;
}

/** 人话摘要：失败次数、最后错误、已停止看护。没通知通道时这就是唯一线索。 */
export function needsHumanMarkdown(payload) {
  const failures = payload?.arm?.failures ?? '?';
  const last = lastAttemptSummary(payload?.attempts);
  const lines = [
    '# ownshield 停手了，需要人工处理',
    '',
    `- 时间：${payload?.at ?? '(未知)'}`,
    `- 原因：${payload?.reason ?? '(未知)'}`,
    `- 失败次数：${failures}`,
    `- 最后一次失败：${last || '(没有留下尝试记录)'}`,
    '- 已停止看护：是。arm.json 已移到 disarm/，看门狗不会再自动重试。',
    '',
    '## 接下来怎么做',
    '',
    '1. 看 `recovery.log` 与 `disarm/` 里最新那份 arm*.json，确认这一轮做了什么。',
    '2. 手工跑一次快照恢复：`node tools/ownshield/snapshot.mjs restore <tag> --dry-run` 先干跑。',
    '3. 确认无误后再重新启动看护（写回 arm.json），启动看护时间必须早于本次 DSH 主进程启动。',
  ];
  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  if (signals.length) {
    lines.push('', '## 触发信号', '');
    for (const signal of signals) lines.push(`- ${signal.type}：${signal.detail ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 熔断后的通知。两条路：
 *   1. arm.notifySessionId 有值 → 写一条 inject-pending.json（复用 inject 插件格式，下次启动回注到那个会话）；
 *   2. 没有 / 写 inject 失败 → 落一份 needs-human.md 人话摘要。
 * 不改变 needs-human 的判定与 EXIT.NEEDS_HUMAN 退出码，只是「多喊一声」。
 */
export function notifyNeedsHuman({ paths, arm, payload, now = Date.now() }) {
  const stamp = stampName(now);
  const note = {
    level: 'needs-human',
    phase: 'circuit-breaker',
    source: 'ownshield-watch',
    recovered: false,
    snapshotTag: arm?.tag ?? '',
    rollbackFiles: [],
    // 取运行时累计值：arm.failures 是看护那一刻的快照（通常 0），拿它会把 3 次写成 0 次。
    note: `连续恢复失败 ${payload?.arm?.failures ?? arm?.failures ?? '?'} 次后停手`,
    errorTail: [
      `原因：${payload?.reason ?? ''}`,
      `最后错误：${lastAttemptSummary(payload?.attempts) || '未记录'}`,
      `已停止看护：arm.json 已移入 disarm/`,
    ],
    prompt: 'ownshield 看门狗已熔断停手：连续恢复失败，已自动停止看护。请先解释根因、再给最小修复方案，不要自动重试或重启。',
  };
  const sessionId = typeof arm?.notifySessionId === 'string' ? arm.notifySessionId.trim() : '';
  const injectFile = sessionId
    ? path.join(paths.ownshield, `inject-pending-needs-human-${stamp}.json`)
    : '';
  if (sessionId) {
    try {
      writeTextAtomic(injectFile, `${JSON.stringify({ ...note, sessionId, ts: new Date(now).toISOString() }, null, 2)}\n`);
      return { ok: true, channel: 'inject', file: injectFile, sessionId };
    } catch (err) {
      const mdFile = path.join(paths.ownshield, 'needs-human.md');
      writeTextAtomic(mdFile, `${needsHumanMarkdown(payload)}\n\n> inject 通道写入失败：${err.message}\n`);
      return { ok: false, channel: 'markdown', file: mdFile, error: err.message };
    }
  }
  const mdFile = path.join(paths.ownshield, 'needs-human.md');
  writeTextAtomic(mdFile, needsHumanMarkdown(payload));
  return { ok: true, channel: 'markdown', file: mdFile };
}

/**
 * 恢复成功的通报（2026-11-21 真机演练后补）。
 *
 * 此前恢复成功只写 `recovered.json`：无人值守时，主人不翻日志就不知道 DSH 被救过一次——
 * 「救回来了但没人看见」和没救差别不大。通道与熔断通知一致：
 *   1. arm.notifySessionId 有值 → 写 `inject-pending-recovered-<stamp>.json`，由 inject 插件回注；
 *   2. 没有会话 / 写失败 → 落 `recovered.md` 人话摘要。
 * 通知只是「多喊一声」，任何失败都不影响恢复结论与退出码。
 */
export function notifyRecovered({ paths, arm, attempt, attempts = [], signals = [], now = Date.now() }) {
  const stamp = stampName(now);
  const level = attempt?.level ?? '';
  const verify = attempt?.verify ?? null;
  const sessionId = typeof arm?.notifySessionId === 'string' ? arm.notifySessionId.trim() : '';
  // 有遗嘱就用 [还魂] 消息续跑（目标 / 已完成 / 下一步 / 工具指纹）；没有就退回事后通报。
  // 遗嘱缺了就如实降级，绝不编造续跑内容——那比没有更坏。
  const signalText = (Array.isArray(signals) ? signals : [])
    .map((signal) => signal?.type)
    .filter(Boolean)
    .join('+');
  let resumeText = '';
  if (sessionId !== '') {
    try {
      resumeText = renderResume(sessionId, {
        stateDir: paths.ownshield,
        reason: `${level || '自动'} 恢复（信号 ${signalText || '未记录'}，校验 ${verify?.reason ?? '未记录'}）`,
        interruptedAt: attempt?.at,
      });
    } catch {
      resumeText = '';
    }
  }
  const recoveryFacts = `ownshield 已自动恢复：回滚快照 ${attempt?.tag ?? '?'}，重启 pid ${attempt?.restart?.pid ?? '?'}，校验 ${verify?.reason ?? '未记录'}。`;
  const note = {
    level: 'recovered',
    phase: 'auto-recovery',
    source: 'ownshield-watch',
    recovered: true,
    snapshotTag: attempt?.tag ?? '',
    rollbackFiles: [],
    note: `${level} 恢复成功：回滚快照 ${attempt?.tag ?? '?'}，重启 pid ${attempt?.restart?.pid ?? '?'}，校验 ${verify?.reason ?? '未记录'}`,
    errorTail: [
      `恢复级别：${level || '未记录'}`,
      `回滚快照：${attempt?.tag ?? '未记录'}`,
      `重启进程：pid ${attempt?.restart?.pid ?? '?'}（同时在跑 ${attempt?.restart?.running ?? '?'} 个）`,
      `校验结论：${verify?.reason ?? '未记录'}${verify?.detail ? `（${verify.detail}）` : ''}`,
      `累计尝试：${attempts.length} 次；arm.json 已移入 disarm/`,
    ],
    prompt:
      resumeText !== ''
        ? `${resumeText}\n\n（${recoveryFacts}不需要你做处置，确认上述三条后接着做。）`
        : 'ownshield 已自动恢复：这是一条事后通报，不需要你做任何处置。手上未完成的工作可以接着做。',
  };
  if (sessionId) {
    const injectFile = path.join(paths.ownshield, `inject-pending-recovered-${stamp}.json`);
    try {
      writeTextAtomic(injectFile, `${JSON.stringify({ ...note, sessionId, ts: new Date(now).toISOString() }, null, 2)}\n`);
      return { ok: true, channel: 'inject', file: injectFile, sessionId };
    } catch (err) {
      const mdFile = path.join(paths.ownshield, 'recovered.md');
      writeTextAtomic(
        mdFile,
        `# ownshield 已自动恢复\n\n${note.note}\n\n${note.errorTail.map((line) => `- ${line}`).join('\n')}\n\n> inject 通道写入失败：${err.message}\n`,
      );
      return { ok: false, channel: 'markdown', file: mdFile, error: err.message };
    }
  }
  const mdFile = path.join(paths.ownshield, 'recovered.md');
  writeTextAtomic(
    mdFile,
    `# ownshield 已自动恢复\n\n${note.note}\n\n${note.errorTail.map((line) => `- ${line}`).join('\n')}\n`,
  );
  return { ok: true, channel: 'markdown', file: mdFile };
}

// ---------------------------------------------------------------------------
// A3：F4 正常退出的自动判据 —— 进程消失不等于「被杀了」
// ---------------------------------------------------------------------------

/**
 * 查事件日志里该 pid 的崩溃记录（Application / Id 1000、1001）。
 *
 * 判据是故意保守的：查询失败一律按「疑似崩溃」返回，调用方据此判硬信号（宁误拉，不漏救）。
 * `run` 只给测试注入假实现用。
 */
export function queryCrashEvents(pid, sinceMs, { run = runPowerShell } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, crashed: null, events: [], error: 'no-pid' };
  }
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs) : new Date(Date.now() - 3_600_000);
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$start = [datetime]::ParseExact('${since.toISOString()}', 'yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
$hits = @()
try {
  $ev = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001; StartTime=$start} -ErrorAction Stop
  $hits = @($ev | Where-Object { $_.Message -match '(^|\\D)${pid}(\\D|$)' } | Select-Object -First 5 | ForEach-Object {
    @{ id = $_.Id; at = $_.TimeCreated.ToString('o'); provider = $_.ProviderName; message = $_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)) }
  })
} catch {
  if ($_.Exception.Message -notmatch 'No events were found|未找到') {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress
    exit 3
  }
}
@{ ok = $true; pid = ${pid}; events = @($hits) } | ConvertTo-Json -Depth 4 -Compress`;
  let result;
  try {
    result = run(script, { timeoutMs: 20_000 });
  } catch (err) {
    return { ok: false, crashed: null, events: [], error: err.message };
  }
  if (!result || !result.ok) {
    return { ok: false, crashed: null, events: [], error: result?.error || '事件日志查询失败' };
  }
  let parsed = null;
  try {
    parsed = parseJsonText(result.stdout);
  } catch (err) {
    return { ok: false, crashed: null, events: [], error: `事件日志输出无法解析: ${err.message}` };
  }
  if (!parsed || parsed.ok !== true) {
    return { ok: false, crashed: null, events: [], error: parsed?.error || '事件日志查询失败' };
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return { ok: true, crashed: events.length > 0, events, error: '' };
}

/** 读「看门狗自己拉起的进程」留下的退出码记录（exit-<pid>.json）。取不到就是 undefined。 */
export function readExitRecord(ownshieldDir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, exitCode: null, error: 'no-pid' };
  const file = path.join(ownshieldDir, `exit-${pid}.json`);
  const read = readJsonSafe(file);
  if (!read.exists) return { ok: false, exitCode: null, error: 'no-record' };
  if (!read.value || typeof read.value !== 'object') return { ok: false, exitCode: null, error: read.error || 'bad-record' };
  const code = Number(read.value.exitCode);
  return Number.isFinite(code)
    ? { ok: true, exitCode: code, at: read.value.at ?? '', file }
    : { ok: false, exitCode: null, error: 'bad-exit-code' };
}

/**
 * 进程消失后的定性（纯函数，四象限都走这里）：
 *   - 有崩溃事件 / 查询失败 / 有非零退出码 / 有新 crash log → 硬信号；
 *   - 只有拿到「退出码 0」才判正常退出（默认模式 exit-code）；
 *   - arm.autoGracefulExit='no-crash-evidence' 是显式降级选项：无崩溃证据即算正常退出。
 *
 * 为什么不默认放宽：F1（外部强杀）与用户正常退出在外部观测上同形——两者都不写
 * crash log、都不产生 WER 1000/1001 事件。唯一能分开的是退出码/退出意图。
 * 所以默认必须保守（拿不到退出码就按硬信号拉起），「宁误拉，不漏救」。
 */
export function classifyExit({ arm, boot, now, crash, evidence }) {
  const mode =
    arm?.autoGracefulExit === 'no-crash-evidence'
      ? 'no-crash-evidence'
      : arm?.autoGracefulExit === false
        ? 'off'
        : 'exit-code';
  if (mode === 'off') return { graceful: false, mode, reason: 'auto-graceful-disabled' };
  if (!boot || !Number.isInteger(boot.pid) || boot.pid <= 0) {
    return { graceful: false, mode, reason: 'no-pid' };
  }
  const baseline = boot.crashBaseline?.newestTime ?? boot.detectedAt ?? boot.startedAt ?? 0;
  const files = crash?.ok ? crash.files || [] : [];
  const fresh = files.find((file) => file.ts > baseline && file.ts >= (boot.startedAt ?? 0) - 60_000);
  if (fresh) return { graceful: false, mode, reason: 'new-crash-log', file: fresh.name };

  const crashEvents = evidence?.crashEvents;
  if (!crashEvents) return { graceful: false, mode, reason: 'no-exit-evidence' };
  if (crashEvents.ok !== true) {
    return { graceful: false, mode, reason: 'crash-events-unavailable', error: crashEvents.error || '' };
  }
  if (crashEvents.crashed) {
    return { graceful: false, mode, reason: 'crash-event', events: (crashEvents.events || []).slice(0, 3) };
  }
  const exitCode = Number.isFinite(evidence?.exitCode) ? evidence.exitCode : null;
  if (exitCode !== null && exitCode !== 0) {
    return { graceful: false, mode, reason: 'exit-code-nonzero', exitCode };
  }
  if (exitCode === 0) return { graceful: true, mode, reason: 'exit-code-0' };
  if (mode === 'no-crash-evidence') return { graceful: true, mode, reason: 'no-crash-evidence' };
  return { graceful: false, mode, reason: 'no-exit-code' };
}


// ---------------------------------------------------------------------------
// A4：结构性检测的处置链 —— 从「只报」到「动手」
// ---------------------------------------------------------------------------

/** 把探针失败项拼成 debride 能归因的错误原文。 */
export function structuralErrorText(signal, probes = []) {
  const parts = [signal?.detail ?? ''];
  const probe = (probes || []).find((file) => file?.name && file.name === signal?.probe) ?? probes?.[0];
  for (const check of probe?.checks ?? []) {
    if (check && check.ok === false) {
      parts.push(`${check.name ?? ''}: ${check.error ?? ''} ${check.detail ?? ''}`.trim());
    }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * 让 debride 的 state 白名单接受生产状态目录。
 *
 * debride 默认只认「本模块所在根」（开发时即工作区、随包分发时即包根），并故意拒绝 `~/.dsh`；
 * 而这里传进去的 root 是 `<状态目录>/quarantine`，生产即 `~/.dsh/ownshield/quarantine`。
 * 设计 2.2 的约定正是由调用方用 OWNSHIELD_STATE_ALLOW 显式加白，不改 debride 的默认边界。
 */
function allowDebrideStateRoot(dir) {
  const target = path.resolve(dir);
  const list = String(process.env.OWNSHIELD_STATE_ALLOW || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const already = list.some((item) => path.resolve(item).toLowerCase() === target.toLowerCase());
  if (!already) process.env.OWNSHIELD_STATE_ALLOW = [...list, target].join(';');
  return target;
}

/**
 * tool-inventory / service-inventory 缺失时的处置链：
 *   归因（只读）→ 命中则隔离（默认 dry-run，需 --allow-quarantine 才真写）→ 探针复核 → 写病历；
 *   未命中退回 L2 整包回滚。
 *
 * 所有副作用（attribute / quarantine / 探针 / 病历）都能从 `deps` 注入，测试不碰真实 profile。
 */
export function runStructuralDebride({
  paths,
  arm,
  signal,
  probes = [],
  dryRun = false,
  allowQuarantine = false,
  probeCmd = '',
  now = Date.now(),
  deps = {},
}) {
  const attributeFn = deps.attribute ?? debrideAttribute;
  const quarantineFn = deps.quarantine ?? debrideQuarantineLines;
  const probeFn = deps.probe ?? debrideRunProbeCommand;
  const ledger = {
    quarantine: deps.recordQuarantine ?? debrideRecordQuarantine,
    recovered: deps.recordRecovered ?? debrideRecordRecovered,
    rolledBack: deps.recordRolledBack ?? debrideRecordRolledBack,
  };
  allowDebrideStateRoot(paths.ownshield);
  const root = path.join(paths.ownshield, 'quarantine');
  const patchPath =
    arm?.profilePatchPath ||
    process.env.OWNSHIELD_PATCH ||
    path.join(paths.home, '.dsh', 'profiles', String(process.env.DSH_PROFILE || '').trim() || 'desktop', 'cordis.patch.yml');
  const errorText = structuralErrorText(signal, probes);
  const ts = debrideNowTs(new Date(now));

  let attr;
  try {
    attr = attributeFn(errorText, { patchPath });
  } catch (err) {
    return { ok: false, hit: false, action: 'l2-rollback', reason: `归因失败：${err.message}`, patchPath };
  }
  if (!attr || !attr.hit) {
    return {
      ok: false,
      hit: false,
      action: 'l2-rollback',
      reason: attr?.detail || '归因未命中',
      unit: attr?.unit || '',
      patchPath,
      attr,
    };
  }

  let q;
  const applied = Boolean(allowQuarantine) && !dryRun;
  try {
    // dry-run 也要能读出真实 profile 的行 → allowRealProfile 只影响写守卫，dry-run 不写盘。
    q = quarantineFn({ patchPath, attribution: attr, root, ts, dryRun: !applied, allowRealProfile: true });
  } catch (err) {
    return { ok: false, hit: true, action: 'l2-rollback', reason: `隔离失败：${err.message}`, unit: attr.unit, patchPath, attr };
  }

  if (!applied) {
    return {
      ok: true,
      hit: true,
      dryRun: true,
      applied: false,
      action: 'would-quarantine',
      repaired: false,
      unit: attr.unit,
      detail: attr.detail,
      patchPath,
      quarantine: { id: q.quarantineId, dir: q.dir },
      attr,
    };
  }

  const record = ledger.quarantine(root, {
    unit: attr.unit,
    errcode: attr.errcode,
    quarantineId: q.quarantineId,
    ts,
    patchPath,
    lines: attr.lines ?? null,
    action: attr.action,
    detail: attr.detail,
  });

  if (!probeCmd) {
    return {
      ok: true,
      hit: true,
      applied: true,
      action: 'applied-unverified',
      repaired: false,
      unit: attr.unit,
      quarantine: { id: q.quarantineId, dir: q.dir },
      recurrence: record?.recurCount ?? 1,
      reason: '没有 --probe-cmd，无法复核；不把「未复核」当成功',
      patchPath,
      attr,
    };
  }

  let probe;
  try {
    probe = probeFn(probeCmd, { timeoutMs: 120_000 });
  } catch (err) {
    probe = { ok: false, error: err.message };
  }
  if (probe?.ok) {
    ledger.recovered(root, {
      unit: attr.unit,
      errcode: attr.errcode,
      quarantineId: q.quarantineId,
      ts,
      probe,
      detail: '隔离后复核通过',
    });
    return {
      ok: true,
      hit: true,
      applied: true,
      action: 'quarantined+probe-ok',
      repaired: true,
      unit: attr.unit,
      quarantine: { id: q.quarantineId, dir: q.dir },
      recurrence: record?.recurCount ?? 1,
      probe,
      patchPath,
      attr,
    };
  }
  ledger.rolledBack(root, { unit: attr.unit, errcode: attr.errcode, quarantineId: q.quarantineId, ts, err: probe?.error || 'probe failed' });
  return {
    ok: false,
    hit: true,
    applied: true,
    action: 'l2-rollback',
    repaired: false,
    unit: attr.unit,
    quarantine: { id: q.quarantineId, dir: q.dir },
    recurrence: record?.recurCount ?? 1,
    reason: `隔离后复核失败：${probe?.error || probe?.exitCode || 'unknown'}`,
    probe,
    patchPath,
    attr,
  };
}

// ---------------------------------------------------------------------------
// 观测基础设施自检：先保证自己能看见，再谈看得见别人
// ---------------------------------------------------------------------------

const DISK_MIN_BYTES = 2 * 1024 * 1024 * 1024;
/** 非阻断告警线：低于 512 MB 只写 warnings（arm status 与 watch dry-run 用）。 */
const DISK_WARN_BYTES = 512 * 1024 * 1024;

/** 目标路径不存在时，向上取最近一个存在的祖先（statfs 只认存在的路径）。 */
function nearestExisting(target) {
  let current = path.resolve(String(target));
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return os.homedir();
    current = parent;
  }
  return os.homedir();
}

/** 可写盘剩余空间（B）：取所有相关路径里最小的一个；查不到给 null 与告警。 */
export function diskFreeInfo(targets = []) {
  const warnings = [];
  const checked = [];
  let freeBytes = null;
  let at = '';
  if (typeof fs.statfsSync !== 'function') {
    warnings.push('磁盘检查不可用：当前 Node 没有 fs.statfsSync（需要 Node 18+）');
    return { freeBytes: null, path: '', checked, warnings };
  }
  for (const target of targets) {
    const value = String(target || '').trim();
    if (value === '') continue;
    const probe = nearestExisting(value);
    checked.push(probe);
    try {
      const stats = fs.statfsSync(probe);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(free) && (freeBytes === null || free < freeBytes)) {
        freeBytes = free;
        at = probe;
      }
    } catch (err) {
      warnings.push(`磁盘空间查询失败（${probe}）：${err.message}`);
    }
  }
  if (freeBytes !== null && freeBytes < DISK_WARN_BYTES) {
    warnings.push(`磁盘剩余 ${(freeBytes / 1048576).toFixed(0)} MB < 512 MB（不阻断，但快照与回滚可能失败）`);
  }
  return { freeBytes, path: at, checked, warnings };
}

/**
 * 看门狗依赖三件东西：磁盘能写、crash 目录可写、计划任务还在跑它。
 * 任何一件坏了，故障检测都会静默失效——所以在判别人之前先判自己。
 */
export function probeInfra({ dir, crashDir, checkTask = true }) {
  const problems = [];
  const out = { ok: true, diskFreeBytes: null, taskExists: null, problems };
  try {
    if (typeof fs.statfsSync === 'function') {
      // ~/.dsh 可能是指向其它盘符的 junction（2026-11-20 迁到 E:），
      // 只查它会漏掉 C 盘——而 Electron 缓存（%APPDATA%）仍在 C 盘。
      // 取所有相关路径里最小的剩余空间判定。
      const targets = [dir, process.env.APPDATA].filter(
        (value) => typeof value === 'string' && value !== '',
      );
      let minFree = null;
      for (const target of targets) {
        try {
          const stats = fs.statfsSync(target);
          const free = Number(stats.bavail) * Number(stats.bsize);
          if (minFree === null || free < minFree) minFree = free;
        } catch {
          /* 单个路径查不到不致命，继续看其它盘 */
        }
      }
      out.diskFreeBytes = minFree;
      if (minFree !== null && minFree < DISK_MIN_BYTES) {
        problems.push(`磁盘剩余 ${(minFree / 1073741824).toFixed(2)} GB < 2 GB`);
      }
    }
  } catch (err) {
    problems.push(`磁盘空间查询失败: ${err.message}`);
  }
  try {
    fs.mkdirSync(crashDir, { recursive: true });
    const probeFile = path.join(crashDir, `.ownshield-write-probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
  } catch (err) {
    problems.push(`crash 目录不可写: ${err.message}`);
  }
  if (checkTask) {
    const r = runCaptured('schtasks.exe', ['/Query', '/TN', 'ownshield-watch'], {
      timeoutMs: 15000,
      tag: 'task',
    });
    out.taskExists = Boolean(r.ok);
    if (!r.ok) problems.push('计划任务 ownshield-watch 不存在或已禁用（看门狗会静默停摆）');
  }
  out.ok = problems.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function runLocked({ opts, paths, arm, armId, now, t0 }) {
  const stateRead = readJsonSafe(paths.state);
  const previousState = normalizeState(stateRead.value);
  const state = previousState.armId === armId ? previousState : freshState(armId);
  const failures = Math.max(arm.failures, state.failures || 0);
  state.failures = failures;
  if (!state.levelsUsed) state.levelsUsed = {};

  const procName = resolveProcessName(opts);
  const procs = listProcesses(procName);
  const crashDir = arm.crashLogDir || paths.crashDir;
  const crash = scanCrashLogs(crashDir);
  const heartbeats = scanHeartbeats(paths.ownshield);
  const probes = scanProbes(paths.ownshield);

  const bootInfo = resolveBoot({ paths, arm, armId, procs, crash, now, dryRun: opts.dryRun });
  // 新 boot 已建立 = 这次重启已经落地，「上次退出是预期的」这个预期兑现了，标记该消失。
  // 另外过期标记也要清：万一 boot 一直没换（例如重启失败），脏字段不能躺着。
  // 不清的话它会一直留着，下一次**真崩溃**就会被当成正常退出而不救。
  const staleMark = arm.expectGracefulExit === true && !gracefulMarkValid(arm, now);
  if (!opts.dryRun && (bootInfo.changed || staleMark)) clearGracefulMark(paths);
  const boot = bootInfo.boot;
  const signals = boot
    ? evaluateSignals({
        arm,
        boot,
        now,
        procs: procs.list,
        procsOk: procs.ok,
        crash,
        heartbeats,
        probes,
        // A3：只有进程真的消失时才去查事件日志（一次 PowerShell 约 0.3-1s）。
        exitEvidence:
          arm.crashEventQuery === false
            ? undefined
            : () => ({
                crashEvents: queryCrashEvents(boot.pid, boot.startedAt),
                exitCode: readExitRecord(paths.ownshield, boot.pid).exitCode,
              }),
      })
    : [];
  const strikes = updateStrikes(state.strikes, signals, now);
  state.strikes = strikes;
  state.lastSignals = signals.map((signal) => signal.type);

  const decision = decideRecovery({ signals, strikes, confirmations: arm.confirmations });
  const effectiveDecision = bootInfo.waiting
    ? { action: 'none', reason: 'waiting-for-boot（启动看护后尚未出现新启动）', waiting: true }
    : decision;
  const base = {
    version: WATCH_VERSION,
    at: iso(now),
    dryRun: opts.dryRun,
    armed: true,
    arm: {
      tag: arm.tag,
      armedAt: arm.armedAt,
      graceSeconds: arm.graceSeconds,
      maxLevel: arm.maxLevel,
      failures,
      baselineTag: arm.baselineTag,
      armId,
      maxRecoveryAttempts: arm.maxRecoveryAttempts,
    },
    boot: boot ? { ...boot } : null,
    processName: procName,
    process: {
      name: procName,
      ok: procs.ok,
      count: procs.list.length,
      underArm: boot ? procs.list.filter((proc) => sameBoot(proc, boot)).length : 0,
      error: procs.error || '',
    },
    crash: {
      ok: crash.ok,
      dir: crashDir,
      source: arm.crashLogDir ? 'arm.crashLogDir' : paths.logSource || 'default',
      newest: crash.files[0] ? { name: crash.files[0].name, at: iso(crash.files[0].ts) } : null,
      error: crash.error || '',
    },
    heartbeat: {
      ok: heartbeats.ok,
      count: heartbeats.files.length,
      newest: heartbeats.files[0] ? iso(heartbeats.files[0].ts) : null,
    },
    probe: (() => {
      const latest = probes.files[0];
      if (!latest) return { count: 0, latest: null };
      const classified = classifyProbe(latest);
      return {
        count: probes.files.length,
        latest: { name: latest.name, at: iso(latest.ts), ok: latest.ok, structural: classified.structural },
      };
    })(),
    signals: signals.map((signal) => ({ ...signal })),
    strikes,
    decision: effectiveDecision,
    bootChange: bootInfo.changed ? { changed: true } : { changed: false },
    waiting: Boolean(bootInfo.waiting),
    needsHuman: false,
    attempts: [],
    plan: [],
  };

  // ---- 观测基础设施异常：先交人，不做无意义的恢复 ----
  // dry-run 不判故障（ok 恒 true、problems 恒空），但磁盘剩余空间是只读量，照实算出来。
  const infra = opts.dryRun
    ? (() => {
        const disk = diskFreeInfo([paths.ownshield, crashDir, process.env.APPDATA]);
        return { ok: true, problems: [], diskFreeBytes: disk.freeBytes, diskPath: disk.path, warnings: disk.warnings, taskExists: null };
      })()
    : probeInfra({ dir: paths.ownshield, crashDir, checkTask: true });
  base.infra = infra;
  if (!infra.ok) {
    state.lastResult = 'infra-unhealthy';
    state.lastCheckAt = iso(now);
    if (!opts.dryRun) {
      writeNeedsHuman(paths, arm, [{ type: 'infra-unhealthy', detail: infra.problems.join('；') }], state.attempts, failures);
      const dest = disarm(paths, 'infra-unhealthy');
      writeJsonAtomic(paths.state, state);
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        result: 'needs-human',
        level: 'none',
        detail: `观测基础设施异常：${infra.problems.join('；')}`,
        disarm: dest,
      });
    }
    base.needsHuman = true;
    base.decision = { ...decision, action: 'needs-human', reason: '观测基础设施异常，已停止看护' };
    return { exitCode: EXIT.NEEDS_HUMAN, output: base };
  }

  // ---- 正常退出：启动看护时显式声明过，不拉起、直接停止看护 ----
  if (signals.some((signal) => signal.type === 'graceful-exit')) {
    const graceful = signals.find((signal) => signal.type === 'graceful-exit');
    state.lastCheckAt = iso(now);
    state.lastResult = 'graceful-exit';
    if (!opts.dryRun) {
      writeJsonAtomic(paths.state, state);
      const dest = disarm(paths, 'graceful-exit');
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        result: 'graceful-exit',
        detail: graceful.detail,
        disarm: dest,
      });
    }
    base.decision = {
      ...decision,
      action: 'disarm',
      reason: 'graceful-exit（arm.expectGracefulExit=true，按正常退出处理，不拉起）',
    };
    return { exitCode: EXIT.OK, output: base };
  }

  // ---- 无信号：观察/健康 ----
  if (decision.action === 'none') {
    state.lastCheckAt = iso(now);
    state.lastResult = bootInfo.waiting ? 'waiting' : 'ok';
    if (!opts.dryRun) {
      writeJsonAtomic(paths.state, state);
      appendLog(paths, {
        event: 'check',
        arm: arm.tag,
        result: signals.length === 0 ? 'ok' : 'observe',
        signals: signals.map((signal) => signal.type).join(',') || 'none',
      });
    }
    return { exitCode: EXIT.OK, output: base };
  }

  // ---- 观察：软信号首次出现，等下一轮复现 ----
  if (decision.action === 'observe') {
    state.lastCheckAt = iso(now);
    state.lastResult = 'observe';
    if (!opts.dryRun) {
      writeJsonAtomic(paths.state, state);
      appendLog(paths, {
        event: 'check',
        arm: arm.tag,
        result: 'observe',
        signals: signals.map((signal) => signal.type).join(','),
        detail: decision.reason,
      });
    }
    base.plan = planLevels(arm, state);
    base.decision = {
      ...decision,
      wouldLevel: base.plan[0]?.level ?? '',
      wouldTag: base.plan[0]?.tag ?? '',
    };
    return { exitCode: EXIT.OK, output: base };
  }

  // ---- A4：结构性检测的处置链（命中就动手，未命中直接退 L2） ----
  const structuralSignal = signals.find((signal) => signal.type === 'probe-failure');
  if (decision.action === 'recover' && structuralSignal && arm.structuralDebride !== false) {
    const chain = runStructuralDebride({
      paths,
      arm,
      signal: structuralSignal,
      probes: probes.files,
      dryRun: Boolean(opts.dryRun),
      allowQuarantine: Boolean(opts.allowQuarantine),
      probeCmd: opts.probeCmd || '',
      now: Date.now(),
    });
    base.structural = chain;
    if (!opts.dryRun) {
      appendLog(paths, {
        event: 'debride',
        arm: arm.tag,
        result: chain.action,
        unit: chain.unit || '',
        detail: chain.reason || chain.detail || '',
      });
    }
    if (chain.repaired) {
      const dest = disarm(paths, 'structural-repaired');
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        result: 'structural-repaired',
        level: 'L0',
        unit: chain.unit || '',
        disarm: dest,
      });
      state.lastResult = 'recovered';
      state.lastCheckAt = iso(Date.now());
      writeJsonAtomic(paths.state, state);
      base.decision = { ...decision, action: 'recover', reason: `结构性修复成功：${chain.unit || ''}` };
      return { exitCode: EXIT.RECOVERED, output: { ...base, recovered: true, attempts: base.attempts } };
    }
    if (!opts.dryRun && chain.action === 'l2-rollback' && arm.maxLevel >= 2) {
      // 归因未命中 / 复核失败：跳过 L1 的定点隔离，直接整包回滚。
      state.levelsUsed.L1 = true;
      writeJsonAtomic(paths.state, state);
    }
  }

  // ---- 恢复 ----
  const level = nextLevel(arm, state);
  if (!level) {
    state.lastResult = 'needs-human';
    if (!opts.dryRun) {
      const payload = writeNeedsHuman(paths, arm, signals, state.attempts, failures);
      const dest = disarm(paths, 'needs-human');
      state.lastCheckAt = iso(now);
      writeJsonAtomic(paths.state, state);
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        result: 'needs-human',
        level: 'none',
        detail: payload.reason,
        disarm: dest,
      });
    }
    base.needsHuman = true;
    base.decision = { ...decision, level: '', tag: '' };
    return { exitCode: EXIT.NEEDS_HUMAN, output: base };
  }

  const tag = levelTag(arm, level);
  base.plan = planLevels(arm, state);
  base.decision = { ...decision, level, tag };

  if (opts.dryRun) {
    base.simulatedPlan = base.plan;
    return { exitCode: EXIT.OK, output: base };
  }

  if (failures >= arm.maxFailures) {
    const payload = writeNeedsHuman(paths, arm, signals, state.attempts, failures);
    const dest = disarm(paths, 'needs-human');
    appendLog(paths, {
      event: 'recover',
      arm: arm.tag,
      result: 'needs-human',
      level: 'none',
      detail: payload.reason,
      disarm: dest,
    });
    base.needsHuman = true;
    return { exitCode: EXIT.NEEDS_HUMAN, output: base };
  }

  const preCrash = crash.ok ? crash.files[0]?.ts ?? 0 : 0;
  const hbSeenBefore = heartbeats.ok && heartbeats.files.length > 0;
  const exe = resolveExe(opts, arm, procs);
  base.install = { exe, asar: exe ? resolveInstallAsar(exe) : resolveInstallAsar() };
  let recovered = false;
  let lastFailure = '';
  // 只有 cookie 过期这一个信号时：重启即可，不回滚 asar（C 类回滚无意义，还可能降级）。
  const cookieOnly = signals.length === 1 && signals[0].type === 'cookie-stale';

  for (;;) {
    const currentLevel = nextLevel(arm, state);
    if (!currentLevel) break;
    if (Date.now() - t0 > DEFAULTS.attemptBudgetMs) {
      lastFailure = 'attempt-budget-exceeded';
      break;
    }
    refreshLock(paths, armId);
    const currentTag = levelTag(arm, currentLevel);

    // 快照过期闸：快照与当前安装不是同一份时，回滚等于降级——停手交人，宁可不动。
    // cookie 过期不回滚，这道闸对它没有意义，直接跳过；L3 只还原 profile 层、不碰 asar，同理跳过。
    const guard = cookieOnly
      ? { ok: true, skipped: true, reason: 'cookie-only', detail: 'cookie 过期只重启，不回滚 asar' }
      : currentLevel === 'L3'
        ? { ok: true, skipped: true, reason: 'profile-only', detail: 'L3 只还原 profile 层，不动 asar，不做哈希闸' }
        : checkSnapshotGuard(currentTag, { asarPath: resolveInstallAsar(exe) });
    base.snapshotGuard = guard;
    if (!guard.ok) {
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'snapshot-guard',
        result: 'needs-human',
        detail: `${guard.reason}: ${guard.detail}`,
        tag: currentTag,
      });
      writeNeedsHuman(
        paths,
        arm,
        [...signals, { type: 'snapshot-mismatch', hard: true, detail: guard.detail }],
        state.attempts,
        state.failures,
      );
      const guardDest = disarm(paths, 'snapshot-mismatch');
      state.lastResult = 'needs-human';
      writeJsonAtomic(paths.state, state);
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        result: 'needs-human',
        detail: `snapshot-guard: ${guard.reason}`,
        disarm: guardDest,
      });
      base.needsHuman = true;
      base.decision = {
        ...decision,
        level: currentLevel,
        tag: currentTag,
        action: 'needs-human',
        reason: `快照不可用于回滚：${guard.detail}`,
      };
      return {
        exitCode: EXIT.NEEDS_HUMAN,
        output: { ...base, needsHuman: true, snapshotGuard: guard, attempts: base.attempts },
      };
    }

    let restore;
    if (cookieOnly) {
      restore = { ok: true, error: '' };
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'restore',
        result: 'skipped',
        detail: 'cookie-only：只重启，不回滚 asar',
        tag: currentTag,
      });
    } else {
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'restore',
        result: 'start',
        tag: currentTag,
      });
      restore = restoreSnapshot(currentTag, { profileOnly: currentLevel === 'L3' });
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'restore',
        result: restore.ok ? 'ok' : 'fail',
        detail: restore.ok ? '' : restore.error,
      });
    }

    let restart = null;
    let verify = null;
    if (restore.ok) {
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'restart',
        result: 'start',
        exe,
      });
      restart = restartDsh(exe);
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'restart',
        result: restart.ok ? 'ok' : 'fail',
        detail: restart.ok ? `pid=${restart.pid}` : restart.error,
      });
      if (restart.ok && restart.startedAt !== null) {
        // 杀进程/拉起过程中自身可能写一条 crash log；以「启动后」扫到的最新时间作基线，
        // 避免把这次重启的副作用误判成新故障。
        const postCrash = scanCrashLogs(crashDir);
        const baselineTime = Math.max(
          preCrash,
          postCrash.ok ? postCrash.files[0]?.ts ?? 0 : 0,
        );
        const newBoot = buildBoot({
          arm,
          armId,
          proc: { pid: restart.pid, start: restart.startedAt, path: exe },
          now: Date.now(),
          crash: postCrash,
        });
        newBoot.crashBaseline = {
          newestTime: baselineTime,
          newestName: postCrash.ok ? postCrash.files[0]?.name ?? '' : '',
          count: postCrash.ok ? postCrash.files.length : 0,
        };
        try {
          const previousBoot = normalizeBoot(readJsonSafe(paths.boot).value);
          persistBoot(paths, newBoot, previousBoot);
        } catch (err) {
          appendLog(paths, {
            event: 'recover',
            arm: arm.tag,
            level: currentLevel,
            action: 'write-boot',
            result: 'fail',
            detail: err.message,
          });
        }
        verify = verifyAfterRestart({
          paths,
          arm,
          bootStart: restart.startedAt,
          crashBaseline: baselineTime,
          hbSeenBefore,
          expectStartedAt: restart.startedAt,
          procName,
        });
        appendLog(paths, {
          event: 'recover',
          arm: arm.tag,
          level: currentLevel,
          action: 'verify',
          result: verify.ok ? 'ok' : 'fail',
          detail: verify.ok ? verify.reason : `${verify.reason}:${verify.detail}`,
        });
      }
    }

    const ok = Boolean(restore.ok && restart?.ok && verify?.ok);
    const attempt = {
      at: iso(Date.now()),
      level: currentLevel,
      tag: currentTag,
      restore: { ok: restore.ok, error: restore.error || '' },
      restart: restart
        ? { ok: restart.ok, pid: restart.pid, running: restart.running, error: restart.error || '' }
        : null,
      verify: verify ? { ok: verify.ok, reason: verify.reason, detail: verify.detail || '' } : null,
      result: ok ? 'ok' : 'fail',
    };
    state.attempts = [...state.attempts, attempt].slice(-20);
    state.recoveryAttempts = (state.recoveryAttempts || 0) + 1;
    if (currentLevel === 'L1') state.levelsUsed.L1 = true;
    else if (currentLevel === 'L3') state.levelsUsed.L3 = true;
    else state.levelsUsed.L2 = (state.levelsUsed.L2 || 0) + 1;
    state.strikes = {};
    state.lastCheckAt = iso(Date.now());
    state.lastResult = ok ? 'recovered' : 'recovery-failed';
    state.failures = ok ? 0 : state.failures + 1;
    base.attempts.push(attempt);
    writeJsonAtomic(paths.state, state);

    if (ok) {
      recovered = true;
      writeRecovered(paths, arm, attempt, state.attempts);
      // 一次看护只管一次：救回来就停止看护，别让它在背后长期持有回滚权。
      // 要再守护，重新启动看护（改内核前建快照 → 写 arm.json）。
      const dest = disarm(paths, 'recovered');
      appendLog(paths, {
        event: 'recover',
        arm: arm.tag,
        level: currentLevel,
        action: 'disarm',
        result: 'ok',
        detail: dest,
      });
      // 恢复成功也要有人知道：通知失败绝不影响恢复结论。
      try {
        const notify = notifyRecovered({ paths, arm, attempt, attempts: state.attempts, signals });
        appendLog(paths, {
          event: 'notify',
          arm: arm.tag,
          level: currentLevel,
          action: 'recovered',
          result: notify.ok ? notify.channel : 'fail',
          detail: notify.file || notify.error || '',
        });
      } catch (err) {
        appendLog(paths, {
          event: 'notify',
          arm: arm.tag,
          level: currentLevel,
          action: 'recovered',
          result: 'fail',
          detail: err.message,
        });
      }
      break;
    }

    lastFailure = attempt.verify?.reason || attempt.restart?.error || attempt.restore?.error || 'unknown';
    updateArmFailures(paths, state.failures);
    // cookie 过期只重启一次：重启没救回来就是别的问题，不要再升级成回滚。
    if (cookieOnly) break;
    if (state.failures >= arm.maxFailures) break;
  }

  if (recovered) {
    appendLog(paths, { event: 'recover', arm: arm.tag, result: 'recovered', level: base.attempts.at(-1)?.level });
    return { exitCode: EXIT.RECOVERED, output: { ...base, recovered: true, attempts: base.attempts } };
  }

  const payload = writeNeedsHuman(paths, arm, signals, state.attempts, state.failures);
  const dest = disarm(paths, 'needs-human');
  state.lastResult = 'needs-human';
  writeJsonAtomic(paths.state, state);
  appendLog(paths, {
    event: 'recover',
    arm: arm.tag,
    result: 'needs-human',
    level: 'none',
    detail: `${payload.reason}${lastFailure ? ` (last=${lastFailure})` : ''}`,
    disarm: dest,
  });
  base.needsHuman = true;
  return { exitCode: EXIT.NEEDS_HUMAN, output: base };
}

/** 只读地推算「如果现在触发，会依次尝试哪几级」。 */
export function planLevels(arm, state) {
  const simulated = {
    recoveryAttempts: state?.recoveryAttempts ?? 0,
    levelsUsed: { ...(state?.levelsUsed ?? {}) },
  };
  const plan = [];
  for (let i = 0; i < 8; i++) {
    const level = nextLevel(arm, simulated);
    if (!level) break;
    plan.push({ level, tag: levelTag(arm, level) });
    simulated.recoveryAttempts += 1;
    if (level === 'L1') simulated.levelsUsed.L1 = true;
    else if (level === 'L3') simulated.levelsUsed.L3 = true;
    else simulated.levelsUsed.L2 = (simulated.levelsUsed.L2 ?? 0) + 1;
  }
  return plan;
}

function acquireLock(paths, armId) {
  const now = Date.now();
  const read = readJsonSafe(paths.lock);
  if (read.value && read.value.released !== true) {
    const startedAt = parseTime(read.value.startedAt);
    const stale = startedAt === null || now - startedAt > DEFAULTS.lockStaleMs;
    const alive = isPidAlive(Number(read.value.pid));
    if (!stale && alive) return { ok: false, holder: read.value };
  }
  const lock = { pid: process.pid, startedAt: iso(now), armId, released: false };
  writeJsonAtomic(paths.lock, lock);
  return { ok: true, lock };
}

function releaseLock(paths, lock) {
  if (!lock?.ok) return;
  try {
    writeJsonAtomic(paths.lock, { ...lock.lock, released: true, endedAt: iso(Date.now()) });
  } catch {
    /* best effort */
  }
}

/** 恢复流程可能跑几分钟；每个动作前续租，避免下一轮把它当僵尸锁。 */
function refreshLock(paths, armId) {
  try {
    writeJsonAtomic(paths.lock, { pid: process.pid, startedAt: iso(Date.now()), armId, released: false });
  } catch {
    /* best effort */
  }
}

export function runWatch(opts) {
  const paths = resolvePaths(opts);
  const t0 = Date.now();
  const armRead = readJsonSafe(paths.arm);

  /**
   * 只读诊断块：进程名 / 崩溃日志目录（含来源）/ 安装 asar / 磁盘剩余。
   * 未在看护的每分钟那一跑也要能看到自己用的是哪一套路径，否则换机器后
   * 「什么都没发生」根本没法查。statfs 与 existsSync 都是只读、无子进程。
   */
  const diagnostics = () => {
    const disk = diskFreeInfo([paths.ownshield, paths.crashDir, process.env.APPDATA]);
    return {
      processName: resolveProcessName(opts),
      logs: { dir: paths.crashDir, source: paths.logSource || 'default' },
      installAsar: paths.installAsar,
      disk: { freeBytes: disk.freeBytes, path: disk.path, warnings: disk.warnings },
    };
  };

  if (!armRead.exists) {
    // 未在看护也守一件事：本地 Web 登录 cookie 过期。它不来自任何故障，只是时间到了，
    // 「按需看护」不该让它等到下次看护才被发现——代价是读两个文件，不是常驻守护。
    // 空串要走默认值（$DSH_HOME 或 ~/.dsh），不能当路径传下去。
    const cookieHome = opts.dshHome && String(opts.dshHome).trim() !== '' ? opts.dshHome : undefined;
    const cookie =
      opts.cookieGuard === false
        ? { state: 'disabled', detail: 'cookie 守卫已关闭（--no-cookie-guard）' }
        : evaluateWebCookie({ home: cookieHome, now: t0 });
    if (cookie.state !== 'stale') {
      return {
        exitCode: EXIT.OK,
        output: {
          version: WATCH_VERSION,
          at: iso(t0),
          dryRun: Boolean(opts.dryRun),
          armed: false,
          ...diagnostics(),
          cookieGuard: cookie.state,
          decision: { action: 'none', reason: `unarmed（arm.json 不存在）· ${cookie.detail}` },
          exitCode: EXIT.OK,
        },
      };
    }
    if (opts.dryRun) {
      return {
        exitCode: EXIT.OK,
        output: {
          version: WATCH_VERSION,
          at: iso(t0),
          dryRun: true,
          armed: false,
          ...diagnostics(),
          cookieGuard: cookie,
          decision: { action: 'recover', reason: `cookie-stale（dry-run：会重启，不回滚）· ${cookie.detail}` },
          exitCode: EXIT.OK,
        },
      };
    }
    // 防循环：失败后退避 10 分钟，别每分钟砸一次重启。
    const cooldownMs = 10 * 60 * 1000;
    const previous = readJsonSafe(paths.cookieGuard).value;
    const lastAttemptAt = parseTime(previous?.lastAttemptAt);
    if (lastAttemptAt !== null && t0 - lastAttemptAt < cooldownMs) {
      return {
        exitCode: EXIT.OK,
        output: {
          version: WATCH_VERSION,
          at: iso(t0),
          dryRun: false,
          armed: false,
          ...diagnostics(),
          cookieGuard: cookie,
          decision: {
            action: 'hold',
            reason: `cookie-stale 但上次重启尝试在 ${Math.round((t0 - lastAttemptAt) / 1000)}s 前，退避中`,
          },
          exitCode: EXIT.OK,
        },
      };
    }
    const procs = listProcesses(resolveProcessName(opts));
    const exe = resolveExe(opts, null, procs);
    const restart = restartDsh(exe, resolveProcessName(opts));
    try {
      writeJsonAtomic(paths.cookieGuard, {
        lastAttemptAt: iso(t0),
        result: restart.ok ? 'ok' : 'fail',
        detail: restart.ok ? `pid=${restart.pid}` : restart.error,
        ageHours: cookie.ageHours,
        limitHours: cookie.limitHours,
      });
    } catch {
      /* 退避文件写不进去不影响本次重启结论 */
    }
    appendLog(paths, {
      event: 'cookie-guard',
      action: 'restart',
      result: restart.ok ? 'ok' : 'fail',
      detail: restart.ok ? `${cookie.detail} pid=${restart.pid}` : `${cookie.detail} ${restart.error}`,
      exe,
    });
    return {
      exitCode: restart.ok ? EXIT.RECOVERED : EXIT.ERROR,
      output: {
        version: WATCH_VERSION,
        at: iso(t0),
        dryRun: false,
        armed: false,
        ...diagnostics(),
        cookieGuard: cookie,
        restart,
        decision: { action: 'recover', reason: `cookie-stale（未在看护也重启，不回滚）· ${cookie.detail}` },
        exitCode: restart.ok ? EXIT.RECOVERED : EXIT.ERROR,
      },
    };
  }

  if (armRead.error || !armRead.value || typeof armRead.value !== 'object') {
    const detail = armRead.error || 'arm.json 不是对象';
    if (!opts.dryRun) {
      appendLog(paths, { event: 'error', action: 'read-arm', result: 'fail', detail });
    }
    return {
      exitCode: EXIT.ERROR,
      output: {
        version: WATCH_VERSION,
        at: iso(t0),
        dryRun: Boolean(opts.dryRun),
        armed: true,
        error: `arm.json 无法解析: ${detail}`,
        decision: { action: 'none', reason: 'arm-invalid' },
        exitCode: EXIT.ERROR,
      },
    };
  }

  const fallbackArmedAt = (() => {
    try {
      return fs.statSync(paths.arm).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  const arm = normalizeArm(armRead.value, fallbackArmedAt);
  const armId = armIdOf(arm);

  if (arm.tag === 'unknown') {
    const detail = 'arm.json 缺少有效 tag，拒绝进入恢复流程';
    if (!opts.dryRun) appendLog(paths, { event: 'error', action: 'read-arm', result: 'fail', detail });
    return {
      exitCode: EXIT.ERROR,
      output: {
        version: WATCH_VERSION,
        at: iso(t0),
        dryRun: Boolean(opts.dryRun),
        armed: true,
        error: detail,
        decision: { action: 'none', reason: 'arm-invalid' },
        exitCode: EXIT.ERROR,
      },
    };
  }

  if (!opts.dryRun) {
    let lock;
    try {
      lock = acquireLock(paths, armId);
    } catch (err) {
      return {
        exitCode: EXIT.ERROR,
        output: { version: WATCH_VERSION, at: iso(t0), dryRun: false, armed: true, error: err.message, exitCode: EXIT.ERROR },
      };
    }
    if (!lock.ok) {
      return {
        exitCode: EXIT.OK,
        output: {
          version: WATCH_VERSION,
          at: iso(t0),
          dryRun: false,
          armed: true,
          busy: true,
          holder: lock.holder,
          decision: { action: 'none', reason: '另一轮看门狗仍在运行，本轮跳过' },
          exitCode: EXIT.OK,
        },
      };
    }
    try {
      const result = runLocked({ opts, paths, arm, armId, now: Date.now(), t0 });
      result.output.exitCode = result.exitCode;
      result.output.armProblems = arm.problems;
      return result;
    } finally {
      releaseLock(paths, lock);
    }
  }

  const result = runLocked({ opts, paths, arm, armId, now: Date.now(), t0 });
  result.output.exitCode = result.exitCode;
  result.output.armProblems = arm.problems;
  return result;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 未在看护/看护状态都要露出的只读诊断（换机器后排查全靠这几行）。 */
function pushDiagnostics(out, lines) {
  if (out.processName) lines.push(`  进程名: ${out.processName}`);
  if (out.logs) lines.push(`  崩溃日志目录: ${out.logs.dir}（来源 ${out.logs.source}）`);
  if (out.installAsar) lines.push(`  安装 asar: ${out.installAsar}`);
  pushInfraLines(out.disk ? { diskFreeBytes: out.disk.freeBytes, diskPath: out.disk.path, warnings: out.disk.warnings } : null, lines);
}

/** 磁盘与观测基础设施：数值照实打，告警用 ~ 前缀（不阻断）。 */
function pushInfraLines(infra, lines) {
  if (!infra) return;
  lines.push(
    typeof infra.diskFreeBytes === 'number'
      ? `  磁盘: 剩余 ${(infra.diskFreeBytes / 1048576).toFixed(0)} MB${infra.diskPath ? `（${infra.diskPath}）` : ''}`
      : `  磁盘: 剩余空间未知`,
  );
  for (const warning of infra.warnings || []) lines.push(`  ~ ${warning}`);
  if (infra.taskExists === false) lines.push('  ~ 计划任务 ownshield-watch 不存在（看门狗会静默停摆）');
}

function renderHuman(result) {
  const out = result.output;
  const lines = [];
  if (!out.armed) {
    const cookie = out.cookieGuard;
    const suffix = typeof cookie === 'string' ? ` · cookie 守卫: ${cookie}` : '';
    if (out.restart) {
      lines.push(
        `[ownshield-watch] 未在看护 · cookie 过期 → ${out.restart.ok ? `已重启 pid=${out.restart.pid}` : `重启失败：${out.restart.error}`}`,
      );
      lines.push(`  判定: ${out.decision?.reason ?? ''}`);
      return lines;
    }
    lines.push(`[ownshield-watch] 未在看护：arm.json 不存在${suffix}`);
    if (cookie && typeof cookie === 'object') lines.push(`  判定: ${out.decision?.reason ?? ''}`);
    pushDiagnostics(out, lines);
    return lines;
  }
  const mode = out.dryRun ? 'dry-run' : 'live';
  lines.push(
    `[ownshield-watch] ${mode} · tag=${out.arm.tag} armedAt=${out.arm.armedAt} grace=${out.arm.graceSeconds}s maxLevel=${out.arm.maxLevel} failures=${out.arm.failures}`,
  );
  if (out.error) lines.push(`  错误: ${out.error}`);
  lines.push(
    `  进程: ${out.process.name ? `${out.process.name} ` : ''}${out.process.ok ? `${out.process.count} 个` : `查询失败（${out.process.error}）`}；启动看护后启动匹配 ${out.process.underArm}`,
  );
  if (out.install) lines.push(`  安装: exe=${out.install.exe || '(未探测到)'} asar=${out.install.asar || '(未探测到)'}`);
  if (out.logs) lines.push(`  崩溃日志目录: ${out.logs.dir}（来源 ${out.logs.source}）`);
  if (out.boot) {
    lines.push(
      `  boot: pid=${out.boot.pid} startedAt=${iso(out.boot.startedAt)} graceUntil=${iso(out.boot.graceUntil)}`,
    );
  } else {
    lines.push('  boot: 尚未检测到启动看护后的启动（等待重启后继续，不做任何动作）');
  }
  lines.push(
    `  crash: ${out.crash.ok ? `最新 ${out.crash.newest ? `${out.crash.newest.name} @ ${out.crash.newest.at}` : '无'}` : `目录不可读（${out.crash.error}）`}`,
  );
  lines.push(
    `  心跳: ${out.heartbeat.count} 个${out.heartbeat.newest ? `，最新 ${out.heartbeat.newest}` : ''}`,
  );
  if (out.probe.latest) {
    lines.push(
      `  探针: ${out.probe.latest.name} ok=${out.probe.latest.ok} structural=${out.probe.latest.structural}`,
    );
  } else {
    lines.push('  探针: 无 probe-*.json');
  }
  if (out.signals?.length) {
    for (const signal of out.signals) {
      lines.push(
        `  信号: ${signal.type}（${signal.hard ? '硬失败' : '软失败'}）${SIGNAL_LABEL[signal.type] ?? ''} — ${signal.detail ?? ''}`,
      );
    }
  } else {
    lines.push('  信号: 无');
  }

  if (out.busy) {
    lines.push('  判定: 跳过（另一轮看门狗持有锁）');
  } else if (out.needsHuman) {
    lines.push('  判定: 交人（已写 needs-human.json 并停止看护）');
  } else if (out.recovered) {
    lines.push(`  判定: 已恢复（${out.attempts.at(-1)?.level} → ${out.attempts.at(-1)?.tag}）`);
  } else if (out.waiting) {
    lines.push('  判定: 等待启动看护后的启动（尚未看到 armedAt 之后的新进程，不做任何动作）');
  } else if (out.decision?.action === 'recover') {
    lines.push(
      `  判定: ${out.dryRun ? '将执行' : '执行'} ${out.decision.level}（tag=${out.decision.tag}；${out.decision.reason}）`,
    );
  } else if (out.decision?.action === 'observe') {
    const pending = out.decision.pending;
    lines.push(
      `  判定: 观察中（${pending?.type ?? ''} ${pending?.count ?? 0}/${DEFAULTS.softConfirmations}，需复现；若复现将执行 ${out.plan?.[0]?.level ?? 'L?'}）`,
    );
  } else if (out.armed) {
    lines.push('  判定: 健康（无异常）');
  }

  if (out.attempts?.length) {
    for (const attempt of out.attempts) {
      lines.push(
        `  尝试: ${attempt.level} restore(${attempt.tag}) ${attempt.restore.ok ? 'ok' : 'fail'} → restart ${attempt.restart?.ok ? 'ok' : 'fail'} → verify ${attempt.verify?.ok ? 'ok' : attempt.verify?.reason ?? 'skip'}`,
      );
    }
  }
  if (out.plan?.length) {
    lines.push(`  恢复计划: ${out.plan.map((step) => `${step.level}(${step.tag})`).join(' → ')}`);
  }
  if (out.armProblems?.length) {
    lines.push(`  配置提示: ${out.armProblems.join('；')}`);
  }
  if (out.infra) pushInfraLines(out.infra, lines);
  if (out.dryRun) lines.push('[DRY-RUN] 未执行任何动作，未修改状态目录与安装目录。');
  return lines;
}

function emit(opts, result) {
  if (opts.json) {
    console.log(JSON.stringify(result.output, null, 2));
    return;
  }
  if (opts.quiet && result.exitCode === EXIT.OK) return;
  for (const line of renderHuman(result)) console.log(line);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ownshield-watch] ${err.message}`);
    return EXIT.ERROR;
  }
  if (opts.help) {
    usage();
    return EXIT.OK;
  }
  if (opts.version) {
    console.log(WATCH_VERSION);
    return EXIT.OK;
  }
  if (opts.checkSnapshot) {
    // 启动看护前的自检：快照能不能用来回滚。启动看护后看门狗也会在恢复前再核一次。
    const guard = checkSnapshotGuard(opts.checkSnapshot);
    if (opts.json) {
      console.log(JSON.stringify({ tag: opts.checkSnapshot, ...guard }, null, 2));
    } else if (guard.ok) {
      console.log(`[OK] 快照「${opts.checkSnapshot}」可用于回滚：${guard.detail}`);
    } else {
      console.log(`[拒绝] 快照「${opts.checkSnapshot}」不能用于回滚：${guard.detail}（reason=${guard.reason}）`);
    }
    return guard.ok ? EXIT.OK : EXIT.NEEDS_HUMAN;
  }
  try {
    const result = runWatch(opts);
    emit(opts, result);
    return result.exitCode;
  } catch (err) {
    console.error(`[ownshield-watch] 失败: ${err.stack || err.message}`);
    return EXIT.ERROR;
  }
}

const entry =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (entry) {
  process.exitCode = main();
}

export { main };
