#!/usr/bin/env node
/**
 * ownshield arm —— 看护 / 停止看护 / 状态三合一。
 *
 * 用法：
 *   node arm.mjs arm --tag <tag> [--notify-session <id>] [--state-dir <dir>] [--dry-run] [--json]
 *                   [--node-path <node.exe>] [--no-task]
 *   node arm.mjs disarm [--reason <r>] [--state-dir <dir>] [--json]
 *   node arm.mjs status [--state-dir <dir>] [--json]
 *
 * 设计约束（按需看护、非常驻）：
 *   - 只有三步前置检查全部通过才写 arm.json：快照存在、快照闸通过
 *     （等价于 watch.mjs --check-snapshot <tag> 返回 0）、DSH 主进程存在。
 *   - armedAt 取「最早主进程启动时刻 - 10 秒」，让启动看护时刻早于本次启动，
 *     watch 会自己认当前 boot（11-21 已验证的做法）。
 *   - 计划任务幂等：schtasks /Create /F 覆盖同名任务。
 *   - 停止看护只移动 arm.json，不删除计划任务：未在看护时 cookie 守卫仍需每分钟运行。
 *   - status 严格只读：只读文件与查询任务，不写任何文件、不启动看门狗。
 *   - --dry-run 完整判定并输出，但不写 arm.json、不建任务、不建目录；
 *     启动器内容照算（输出 launcher.content），只是不落盘。
 *   - 计划任务不再引用仓库里的静态 watch-silent.vbs：启动看护时按运行时探测到的
 *     node 路径与 watch.mjs 绝对路径生成 <stateDir>/watch-silent.vbs，
 *     任务命令行指向这份生成的启动器。仓库里那份只剩模板用途。
 *   - 找不到 Node 是硬失败（ok:false + problems），不静默跳过——否则看门狗等于不存在。
 *   - --no-task：只写 arm.json 与启动器、跳过 schtasks（沙盘/验收用）。
 *
 * 退出码：0 成功；3 前置检查拒绝（未写任何文件）；2 其它错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = fs.realpathSync(path.dirname(SELF));
const SNAPSHOT_CLI = path.join(SCRIPT_DIR, 'snapshot.mjs');
const WATCH_CLI = path.join(SCRIPT_DIR, 'watch.mjs');
/**
 * 启动器文件名。启动看护时生成到 <stateDir>/watch-silent.vbs，计划任务指向它。
 * 仓库里同名文件（tools/ownshield/watch-silent.vbs）只留注释模板，见 buildLauncherContent()。
 */
const LAUNCHER_FILENAME = 'watch-silent.vbs';
/** 旧版快照库位置（与 watch.mjs / snapshot.mjs 一致）。 */
const LEGACY_SNAPSHOTS_DIR = path.join(path.resolve(SCRIPT_DIR, '..', '..'), 'snapshots');
const TMP_DIR = path.join(os.tmpdir(), 'ownshield-arm');

const EXIT = { OK: 0, ERROR: 2, REFUSED: 3 };
const DEFAULT_TASK_NAME = 'ownshield-watch';
const DEFAULT_PROCESS_NAME = 'DeepSeek Harness';
const COOKIE_COOLDOWN_MS = 10 * 60 * 1000;
const ARM_DEFAULTS = {
  graceSeconds: 120,
  maxLevel: 2,
  maxRecoveryAttempts: 3,
  baselineTag: 'baseline',
  failures: 0,
};
/** README 的环境要求：Node 22+。低版本只告警，不阻断看护。 */
const NODE_MIN_MAJOR = 22;
const NODE_PROBE_TIMEOUT_MS = 15000;
/** 磁盘告警线（低于它只写 warnings，不阻断）。 */
const DISK_WARN_BYTES = 512 * 1024 * 1024;

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString();

/** 本地时间戳 YYYYMMDDTHHMMSS（与 watch.mjs / snapshot.mjs 的命名一致）。 */
export function stampName(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** ISO / epoch(秒或毫秒) 都接受；无法解析返回 null。 */
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

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null, error: '' };
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { exists: true, value: JSON.parse(text), error: '' };
  } catch (err) {
    return { exists: true, value: null, error: err.message };
  }
}

/** 用文件描述符捕获子进程输出（不走管道，DSH 沙箱同样可用）。 */
function runCaptured(command, args, { timeoutMs = 30000, tag = 'cmd', env = {} } = {}) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const base = path.join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  try {
    fs.unlinkSync(outFile);
    fs.unlinkSync(errFile);
  } catch {
    /* 临时文件清理失败不影响结论 */
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
 * 取最早那个 DSH 主进程的启动时刻。
 *
 * 优先按任务书用 Get-CimInstance Win32_Process；沙箱或权限不足时会拒绝访问，
 * 此时退回 Get-Process（watch.mjs 的同一兜底：同名进程里最早的就是主进程）。
 */
const PS_PROCS = String.raw`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$name = $env:OWN_PROC_NAME
$source = 'cim'
$list = @()
try {
  $list = @(Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction Stop | Sort-Object CreationDate)
} catch {
  $source = 'process'
  $list = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Sort-Object StartTime)
}
$count = $list.Count
if ($count -eq 0) {
  ConvertTo-Json -InputObject @{ ok = $true; found = $false; count = 0; source = $source } -Compress
  exit 0
}
$first = $list[0]
$start = $null
$pidValue = 0
$exePath = ''
if ($source -eq 'cim') {
  $start = $first.CreationDate.ToUniversalTime().ToString('o')
  $pidValue = [int]$first.ProcessId
  $exePath = [string]$first.ExecutablePath
} else {
  $start = $first.StartTime.ToUniversalTime().ToString('o')
  $pidValue = [int]$first.Id
  try { $exePath = [string]$first.Path } catch { $exePath = '' }
}
ConvertTo-Json -InputObject @{ ok = $true; found = $true; count = $count; source = $source; pid = $pidValue; creationDate = $start; executablePath = $exePath } -Compress
`;

function runPowerShell(script, { timeoutMs = 20000, env = {} } = {}) {
  const shells = [process.env.OWNSHIELD_PS, 'powershell.exe', 'pwsh', 'powershell'].filter(
    (value, index, all) => typeof value === 'string' && value !== '' && all.indexOf(value) === index,
  );
  let lastError = '';
  for (const shell of shells) {
    const result = runCaptured(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeoutMs,
      env,
      tag: 'ps',
    });
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

export function listDshProcesses(name = DEFAULT_PROCESS_NAME) {
  const result = runPowerShell(PS_PROCS, { timeoutMs: 20000, env: { OWN_PROC_NAME: name } });
  if (!result.ok) return { ok: false, found: false, count: 0, pid: 0, creationDate: '', source: '', path: '', error: result.error || result.stderr };
  const parsed = parseJsonChunk(result.stdout);
  if (!parsed || parsed.ok !== true) {
    return { ok: false, found: false, count: 0, pid: 0, creationDate: '', source: '', path: '', error: '进程查询输出无法解析' };
  }
  return {
    ok: true,
    found: parsed.found === true,
    count: Number(parsed.count) || 0,
    pid: Number(parsed.pid) || 0,
    creationDate: typeof parsed.creationDate === 'string' ? parsed.creationDate : '',
    source: typeof parsed.source === 'string' ? parsed.source : '',
    path: typeof parsed.executablePath === 'string' ? parsed.executablePath : '',
    error: '',
  };
}

// ---------------------------------------------------------------------------
// 运行时探测：node / DSH 可执行文件 / 崩溃日志目录 / 磁盘
// （全部「运行时得出」，代码里不写死本机盘符；探测不到就明确报错）
// ---------------------------------------------------------------------------

const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node';

/** 跑一次 <file> -e '...' 校验它确实能执行 JS，并取出版本号。 */
export function probeNodeVersion(file) {
  const value = String(file || '').trim();
  if (value === '') return { ok: false, version: '', error: '路径为空' };
  if (!fs.existsSync(value)) return { ok: false, version: '', error: '路径不存在' };
  try {
    if (!fs.statSync(value).isFile()) return { ok: false, version: '', error: '不是文件' };
  } catch (err) {
    return { ok: false, version: '', error: err.message };
  }
  const result = runCaptured(value, ['-e', 'process.stdout.write(process.versions.node)'], {
    timeoutMs: NODE_PROBE_TIMEOUT_MS,
    tag: 'node',
  });
  const version = result.stdout.trim();
  if (!result.ok || !/^\d+\.\d+\.\d+/.test(version)) {
    return { ok: false, version: '', error: result.error || `退出码 ${result.status}，没有输出版本号` };
  }
  return { ok: true, version, error: '' };
}

/** `where node`（非 Windows 用 which）的结果，按 PATH 顺序。 */
export function whereNodePaths() {
  const tool = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runCaptured(tool, ['node'], { timeoutMs: 10000, tag: 'where' });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 常见安装位置（含 DSH 自带的受管运行时）——只是候选，不作为事实依据。 */
export function commonNodeCandidates() {
  const out = [];
  const programDirs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  for (const root of programDirs) {
    if (root) out.push(path.join(root, 'nodejs', NODE_BIN));
  }
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', NODE_BIN));
    out.push(path.join(process.env.LOCALAPPDATA, 'nodejs', NODE_BIN));
  }
  const dshHome = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(os.homedir(), '.dsh', 'dsh-runtimes')])) {
    try {
      for (const entry of fs.readdirSync(root)) {
        out.push(path.join(root, entry, 'dependencies', 'node', 'bin', NODE_BIN));
      }
    } catch {
      /* 没有受管运行时目录，正常 */
    }
  }
  return out;
}

/**
 * node 路径解析顺序（与 README 一致）：
 *   --node-path（config.nodePath）→ OWNSHIELD_NODE → DSH_NODE → NODE_EXE
 *   → `where node` → 常见安装位置。
 * 显式配置了但指不到能跑的 node 时**直接失败**，不悄悄换别的路径。
 */
export function resolveNodePath(opts = {}, { verify = true } = {}) {
  const tried = [];
  const check = (value) =>
    verify ? probeNodeVersion(value) : { ok: fs.existsSync(value), version: '', error: '路径不存在' };
  const explicit = [
    ['config:nodePath', opts.nodePath],
    ['env:OWNSHIELD_NODE', process.env.OWNSHIELD_NODE],
    ['env:DSH_NODE', process.env.DSH_NODE],
    ['env:NODE_EXE', process.env.NODE_EXE],
  ];
  for (const [source, raw] of explicit) {
    const value = String(raw || '').trim();
    if (value === '') continue;
    tried.push(`${source}=${value}`);
    const probe = check(value);
    if (probe.ok) return { ok: true, path: value, source, version: probe.version, tried, error: '' };
    const hintVar = source.startsWith('env:') ? source.slice(4) : 'nodePath';
    return {
      ok: false,
      path: '',
      source,
      version: '',
      tried,
      error: `找不到 Node：配置的 ${source} 指向「${value}」，但它${probe.error || '不是可用的 node'}。请安装 Node.js ${NODE_MIN_MAJOR}+，或把 ${hintVar} 指向真实的 ${NODE_BIN}。`,
    };
  }
  for (const candidate of whereNodePaths()) {
    tried.push(`where:${candidate}`);
    const probe = check(candidate);
    if (probe.ok) return { ok: true, path: candidate, source: 'where', version: probe.version, tried, error: '' };
  }
  for (const candidate of commonNodeCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    tried.push(`common:${candidate}`);
    const probe = check(candidate);
    if (probe.ok) return { ok: true, path: candidate, source: 'common', version: probe.version, tried, error: '' };
  }
  return {
    ok: false,
    path: '',
    source: '',
    version: '',
    tried,
    error:
      `找不到 Node 可执行文件：已试过 --node-path / OWNSHIELD_NODE / DSH_NODE / NODE_EXE、where node、常见安装位置（${commonNodeCandidates().length} 处）。` +
      `请安装 Node.js ${NODE_MIN_MAJOR}+，或设置环境变量 OWNSHIELD_NODE / 配置项 nodePath 指向 ${NODE_BIN}。`,
  };
}

/** DSH 可执行文件的候选（常见安装位置，不写死盘符）。 */
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

/**
 * 解析 DSH 可执行文件：OWNSHIELD_EXE → 运行中进程的 ExecutablePath → 常见安装位置。
 * 显式覆盖原样返回（是否可用由调用方如实报告），不拿本机路径硬试。
 */
export function resolveInstalledExe(opts = {}, preProbed = null) {
  const explicit = String(process.env.OWNSHIELD_EXE || opts.exe || '').trim();
  if (explicit !== '') {
    return { path: explicit, source: 'OWNSHIELD_EXE', exists: fs.existsSync(explicit), candidates: [] };
  }
  const procs = preProbed || listDshProcesses(resolveProcessName(opts));
  if (procs.ok && procs.found && procs.path !== '' && fs.existsSync(procs.path)) {
    return { path: procs.path, source: 'process', exists: true, candidates: [] };
  }
  const candidates = commonExeCandidates();
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return { path: found, source: 'common', exists: true, candidates };
  return { path: '', source: '', exists: false, candidates };
}

/** 崩溃日志目录：OWNSHIELD_LOG_DIR > OWNSHIELD_CRASH_DIR > %APPDATA%\@deepseek-ai\dsh-desktop\logs。 */
export function resolveLogDir() {
  for (const [source, raw] of [
    ['OWNSHIELD_LOG_DIR', process.env.OWNSHIELD_LOG_DIR],
    ['OWNSHIELD_CRASH_DIR', process.env.OWNSHIELD_CRASH_DIR],
  ]) {
    const value = String(raw || '').trim();
    if (value !== '') return { dir: path.resolve(value), source };
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return { dir: path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'), source: 'default' };
}

/** 目标路径不存在时，向上找到最近一个存在的祖先（statfs 只认存在的路径）。 */
function nearestExisting(target) {
  let current = path.resolve(target);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return os.homedir();
    current = parent;
  }
  return os.homedir();
}

/** 可写盘剩余空间（B）。低于 DISK_WARN_BYTES 只写 warnings，不阻断。 */
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
  if (freeBytes === null) {
    if (warnings.length === 0) warnings.push('磁盘空间查询失败：没有可用的查询路径');
  } else if (freeBytes < DISK_WARN_BYTES) {
    warnings.push(`磁盘剩余 ${(freeBytes / 1048576).toFixed(0)} MB < 512 MB（不阻断，但快照与回滚可能失败）`);
  }
  return { freeBytes, path: at, checked, warnings };
}

/** VBS 字符串字面量：把内容整体放进一对双引号里，内部每个 " 写成 ""。 */
function vbsLiteral(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}

/**
 * 生成计划任务启动器内容。
 *
 * 为什么用 wscript + Run(..., 0, False)：schtasks 直接调 node.exe 会以
 * InteractiveToken 建控制台，桌面每分钟闪一下；wscript 是 GUI 子系统宿主，
 * 窗口样式 0 让 node 完全隐藏。
 */
export function buildLauncherContent({ nodePath, nodeSource = '', nodeVersion = '', watchScript, stateDir, nowMs = Date.now() }) {
  // 只有含空白的参数才加引号（Windows 命令行解析约定），旗帜参数保持原样。
  const quoteArg = (value) => (/[\s"]/.test(String(value)) ? `"${value}"` : String(value));
  const args = [nodePath, watchScript, '--state-dir', stateDir].map(quoteArg);
  const lines = [
    "' ownshield 计划任务启动器 —— 由 arm.mjs 在启动看护时动态生成，请勿手工编辑",
    "' 生成时间: " + new Date(nowMs).toISOString(),
    "' node:     " + nodePath + (nodeSource ? "（来源 " + nodeSource + (nodeVersion ? "，v" + nodeVersion : "") + "）" : ""),
    "' watch:    " + watchScript,
    "' 状态目录: " + stateDir,
    "' 说明: wscript.exe 以 GUI 子系统隐藏窗口调用 node，避免计划任务每分钟闪控制台。",
    'Option Explicit',
    'Dim sh, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    "cmd = " + vbsLiteral(args.join(' ')),
    'sh.Run cmd, 0, False',
    '',
  ];
  return lines.join('\r\n');
}

/** 计划任务命令行：指向**生成的**启动器，不再引用仓库里那份静态模板。 */
export function taskCommand(launcherPath) {
  return `wscript.exe //B //Nologo "${launcherPath}"`;
}

/** 快照库解析（与 watch.mjs / snapshot.mjs 规则一致），附带旧位置告警文字。 */
export function resolveSnapshotsDir() {
  const override = String(process.env.OWNSHIELD_SNAPSHOTS || '').trim();
  if (override) return { dir: path.resolve(override), source: 'env', warning: '' };
  const preferred = path.join(os.homedir(), '.dsh', 'ownshield', 'snapshots');
  if (hasSnapshotDirs(preferred)) return { dir: preferred, source: 'default', warning: '' };
  if (hasSnapshotDirs(LEGACY_SNAPSHOTS_DIR)) {
    return {
      dir: LEGACY_SNAPSHOTS_DIR,
      source: 'legacy',
      warning: `[ownshield] 快照库仍位于旧路径 ${LEGACY_SNAPSHOTS_DIR}，建议迁移到 ${preferred}（或设 OWNSHIELD_SNAPSHOTS）`,
    };
  }
  return { dir: preferred, source: 'default', warning: '' };
}

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

export function listSnapshotTags(dir) {
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
      const raw = JSON.parse(fs.readFileSync(path.join(dir, ent.name, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (raw && typeof raw.tag === 'string' && raw.tag) tags.push(raw.tag);
    } catch {
      /* 坏 manifest 跳过，不阻断其它快照 */
    }
  }
  return tags;
}

/** 等价于 watch.mjs --check-snapshot <tag> 返回 0。 */
export function checkSnapshotGuard(tag) {
  if (!fs.existsSync(WATCH_CLI)) {
    return { ok: false, exitCode: EXIT.ERROR, reason: 'watch-missing', detail: `看门狗脚本缺失：${WATCH_CLI}` };
  }
  const result = runCaptured(process.execPath, [WATCH_CLI, '--check-snapshot', tag, '--json'], {
    timeoutMs: 120000,
    tag: 'guard',
  });
  const parsed = parseJsonChunk(result.stdout);
  const ok = result.status === 0 && parsed?.ok === true;
  const detail =
    (parsed && typeof parsed.detail === 'string' && parsed.detail) ||
    result.error ||
    result.stderr.trim().split(/\r?\n/).pop() ||
    `watch --check-snapshot 退出码 ${result.status}`;
  return { ok, exitCode: result.status, reason: parsed?.reason || '', detail, sha256: parsed?.sha256 || '' };
}

export function resolveStateDir(opts = {}) {
  return path.resolve(opts.stateDir || process.env.OWNSHIELD_DIR || path.join(os.homedir(), '.dsh', 'ownshield'));
}

export function resolveTaskName(opts = {}) {
  const given = String(opts.taskName || process.env.OWNSHIELD_TASK_NAME || '').trim();
  return given || DEFAULT_TASK_NAME;
}

function resolveProcessName(opts = {}) {
  const given = String(opts.processName || process.env.OWNSHIELD_PROC_NAME || '').trim();
  return given || DEFAULT_PROCESS_NAME;
}

function queryTaskExists(taskName) {
  const result = spawnSync('schtasks.exe', ['/Query', '/TN', taskName], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15000,
  });
  return !result.error && result.status === 0;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清理失败不影响结论 */
    }
    throw err;
  }
}

function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function sanitizeReason(reason) {
  const text = String(reason ?? '').trim() || 'manual';
  return text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'manual';
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    help: false,
    stateDir: '',
    tag: '',
    notifySession: '',
    reason: 'manual',
    taskName: '',
    processName: '',
    nodePath: '',
    noTask: false,
    replace: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--no-task') opts.noTask = true;
    else if (arg === '--replace') opts.replace = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--tag') opts.tag = argv[++i] ?? '';
    else if (arg === '--notify-session') opts.notifySession = argv[++i] ?? '';
    else if (arg === '--state-dir') opts.stateDir = argv[++i] ?? '';
    else if (arg === '--reason') opts.reason = argv[++i] ?? 'manual';
    else if (arg === '--task-name') opts.taskName = argv[++i] ?? '';
    else if (arg === '--process-name') opts.processName = argv[++i] ?? '';
    else if (arg === '--node-path') opts.nodePath = argv[++i] ?? '';
    else if (arg.startsWith('--tag=')) opts.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--notify-session=')) opts.notifySession = arg.slice('--notify-session='.length);
    else if (arg.startsWith('--state-dir=')) opts.stateDir = arg.slice('--state-dir='.length);
    else if (arg.startsWith('--reason=')) opts.reason = arg.slice('--reason='.length);
    else if (arg.startsWith('--task-name=')) opts.taskName = arg.slice('--task-name='.length);
    else if (arg.startsWith('--process-name=')) opts.processName = arg.slice('--process-name='.length);
    else if (arg.startsWith('--node-path=')) opts.nodePath = arg.slice('--node-path='.length);
    else throw new Error(`未知参数: ${arg}（--help 查看用法）`);
  }
  return opts;
}

function usage() {
  console.log(`ownshield arm —— 看护 / 停止看护 / 状态（按需，非常驻）

用法:
  node arm.mjs arm --tag <快照tag> [--notify-session <会话id>] [--state-dir <目录>] [--dry-run] [--json]
                   [--node-path <node.exe>] [--no-task]
  node arm.mjs disarm [--reason <原因>] [--state-dir <目录>] [--json]
  node arm.mjs status [--state-dir <目录>] [--json]

  --dry-run      完整判定与输出，但不写 arm.json、不建计划任务、不建目录
  --state-dir    覆盖 ~/.dsh/ownshield（验收/沙盘用）
  --task-name    计划任务名（默认 ownshield-watch）
  --node-path    指定 node 可执行文件（等价 config.nodePath；默认运行时探测）
  --no-task      只写 arm.json 与 <stateDir>/watch-silent.vbs，跳过 schtasks（沙盘/验收用）
  --replace      已处于看护状态时强制覆盖既有 arm.json（默认拒绝：回滚点是安全资产，
                 覆盖一次就少一个已知可用状态；同一 tag 的重复调用按幂等放行）
  --json         机器可读输出

启动看护前置检查（任一不过即拒绝，退出码 3，不写任何文件）:
  1. 快照存在；2. 快照闸通过（watch.mjs --check-snapshot 返回 0）；3. DSH 主进程存在；
  4. 能探测到可执行的 node（找不到就明确报错——没有 Node 看门狗等于不存在）。
  启动器在启动看护时按探测到的 node 路径生成到 <stateDir>/watch-silent.vbs，计划任务指向它。
  node 探测顺序：--node-path(config.nodePath) → OWNSHIELD_NODE → DSH_NODE → NODE_EXE
                 → where node → 常见安装位置。
环境要求：Windows + Node.js ${NODE_MIN_MAJOR}+（见 README）。
停止看护只把 arm.json 移入 disarm/，不删除计划任务（未在看护时 cookie 守卫仍需每分钟运行）。
status 只读：不读之外不写任何文件、不启动看门狗。`);
}

/** arm 子命令。 */
export function arm(opts) {
  const stateDir = resolveStateDir(opts);
  const armFile = path.join(stateDir, 'arm.json');
  const tag = String(opts.tag || '').trim();
  const notifySessionId = String(opts.notifySession || '').trim();
  const taskName = resolveTaskName(opts);
  const problems = [];
  const checks = [];

  if (tag === '') {
    checks.push({ name: 'tag', ok: false, detail: '缺少 --tag（快照 tag 不能为空）' });
    problems.push('缺少 --tag（快照 tag 不能为空）');
  }

  // 已在看护时默认拒绝覆盖：回滚点是安全资产，覆盖一次就少一个已知可用状态。
  // 同一 tag 的重复调用按幂等放行（重试不该被拦），不同 tag 必须显式 replace。
  const existingRead = readJsonSafe(armFile);
  const existing =
    existingRead.exists && existingRead.value && typeof existingRead.value === 'object' ? existingRead.value : null;
  const existingTag = existing && typeof existing.tag === 'string' ? existing.tag : '';
  const existingArmedAt = existing && typeof existing.armedAt === 'string' ? existing.armedAt : '';
  const sameTag = existing !== null && existingTag === tag && tag !== '';
  if (existing !== null && !sameTag && opts.replace !== true) {
    checks.push({
      name: 'already-armed',
      ok: false,
      detail: `已处于看护状态：tag ${existingTag || '(空)'}，armedAt ${existingArmedAt || '(未记录)'}`,
    });
    problems.push(
      `已处于看护状态（tag ${existingTag || '(空)'}，armedAt ${existingArmedAt || '(未记录)'}）：` +
        '继续会覆盖回滚点。先 ownshield_disarm，或确认要覆盖再传 replace=true。',
    );
  } else if (existing !== null) {
    checks.push({
      name: 'already-armed',
      ok: true,
      detail: sameTag
        ? `重复看护同一快照「${tag}」，按幂等处理`
        : `覆盖既有看护（tag ${existingTag || '(空)'} → ${tag}，replace=true）`,
    });
  }

  const snapshots = resolveSnapshotsDir();
  const tags = listSnapshotTags(snapshots.dir);
  const snapshotOk = tag !== '' && tags.includes(tag);
  checks.push({
    name: 'snapshot-exists',
    ok: snapshotOk,
    detail: snapshotOk
      ? `快照「${tag}」存在于 ${snapshots.dir}`
      : `快照不存在：${tag || '(空)'}（可用：${tags.join(', ') || '无'}；目录：${snapshots.dir}）`,
  });
  if (snapshotOk === false) {
    problems.push(`快照不存在：${tag || '(空)'}（可用：${tags.join(', ') || '无'}）`);
  }

  const guard = tag === ''
    ? { ok: false, detail: '缺少 --tag，无法核对快照闸', exitCode: EXIT.REFUSED }
    : checkSnapshotGuard(tag);
  checks.push({ name: 'snapshot-guard', ok: guard.ok, detail: guard.detail });
  if (!guard.ok) problems.push(`快照闸拒绝：${guard.detail}`);

  const products = listDshProcesses(resolveProcessName(opts));
  const creationMs = products.ok && products.found ? parseTime(products.creationDate) : null;
  const processOk = products.ok && products.found && creationMs !== null;
  const processDetail = processOk
    ? `${products.count} 个同名进程，最早 pid=${products.pid} 启动于 ${products.creationDate}（来源 ${products.source}）`
    : products.ok
      ? `未找到 DSH 主进程「${resolveProcessName(opts)}」（进程数 ${products.count}）`
      : `进程查询失败：${products.error}`;
  checks.push({ name: 'dsh-process', ok: processOk, detail: processDetail });
  if (!processOk) problems.push(processDetail);

  // 启动器：启动看护时按运行时探测到的 node 生成到状态目录；仓库里的静态文件只剩模板。
  const launcherPath = path.join(stateDir, LAUNCHER_FILENAME);
  const watchScriptOk = fs.existsSync(WATCH_CLI);
  const node = resolveNodePath(opts);
  const launcherContent = node.ok && watchScriptOk
    ? buildLauncherContent({
        nodePath: node.path,
        nodeSource: node.source,
        nodeVersion: node.version,
        watchScript: WATCH_CLI,
        stateDir,
      })
    : '';
  checks.push({
    name: 'task-launcher',
    ok: node.ok && watchScriptOk,
    detail: !node.ok
      ? `无法生成启动器：${node.error}`
      : watchScriptOk
        ? `计划任务启动器${fs.existsSync(launcherPath) ? '已存在' : '将生成'}：${launcherPath}（node ${node.path}，来源 ${node.source}）`
        : `看门狗脚本缺失：${WATCH_CLI}`,
  });
  if (!node.ok) problems.push(node.error);
  if (!watchScriptOk) problems.push(`看门狗脚本缺失：${WATCH_CLI}`);

  const warnings = [];
  if (node.ok) {
    const major = Number(String(node.version).split('.')[0]);
    if (Number.isFinite(major) && major > 0 && major < NODE_MIN_MAJOR) {
      warnings.push(`node ${node.version} 低于建议的 ${NODE_MIN_MAJOR}+（看护本身不阻断，但恢复链未在该版本验证）`);
    }
  }
  const logs = resolveLogDir();
  const disk = diskFreeInfo([stateDir, logs.dir]);
  warnings.push(...disk.warnings);
  const exe = resolveInstalledExe(opts, products);
  if (exe.path === '') {
    warnings.push('未能探测到 DSH 可执行文件（计划任务仍会建；恢复时需 OWNSHIELD_EXE 或 arm.json 的 exePath）');
  } else if (exe.exists === false) {
    warnings.push(`解析到的 DSH 可执行文件不存在：${exe.path}（来源 ${exe.source}）`);
  }

  const base = {
    dryRun: Boolean(opts.dryRun),
    tag,
    armedAt: processOk ? iso(creationMs - 10_000) : '',
    stateDir,
    armJson: armFile,
    armJsonWritten: false,
    task: { name: taskName, exists: false, created: false, skipped: false, command: taskCommand(launcherPath) },
    launcher: {
      path: launcherPath,
      content: launcherContent,
      written: false,
      nodePath: node.path,
      nodeSource: node.source,
      nodeVersion: node.version,
      watchScript: WATCH_CLI,
    },
    node: { ok: node.ok, path: node.path, source: node.source, version: node.version, tried: node.tried },
    exe,
    logs,
    disk,
    warnings,
    checks,
    problems,
  };

  if (problems.length > 0) {
    base.task.exists = queryTaskExists(taskName);
    return { exitCode: EXIT.REFUSED, output: { ok: false, ...base } };
  }

  if (opts.dryRun) {
    base.task.exists = queryTaskExists(taskName);
    return { exitCode: EXIT.OK, output: { ok: true, ...base } };
  }

  const payload = {
    tag,
    armedAt: base.armedAt,
    graceSeconds: ARM_DEFAULTS.graceSeconds,
    maxLevel: ARM_DEFAULTS.maxLevel,
    maxRecoveryAttempts: ARM_DEFAULTS.maxRecoveryAttempts,
    baselineTag: ARM_DEFAULTS.baselineTag,
    failures: ARM_DEFAULTS.failures,
    launcherPath,
    nodePath: node.path,
    ...(exe.path ? { exePath: exe.path } : {}),
    ...(notifySessionId ? { notifySessionId } : {}),
  };
  // 先落启动器再落 arm.json：arm.json 一出现就代表「已在看护」，别让它指向不存在的启动器。
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(launcherPath, launcherContent, 'utf8');
  base.launcher.written = true;
  writeJsonAtomic(armFile, payload);
  base.armJsonWritten = true;

  if (opts.noTask) {
    base.task.skipped = true;
    checks.push({
      name: 'task-create',
      ok: true,
      detail: `--no-task：已生成启动器与 arm.json，跳过计划任务（${taskName}）`,
    });
    return { exitCode: EXIT.OK, output: { ok: true, ...base } };
  }

  const created = spawnSync(
    'schtasks.exe',
    ['/Create', '/TN', taskName, '/SC', 'MINUTE', '/MO', '1', '/F', '/TR', taskCommand(launcherPath)],
    { stdio: 'ignore', windowsHide: true, timeout: 30000 },
  );
  const createdOk = !created.error && created.status === 0;
  base.task.created = createdOk;
  base.task.exists = queryTaskExists(taskName);
  if (!createdOk) {
    const detail = `计划任务创建失败（schtasks 退出码 ${created.error ? -1 : created.status}）`;
    problems.push(detail);
    checks.push({ name: 'task-create', ok: false, detail });
    const moved = quarantineArm(armFile, 'task-create-failed');
    base.armJsonWritten = false;
    base.armJsonRolledBack = moved;
    checks.push({
      name: 'arm-rollback',
      ok: moved !== '',
      detail:
        moved !== ''
          ? `arm.json 已移入 failed/（没有计划任务就不保留看护状态）：${moved}`
          : 'arm.json 回滚失败——请手动 ownshield_disarm 后重试',
    });
    return { exitCode: EXIT.ERROR, output: { ok: false, ...base } };
  }
  checks.push({ name: 'task-create', ok: true, detail: `计划任务「${taskName}」已创建或覆盖（幂等）` });
  if (!base.task.exists) {
    const detail = `计划任务「${taskName}」创建后查询不到`;
    problems.push(detail);
    checks.push({ name: 'task-create', ok: false, detail });
    const moved = quarantineArm(armFile, 'task-missing');
    base.armJsonWritten = false;
    base.armJsonRolledBack = moved;
    checks.push({
      name: 'arm-rollback',
      ok: moved !== '',
      detail:
        moved !== ''
          ? `arm.json 已移入 failed/（计划任务查不到就不保留看护状态）：${moved}`
          : 'arm.json 回滚失败——请手动 ownshield_disarm 后重试',
    });
    return { exitCode: EXIT.ERROR, output: { ok: false, ...base } };
  }
  return { exitCode: EXIT.OK, output: { ok: true, ...base } };
}

/**
 * 把 arm.json 移入 failed/（留档，绝不删除）。
 * 用于「看护写到一半失败」的路径：没有计划任务就没有值守，留着 arm.json 只会制造
 * 「看起来已在看护、实际上没人盯」的假状态——那比没看护更危险。
 */
function quarantineArm(armFile, reason) {
  try {
    if (!fs.existsSync(armFile)) return '';
    const dir = path.join(path.dirname(armFile), 'failed');
    fs.mkdirSync(dir, { recursive: true });
    const target = uniquePath(path.join(dir, `arm-${stampName(Date.now())}-${reason}.json`));
    fs.renameSync(armFile, target);
    return target;
  } catch {
    return '';
  }
}

/** disarm 子命令：移动 arm.json，不删除计划任务。 */
export function disarm(opts) {
  const stateDir = resolveStateDir(opts);
  const armFile = path.join(stateDir, 'arm.json');
  const reason = sanitizeReason(opts.reason);
  const output = { ok: true, wasArmed: false, movedTo: '', reason, stateDir };
  if (!fs.existsSync(armFile)) {
    return { exitCode: EXIT.OK, output: { ...output, detail: '未在看护（arm.json 不存在），无需停止看护' } };
  }
  const disarmDir = path.join(stateDir, 'disarm');
  fs.mkdirSync(disarmDir, { recursive: true });
  const target = uniquePath(path.join(disarmDir, `arm-${stampName(Date.now())}-${reason}.json`));
  fs.renameSync(armFile, target);
  return { exitCode: EXIT.OK, output: { ...output, wasArmed: true, movedTo: target } };
}

function readRecovery(stateDir) {
  const logPath = path.join(stateDir, 'recovery.log');
  if (!fs.existsSync(logPath)) return { logPath, exists: false, at: '', action: '', result: '', lastLine: '' };
  let lines = [];
  try {
    lines = fs
      .readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
  } catch {
    /* 读不到按没有结论处理 */
  }
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  const at = /^\[([^\]]+)\]/.exec(lastLine)?.[1] || '';
  const result = /\bresult=([^\s]+)/.exec(lastLine)?.[1] || '';
  const action = /\baction=([^\s]+)/.exec(lastLine)?.[1] || '';
  return { logPath, exists: true, at, action, result, lastLine };
}

function readCookieGuard(stateDir, now) {
  const file = path.join(stateDir, 'cookie-guard.json');
  const raw = readJsonSafe(file);
  const value = raw.exists && raw.value && typeof raw.value === 'object' ? raw.value : {};
  const lastAttemptAtMs = parseTime(value.lastAttemptAt);
  const backoffActive = lastAttemptAtMs !== null && now - lastAttemptAtMs < COOKIE_COOLDOWN_MS;
  return {
    path: file,
    exists: raw.exists,
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : '',
    result: typeof value.result === 'string' ? value.result : '',
    detail: typeof value.detail === 'string' ? value.detail : '',
    backoffActive,
    remainingMs: backoffActive ? COOKIE_COOLDOWN_MS - (now - lastAttemptAtMs) : 0,
  };
}

/** status 子命令：严格只读。 */
export function status(opts) {
  const stateDir = resolveStateDir(opts);
  const armFile = path.join(stateDir, 'arm.json');
  const read = readJsonSafe(armFile);
  const armed = read.exists && read.value !== null && typeof read.value === 'object';
  const raw = armed ? read.value : {};
  const tag = typeof raw.tag === 'string' ? raw.tag : '';
  const armedAtMs = armed ? parseTime(raw.armedAt) : null;
  const armedAt = armedAtMs !== null ? iso(armedAtMs) : typeof raw.armedAt === 'string' ? raw.armedAt : '';
  const taskName = resolveTaskName(opts);
  const snapshots = resolveSnapshotsDir();
  const now = Date.now();
  const needsHuman = path.join(stateDir, 'needs-human.json');
  // 解析结果如实显示（不改任何文件）；node 只查存在性，不执行外部程序。
  const node = resolveNodePath(opts, { verify: false });
  const launcherPath = path.join(stateDir, LAUNCHER_FILENAME);
  const logs = resolveLogDir();
  const disk = diskFreeInfo([stateDir, logs.dir]);
  const taskExists = queryTaskExists(taskName);
  const launcherExists = fs.existsSync(launcherPath);
  // 一致性：armed 只代表 arm.json 在，不代表有人值守。两者不一致必须报出来——
  // 「看起来已在看护、实际零值守」比没看护更危险，会让人放心地不设防。
  const problems = [];
  if (armed && !taskExists) {
    problems.push(
      `已在看护但计划任务「${taskName}」不存在：看门狗不会运行，等于没看护。重跑 ownshield_arm，或先 ownshield_disarm。`,
    );
  }
  if (armed && !launcherExists) {
    problems.push(`已在看护但启动器缺失：${launcherPath}。看门狗无法被拉起，重跑 ownshield_arm。`);
  }
  return {
    exitCode: EXIT.OK,
    output: {
      ok: problems.length === 0,
      healthy: problems.length === 0,
      problems,
      armed,
      tag,
      armedAt,
      // 持有者 = 发起看护的会话。多会话同时改内核时，被挡住的一方靠它知道该等谁。
      holderSessionId: typeof raw.notifySessionId === 'string' ? raw.notifySessionId : '',
      // 「主动重启」标记：restart_now 打、看门狗在预期兑现或过期后清。留着过期标记很危险。
      expectGracefulExit: raw.expectGracefulExit === true,
      expectGracefulExitAt: typeof raw.expectGracefulExitAt === 'string' ? raw.expectGracefulExitAt : '',
      stateDir,
      armJson: armFile,
      armError: read.error,
      task: { name: taskName, exists: taskExists },
      launcher: {
        path: typeof raw.launcherPath === 'string' && raw.launcherPath ? raw.launcherPath : launcherPath,
        exists: launcherExists,
      },
      node: { ok: node.ok, path: node.path, source: node.source, error: node.error },
      exe: resolveInstalledExe(opts),
      logs,
      disk,
      snapshots: {
        dir: snapshots.dir,
        source: snapshots.source,
        legacy: snapshots.source === 'legacy',
        warning: snapshots.warning,
        // 快照库没有自动 GC：asar 每变一次就多一份 ~200 MB 的 blob。数量多了提示跑 prune。
        count: listSnapshotTags(snapshots.dir).length,
      },
      recovery: readRecovery(stateDir),
      cookieGuard: readCookieGuard(stateDir, now),
      needsHuman: { path: needsHuman, exists: fs.existsSync(needsHuman) },
    },
  };
}

function render(output) {
  const lines = [];
  if (typeof output.armedAt === 'string') {
    lines.push(`看护：${output.dryRun ? '干跑判定' : '已写入 arm.json'} · 快照 ${output.tag || '(空)'} · armedAt ${output.armedAt || '(未定)'}`);
  }
  for (const check of output.checks || []) {
    lines.push(`${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`);
  }
  if (output.task) {
    lines.push(
      `计划任务：${output.task.exists ? '存在' : '不存在'} · 本轮创建 ${output.task.created ? '是' : '否'}` +
        (output.task.skipped ? ' · --no-task 跳过' : ` · ${output.task.command}`),
    );
  }
  if (output.launcher) {
    lines.push(`启动器：${output.launcher.written ? '已生成' : '未落盘'} ${output.launcher.path}（node ${output.launcher.nodePath || '(缺)'}，来源 ${output.launcher.nodeSource || '无'}）`);
  }
  if (output.disk) {
    lines.push(
      output.disk.freeBytes === null
        ? `磁盘：剩余空间未知（${(output.disk.warnings || []).join('；') || '不可用'}）`
        : `磁盘：剩余 ${(output.disk.freeBytes / 1048576).toFixed(0)} MB（${output.disk.path}）`,
    );
  }
  if (output.logs) lines.push(`崩溃日志目录：${output.logs.dir}（来源 ${output.logs.source}）`);
  for (const problem of output.problems || []) lines.push(`! ${problem}`);
  for (const warning of output.warnings || []) lines.push(`~ ${warning}`);
  return lines;
}

function emit(json, rc) {
  if (json) {
    console.log(JSON.stringify(rc.output, null, 2));
    return;
  }
  const out = rc.output;
  if (out.checks) {
    for (const line of render(out)) console.log(line);
    if (out.dryRun) console.log('[DRY-RUN] 未写 arm.json、未建计划任务');
  } else if (out.armed !== undefined) {
    console.log(`看护：${out.armed ? `是（${out.tag}，armedAt ${out.armedAt}）` : '否'}`);
    console.log(`计划任务 ${out.task.name}：${out.task.exists ? '存在' : '不存在'}`);
    console.log(`启动器：${out.launcher.path}（${out.launcher.exists ? '存在' : '未生成'}）`);
    console.log(`node：${out.node.path || '(未探测到)'}（来源 ${out.node.source || '无'}）`);
    console.log(`DSH 可执行文件：${out.exe.path || '(未探测到)'}（来源 ${out.exe.source || '无'}）`);
    console.log(`崩溃日志目录：${out.logs.dir}（来源 ${out.logs.source}）`);
    console.log(
      out.disk.freeBytes === null
        ? `磁盘：剩余空间未知（${(out.disk.warnings || []).join('；') || '不可用'}）`
        : `磁盘：剩余 ${(out.disk.freeBytes / 1048576).toFixed(0)} MB（${out.disk.path}）`,
    );
    for (const warning of out.disk.warnings || []) console.log(`~ ${warning}`);
    console.log(`快照库：${out.snapshots.dir}（来源 ${out.snapshots.source}）`);
    if (out.snapshots.warning) console.log(out.snapshots.warning);
    console.log(
      `最近恢复：${out.recovery.exists ? `${out.recovery.result || '无结论'} · ${out.recovery.lastLine}` : '无 recovery.log'}`,
    );
    console.log(
      `cookie 守卫：${out.cookieGuard.exists ? `${out.cookieGuard.result || '未记录'} · 退避${out.cookieGuard.backoffActive ? '中' : '无'}` : '无 cookie-guard.json'}`,
    );
    if (out.needsHuman.exists) console.log('需要人工：needs-human.json 存在，先读它再决定是否重新启动看护。');
  } else {
    console.log(out.detail || (out.movedTo ? `已停止看护：${out.movedTo}` : '未在看护，无需停止看护'));
  }
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return EXIT.OK;
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    console.error(`[ownshield-arm] ${err.message}`);
    return EXIT.ERROR;
  }
  if (opts.help) {
    usage();
    return EXIT.OK;
  }
  try {
    let rc;
    if (cmd === 'arm') rc = arm(opts);
    else if (cmd === 'disarm') rc = disarm(opts);
    else if (cmd === 'status') rc = status(opts);
    else {
      console.error(`[ownshield-arm] 未知子命令: ${cmd}（arm / disarm / status）`);
      return EXIT.ERROR;
    }
    emit(opts.json, rc);
    return rc.exitCode;
  } catch (err) {
    console.error(`[ownshield-arm] 失败: ${err.stack || err.message}`);
    return EXIT.ERROR;
  }
}

const entry = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (entry) {
  process.exitCode = main();
}

export { main };
