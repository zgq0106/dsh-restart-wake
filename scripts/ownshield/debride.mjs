#!/usr/bin/env node
/**
 * ownshield 清创（debride）· 第一级 —— M3
 *
 * 目的（设计 2.2 / MVP-C）：把「整包回滚」换成「摘掉最小可归因单元」。
 * 只做第一级：错误码/错误原文直指单元 → 行级隔离 → 探针 → 病历。
 * 归因不出时不猜，返回 unknown，交上层走 L2 整包回滚。
 *
 * 三条铁律：
 *   1. 只 move 不删：被摘的 YAML 行/插件包整体移入 quarantine/<ts>/，原文件留一行注释；
 *   2. 其余字节一个不动：隔离前后分别算 sha256，并把「去掉插入注释后应与原文剩余部分逐字节相同」
 *      作为硬校验；
 *   3. 不碰真实 profile、不碰 E:\DeepSeekHarness：默认拒绝 ~/.dsh/profiles/** 的写入，
 *      要动真实 profile 必须显式 --allow-real-profile（本阶段禁止使用）。
 *
 * state 根（隔离区、病历、临时 state 的落点）：
 *   - 可配置：--state-dir 或环境变量 OWNSHIELD_STATE_DIR；
 *   - 默认：<工作区>/work/ownshield；
 *   - 输入校验：必须在允许列表内（默认仅工作区；生产可用 OWNSHIELD_STATE_ALLOW 显式加白），
 *     越界直接报错退出（exit 2），不静默写到别处。
 *   将来插件跑生产时把 OWNSHIELD_STATE_DIR 指到 ~/.dsh/ownshield，并把该路径加进
 *   OWNSHIELD_STATE_ALLOW 即可，不需要改代码。
 *
 * 用法：
 *   node debride.mjs attribute --error "<错误码或原文>" [--patch P] [--json]
 *   node debride.mjs quarantine --error "<...>" [--patch P] [--state-dir D | --root R] [--apply]
 *                             [--probe-cmd "<命令>"] [--allow-real-profile] [--json]
 *   node debride.mjs probe --id <隔离目录名> [--state-dir D | --root R] [--patch P]
 *                        (--cmd "<命令>" | --probe-json <file> | --ok | --fail --error "<原因>") [--json]
 *   node debride.mjs rollback --id <隔离目录名> [--state-dir D | --root R] [--patch P] [--force] [--json]
 *   node debride.mjs ledger [--state-dir D | --root R] [--json]
 *
 * 退出码：0 成功；1 归因未命中/探针失败/回滚失败；2 用法或安全边界错误。
 *
 * 探针说明：debride.mjs 是局外 CLI，不能自己调用 DSH 的 session_create。
 * 因此探针分两路：
 *   a. --probe-cmd：跑一条外部命令（退出码 0 = 通过），用于结构探针/自测；
 *   b. probe --ok/--fail/--probe-json：由调用方（会话内 agent 用 session_create 起临时会话）
 *      把真实探针结果回填。两路都写 <隔离目录>/probe-<ts>.json（T2 契约，watch.mjs 可读）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = fs.realpathSync(path.dirname(SELF));
/** 本模块所在工作区（tools/ownshield/ 的上两级）。state 根必须落在工作区内。 */
export const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REAL_PROFILES = path.join(os.homedir(), '.dsh', 'profiles');
/** 安装根由 asar 推导（OWNSHIELD_ASAR / OWNSHIELD_EXE 可覆盖）；语义不变：仍拒绝写安装目录。 */
const DEFAULT_EXE = 'E:\\DeepSeekHarness\\DeepSeek Harness.exe';
function resolveInstallRoot() {
  const asarOverride = String(process.env.OWNSHIELD_ASAR || '').trim();
  const asar = asarOverride
    ? path.resolve(asarOverride)
    : path.join(
        path.dirname(String(process.env.OWNSHIELD_EXE || DEFAULT_EXE).trim() || DEFAULT_EXE),
        'resources',
        'app.asar',
      );
  return path.dirname(path.dirname(asar));
}
const FORBIDDEN_ROOTS = [resolveInstallRoot()];

/** state 允许列表：默认只允许工作区；生产装成插件后可用 OWNSHIELD_STATE_ALLOW 显式加白。 */
export const ALLOWED_STATE_ROOTS = [WORKSPACE_ROOT];

/** 默认 state 根：工作区内，不越出 workspace（本阶段硬规矩）。 */
export const DEFAULT_STATE_DIR = path.join(WORKSPACE_ROOT, 'work', 'ownshield');
export const DEFAULT_QUARANTINE_ROOT = path.join(DEFAULT_STATE_DIR, 'quarantine');
/** profile 名可配：DSH_PROFILE（与 authprobe / snapshot / secure 同一规则），默认 desktop。 */
export const DEFAULT_PROFILE_NAME = String(process.env.DSH_PROFILE || '').trim() || 'desktop';
export const DEFAULT_PATCH = path.join(REAL_PROFILES, DEFAULT_PROFILE_NAME, 'cordis.patch.yml');

function normalizeDir(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '');
}

/** 当前允许的 state 根：工作区 + OWNSHIELD_STATE_ALLOW（分号分隔，显式加白）。 */
export function stateAllowList() {
  const extra = String(process.env.OWNSHIELD_STATE_ALLOW || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeDir);
  return [...ALLOWED_STATE_ROOTS.map(normalizeDir), ...extra];
}

/**
 * state 根输入校验：必须在允许列表内（默认仅工作区），否则直接报错，不静默越界。
 * 安装目录、真实 profile 永远拒绝。
 */
export function assertStateRoot(dir) {
  if (!dir) throw new Error('[ownshield] state 根为空');
  const abs = normalizeDir(dir);
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (abs.toLowerCase() === forbidden.toLowerCase() || abs.toLowerCase().startsWith(forbidden.toLowerCase() + path.sep)) {
      throw new Error(`[ownshield] state 根落在安装目录: ${abs}（禁区：不改 ${FORBIDDEN_ROOTS[0]}）`);
    }
  }
  if (abs.toLowerCase() === REAL_PROFILES.toLowerCase() || abs.toLowerCase().startsWith(REAL_PROFILES.toLowerCase() + path.sep)) {
    throw new Error(`[ownshield] state 根落在真实 profile 下: ${abs}（本阶段不许写 ~/.dsh）`);
  }
  const allow = stateAllowList();
  const inside = allow.some((a) => abs.toLowerCase() === a.toLowerCase() || abs.toLowerCase().startsWith(a.toLowerCase() + path.sep));
  if (!inside) {
    throw new Error(
      `[ownshield] state 根越界: ${abs}；只允许 ${allow.join(' 或 ')} 之内（工作区路径）。` +
        `确需别处请设 OWNSHIELD_STATE_ALLOW 显式加白，不要默默越界。`,
    );
  }
  return abs;
}

/** 解析 state 根：显式参数 > OWNSHIELD_STATE_DIR > 工作区默认；始终过白名单。 */
export function resolveStateDir({ stateDir } = {}) {
  return assertStateRoot(stateDir || process.env.OWNSHIELD_STATE_DIR || DEFAULT_STATE_DIR);
}

/** 解析隔离区根：显式 root 优先，否则 <state>/quarantine；始终过白名单。 */
export function resolveQuarantineRoot({ root, stateDir } = {}) {
  if (root) return assertStateRoot(root);
  return path.join(resolveStateDir({ stateDir }), 'quarantine');
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 时间戳：ISO 到毫秒，隔离目录名把 : 与 . 换成 -，避免 Windows 路径问题。 */
export function nowTs(date = new Date()) {
  return date.toISOString();
}

export function dirNameOf(ts) {
  return ts.replace(/[:.]/g, '-');
}

/**
 * 按 \n 切行，保留每行起始偏移与行尾（\n 或 \r\n）。
 * 空文件返回空数组；以 \n 结尾的文件不会产生结尾空行。
 */
export function splitLines(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      out.push({ no: out.length + 1, start, end: text.length, text: text.slice(start), eol: '' });
      break;
    }
    const crlf = nl > start && text[nl - 1] === '\r';
    const bodyEnd = crlf ? nl - 1 : nl;
    out.push({
      no: out.length + 1,
      start,
      end: bodyEnd,
      text: text.slice(start, bodyEnd),
      eol: crlf ? '\r\n' : '\n',
    });
    start = nl + 1;
  }
  return out;
}

function indentOf(line) {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

function isBlank(line) {
  return line.trim() === '';
}

function isComment(line) {
  return line.trimStart().startsWith('#');
}

function isDeeper(line, indent) {
  return !isBlank(line) && !isComment(line) && indentOf(line) > indent;
}

/**
 * 给定一行在「块起始」位置（如 `- id: x` / `- identifier: g`），算这个块的结束行。
 * 规则：块内所有缩进更深的行（含更深缩进的注释）都属于它；遇到缩进 <= 起始缩进的
 * 非空行即结束。空行不算块内容（不把条目间的空行卷进来），但也不会提前终止块。
 */
export function blockRange(lines, startIdx) {
  const indent = indentOf(lines[startIdx].text);
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].text;
    if (isBlank(line)) continue;
    if (indentOf(line) <= indent) break;
    endIdx = i;
  }
  return { startLine: startIdx + 1, endLine: endIdx + 1 };
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── 安全边界 ────────────────────────────────────────────────────────────────

export function assertSafePatch(patchPath, { allowRealProfile = false } = {}) {
  const abs = path.resolve(patchPath);
  for (const root of FORBIDDEN_ROOTS) {
    if (abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      throw new Error(`拒绝写安装目录内的文件: ${abs}（禁区：不改 ${FORBIDDEN_ROOTS[0]}）`);
    }
  }
  if (!allowRealProfile && abs.toLowerCase().startsWith(REAL_PROFILES.toLowerCase() + path.sep)) {
    throw new Error(
      `拒绝写真实 profile: ${abs}（本阶段只在 tmp/ 副本上演练；确需动请显式 --allow-real-profile）`,
    );
  }
  if (!fileExists(abs)) throw new Error(`patch 文件不存在: ${abs}`);
  return abs;
}

// ── 归因 ────────────────────────────────────────────────────────────────────

const ERRCODE_RE = /\b(agent-preset\/[a-z][a-z-]*|plugin\/[A-Za-z0-9._@/-]+|session\/[a-z][a-z-]*|llm\/[a-z][a-z-]*)\b/;
const DUP_GROUP_RE = /Duplicate tool group(?: identifier)?[:\s]+['"`]?([A-Za-z0-9_.@/-]+)/i;

/** 从错误原文里挖出错码：plugin/<name>/... 只留 plugin/<name>。 */
export function extractErrcode(text) {
  const m = ERRCODE_RE.exec(text || '');
  if (!m) return '';
  const raw = m[1];
  if (raw.startsWith('plugin/')) {
    const name = pluginNameFromErrcode(raw);
    return name ? `plugin/${name}` : raw;
  }
  return raw;
}

/** plugin/@scope/name/op → @scope/name；plugin/name/op → name。 */
export function pluginNameFromErrcode(raw) {
  const rest = raw.replace(/^plugin\//, '').replace(/[.,;:)\]]+$/, '');
  const parts = rest.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/** 所有 `- identifier: xxx` 行（工具组标识）。 */
export function findGroupIdentifiers(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*identifier:\s*['"]?([A-Za-z0-9_.@-]+)['"]?\s*$/.exec(lines[i].text);
    if (m) hits.push({ id: m[2], index: i, indent: m[1].length, line: i + 1 });
  }
  return hits;
}

/** 所有 `- id: xxx` 行（loader patch 条目 / 预设插件行）。 */
export function findEntryIds(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*id:\s*['"]?([A-Za-z0-9_.@/-]+)['"]?\s*$/.exec(lines[i].text);
    if (m) hits.push({ id: m[2], index: i, indent: m[1].length, line: i + 1 });
  }
  return hits;
}

/** 所有 `name: xxx` 行，用于按包名找条目。 */
export function findNameValues(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)name:\s*['"]?([A-Za-z0-9_.@/-]+)['"]?\s*$/.exec(lines[i].text);
    if (m) hits.push({ value: m[2], index: i, indent: m[1].length, line: i + 1 });
  }
  return hits;
}

/** 找某个 index 行所属的条目（同缩进且是 `- id:` 的块起点，或更浅的最后一条）。 */
function owningEntry(lines, index) {
  const target = indentOf(lines[index].text);
  for (let i = index; i >= 0; i--) {
    const m = /^(\s*)-\s*(?:id|insert):/.exec(lines[i].text);
    if (!m) continue;
    const ind = m[1].length;
    if (ind <= target) return i;
  }
  return -1;
}

function unitForEntry(lines, index, label) {
  const range = blockRange(lines, index);
  const id = findEntryIds(lines).find((e) => e.index === index);
  return {
    ok: true,
    hit: true,
    kind: 'patch-entry',
    unit: `patch:${id ? `entry[${id.id}]` : label}`,
    action: 'quarantine-lines',
    confidence: 'high',
    lines: range,
    lineNumbers: [range.startLine, range.endLine],
    detail: `条目 ${lines[index].text.trim()} → 第 ${range.startLine}–${range.endLine} 行`,
  };
}

/**
 * 归因主函数。
 * @returns {{
 *   ok: boolean, hit: boolean, kind: string, unit: string, errcode: string,
 *   action: 'quarantine-lines'|'quarantine-package'|'l2-rollback',
 *   confidence: string, lines?: {startLine:number,endLine:number},
 *   lineNumbers?: number[], detail: string, candidates?: object[],
 *   plugin?: {name:string, dir:string|null}, reason?: string
 * }}
 */
export function attribute(errorText, { patchPath = DEFAULT_PATCH } = {}) {
  const text = String(errorText ?? '').trim();
  if (!text) {
    return { ok: false, hit: false, kind: 'unknown', unit: 'unknown', errcode: '', action: 'l2-rollback', confidence: 'none', detail: '错误原文为空' };
  }
  const errcode = extractErrcode(text);
  const lines = splitLines(fs.readFileSync(patchPath, 'utf8'));
  return attributeAgainst(text, errcode, lines, patchPath);
}

/** 归因的可测试内核：不读文件，直接喂已切好的行。 */
export function attributeAgainst(text, errcode, lines, patchPath = '') {
  // ① Duplicate tool group（agent-preset/invalid 的 reason 里也会带）
  const dup = DUP_GROUP_RE.exec(text);
  if (dup) {
    const id = dup[1];
    const hits = findGroupIdentifiers(lines).filter((h) => h.id === id);
    if (hits.length >= 2) {
      const removable = hits.slice(1); // 留第一处，摘后面的重复注册
      const ranges = removable.map((h) => blockRange(lines, h.index));
      return {
        ok: true,
        hit: true,
        kind: 'tool-group-duplicate',
        unit: `patch:tool-group[${id}]#dup`,
        errcode: errcode || 'Duplicate tool group',
        action: 'quarantine-lines',
        confidence: 'high',
        removables: removable.map((h, i) => ({
          id,
          occurrence: i + 2,
          blockIndex: h.index,
          lines: ranges[i],
        })),
        lines: ranges[0],
        lineNumbers: ranges.flatMap((r) => [r.startLine, r.endLine]),
        candidates: hits.map((h) => ({ id: h.id, line: h.line })),
        detail:
          `工具组标识 ${id} 出现 ${hits.length} 次（第 ${hits.map((h) => h.line).join('、')} 行）；` +
          `留第一处，摘第 ${ranges.map((r) => `${r.startLine}–${r.endLine}`).join('、')} 行`,
      };
    }
    // 只在 patch 里出现一次 → 另一处来自 bundle 层，第一级归因不了
    return {
      ok: true,
      hit: false,
      kind: 'tool-group-duplicate',
      unit: `patch:tool-group[${id}]`,
      errcode: errcode || 'Duplicate tool group',
      action: 'l2-rollback',
      confidence: 'low',
      candidates: hits.map((h) => ({ id: h.id, line: h.line })),
      detail: `工具组标识 ${id} 在 patch 里只出现 ${hits.length} 次，重复的另一侧在 bundle 层，第一级归因不出 → L2`,
    };
  }

  // ② plugin/<name>/... → 归因到插件条目或插件包
  if (/^plugin\//.test(errcode)) {
    const name = pluginNameFromErrcode(errcode);
    return attributePlugin(name, errcode, lines, patchPath);
  }

  // ③ agent-preset/invalid：reason 里常带 `- identifier: x` / `$.field missing` / preset id
  if (errcode === 'agent-preset/invalid' || /agent-preset\/invalid/.test(text)) {
    const ident = /-\s*identifier:\s*['"]?([A-Za-z0-9_.@-]+)['"]?/.exec(text);
    if (ident) {
      const hits = findGroupIdentifiers(lines);
      const match = hits.filter((h) => h.id === ident[1]);
      if (match.length) {
        const r = blockRange(lines, match[0].index);
        return {
          ok: true,
          hit: true,
          kind: 'tool-group',
          unit: `patch:tool-group[${ident[1]}]`,
          errcode,
          action: 'quarantine-lines',
          confidence: 'high',
          lines: r,
          lineNumbers: [r.startLine, r.endLine],
          detail: `reason 指向工具组标识 ${ident[1]} → 第 ${r.startLine}–${r.endLine} 行`,
        };
      }
    }
    const field = /\$\.([A-Za-z0-9_]+)/.exec(text);
    const presetId = /preset\s+['"`]?([A-Za-z0-9_.@-]+)['"`]/i.exec(text) || /preset:\s*['"]?([A-Za-z0-9_.@-]+)/.exec(text);
    if (field) {
      const row = findRowForField(lines, field[1]);
      if (row) {
        const r = blockRange(lines, row.index);
        return {
          ok: true,
          hit: true,
          kind: 'patch-entry',
          unit: `patch:entry[${row.id || field[1]}]`,
          errcode,
          action: 'quarantine-lines',
          confidence: 'medium',
          lines: r,
          lineNumbers: [r.startLine, r.endLine],
          detail: `reason 指向字段 $.${field[1]}，所在行 ${row.line}（第 ${r.startLine}–${r.endLine} 行）`,
        };
      }
    }
    if (presetId) {
      const preset = findPreset(lines, presetId[1]);
      if (preset) {
        const r = blockRange(lines, preset.entryIndex);
        return {
          ok: true,
          hit: true,
          kind: 'preset',
          unit: `patch:preset[${presetId[1]}]`,
          errcode,
          action: 'quarantine-lines',
          confidence: 'medium',
          lines: r,
          lineNumbers: [r.startLine, r.endLine],
          detail: `reason 指向预设 ${presetId[1]} → 第 ${r.startLine}–${r.endLine} 行`,
        };
      }
    }
    return {
      ok: true,
      hit: false,
      kind: 'preset',
      unit: 'unknown',
      errcode,
      action: 'l2-rollback',
      confidence: 'low',
      detail: `agent-preset/invalid 但 reason 里没有可定位到 patch 行的标识符 → L2（原文尾部：${text.slice(-160)}）`,
    };
  }

  // ④ 其他错误码：先当插件名试一次，再认输
  if (errcode) {
    const name = errcode.replace(/^plugin\//, '');
    const hit = attributePlugin(name, `plugin/${name}`, lines, patchPath);
    if (hit.hit) return hit;
  }

  return {
    ok: true,
    hit: false,
    kind: 'unknown',
    unit: 'unknown',
    errcode,
    action: 'l2-rollback',
    confidence: 'none',
    detail: `归因不出最小单元（错误码「${errcode || '无'}」）→ 交上层 L2 整包回滚`,
  };
}

function attributePlugin(name, errcode, lines, patchPath) {
  // 先在 patch 里找 id == 插件名 或 name == 包名 的条目
  const entries = findEntryIds(lines);
  const byId = entries.find((e) => e.id === name);
  const names = findNameValues(lines);
  const byName = names.find((n) => n.value === name || n.value.endsWith('/' + name));
  const target = byId || (byName ? { ...byName, index: owningEntry(lines, byName.index) } : null);
  if (target && target.index >= 0) {
    const r = blockRange(lines, target.index);
    return {
      ok: true,
      hit: true,
      kind: 'patch-entry',
      unit: `patch:entry[${name}]`,
      errcode,
      action: 'quarantine-lines',
      confidence: 'high',
      lines: r,
      lineNumbers: [r.startLine, r.endLine],
      detail: `插件 ${name} 在 patch 第 ${r.startLine}–${r.endLine} 行`,
    };
  }
  // 不在 patch → 看是不是装在本机 node_modules 的独立插件包
  const pkg = resolvePackage(name, patchPath);
  if (pkg) {
    return {
      ok: true,
      hit: true,
      kind: 'plugin-package',
      unit: `plugin:${name}`,
      errcode,
      action: 'quarantine-package',
      confidence: 'medium',
      plugin: { name, dir: pkg.dir, source: pkg.source },
      detail: `插件 ${name} 未在 patch 中单列，归因到插件包 ${pkg.dir}`,
    };
  }
  return {
    ok: true,
    hit: false,
    kind: 'plugin-package',
    unit: `plugin:${name}`,
    errcode,
    action: 'l2-rollback',
    confidence: 'low',
    detail: `插件 ${name} 既不在 patch 里、也在本机找不到安装目录 → L2`,
  };
}

/** 在 patch 所在的 profile 目录里找插件包（package.json 依赖 + node_modules 实体）。 */
export function resolvePackage(name, patchPath) {
  const dir = path.dirname(path.resolve(patchPath));
  const pkgJson = path.join(dir, 'package.json');
  let declared = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [key, value] of Object.entries(deps)) {
      const bare = key.replace(/^@local\//, '').replace(/^@deepseek-ai\//, '');
      if (key === name || bare === name) declared = { key, value, pkgJson };
    }
  } catch {
    /* 没有 package.json 就算了 */
  }
  if (declared) {
    const spec = String(declared.value || '');
    const link = /^link:(.+)$/.exec(spec);
    if (link) {
      const linked = path.resolve(dir, link[1]);
      if (fs.existsSync(linked)) return { dir: linked, source: 'package.json:link' };
    }
  }
  const candidates = [path.join(dir, 'node_modules', ...name.split('/'))];
  if (declared && declared.value) {
    const p = String(declared.value);
    if (!/^(link:|file:|workspace:|npm:|git)/.test(p)) candidates.push(path.join(dir, 'node_modules', ...p.split('/')));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return { dir: c, source: 'node_modules' };
  }
  return null;
}

/** `$.field` 类 reason：找该字段所在行所属的条目。 */
export function findRowForField(lines, field) {
  const re = new RegExp(`^\\s*${field}\\s*:`);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!re.test(lines[i].text)) continue;
    const owner = owningEntry(lines, i);
    if (owner < 0) continue;
    const ids = findEntryIds(lines);
    const idHit = ids.find((e) => e.index === owner);
    return { index: owner, id: idHit ? idHit.id : '', line: i + 1 };
  }
  return null;
}

/** 按预设 id 找：预设条目 config.id == id（如 preset-router-standard → router-standard）。 */
export function findPreset(lines, presetId) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*id:\s*['"]?([A-Za-z0-9_.@-]+)['"]?\s*$/.exec(lines[i].text);
    if (!m || m[1] !== presetId) continue;
    const entry = owningEntry(lines, i);
    if (entry >= 0) return { entryIndex: entry, idLine: i + 1 };
  }
  return null;
}

// ── 隔离：行移动 ────────────────────────────────────────────────────────────

function unitLinesText(lines, range) {
  const start = lines[range.startLine - 1].start;
  const last = lines[range.endLine - 1];
  const end = last.eol ? last.end + last.eol.length : last.end;
  const text = lines
    .slice(range.startLine - 1, range.endLine)
    .map((l) => l.text + l.eol)
    .join('');
  return { text, start, end };
}

/**
 * 行级隔离。dryRun=true 时只算不写。
 * @returns {{ok, dryRun, quarantineId, dir, comment, movedLines, beforeSha256, afterSha256, restSha256, patchPath}}
 */
export function quarantineLines({ patchPath, attribution: attr, root = resolveQuarantineRoot(), ts = nowTs(), dryRun = false, allowRealProfile = false }) {
  const qroot = assertStateRoot(root); // 先校验 state 根，越界立刻报错
  const abs = assertSafePatch(patchPath, { allowRealProfile });
  const text = fs.readFileSync(abs, 'utf8');
  if (!attr || !attr.lines) throw new Error('归因结果缺少 lines 范围，无法隔离');
  const lines = splitLines(text);
  const { startLine, endLine } = attr.lines;
  if (startLine < 1 || endLine > lines.length || endLine < startLine) {
    throw new Error(`行范围越界: ${startLine}–${endLine}（文件共 ${lines.length} 行）`);
  }
  const moved = unitLinesText(lines, attr.lines);
  // 同一毫秒内连续隔离两个单元时，纯时间戳目录名会相撞并覆盖前一次的证据。
  // 冲突就加序号后缀，保证每一轮隔离都留下独立的 before/after/unit 留档。
  let dir = dirNameOf(ts);
  for (let n = 2; fs.existsSync(path.join(qroot, dir)); n += 1) dir = `${dirNameOf(ts)}-${n}`;
  const comment = `# quarantined by ownshield ${ts} -> quarantine/${dir}`;
  const eol = lines[startLine - 1].eol || '\n';
  const head = text.slice(0, moved.start);
  const tail = text.slice(moved.end);
  const rest = head + tail;
  const newText = head + comment + eol + tail;
  const beforeSha256 = sha256(text);
  const afterSha256 = sha256(newText);
  const restSha256 = sha256(rest);

  // 硬校验：把插入的注释行剪掉，必须逐字节等于 rest
  const probe = splitLines(newText);
  const insertedLine = probe[startLine - 1];
  const restored = newText.slice(0, insertedLine.start) + newText.slice(insertedLine.end + insertedLine.eol.length);
  if (restored !== rest) throw new Error('内部校验失败：隔离后除注释行外内容发生了变化');

  const result = {
    ok: true,
    dryRun,
    patchPath: abs,
    quarantineId: dir,
    dir: path.join(qroot, dir),
    comment,
    eol: eol === '\r\n' ? 'CRLF' : 'LF',
    movedLines: moved.text,
    beforeSha256,
    afterSha256,
    restSha256,
    attr,
    ts,
  };
  if (dryRun) return result;

  const qdir = result.dir;
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, 'before.patch.yml'), text, 'utf8');
  fs.writeFileSync(path.join(qdir, 'unit.yml'), moved.text, 'utf8');
  fs.writeFileSync(path.join(qdir, 'after.patch.yml'), newText, 'utf8');
  const meta = {
    schema: 'ownshield/debride/v1',
    quarantineId: dir,
    ts,
    errcode: attr.errcode || '',
    kind: attr.kind || '',
    unit: attr.unit || '',
    detail: attr.detail || '',
    patchPath: abs,
    lines: { startLine, endLine },
    comment,
    beforeSha256,
    afterSha256,
    restSha256,
    movedBytes: Buffer.byteLength(moved.text, 'utf8'),
    firstSeen: ts,
    recurCount: 1,
    probe: null,
    recovered: false,
  };
  fs.writeFileSync(path.join(qdir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  atomicWrite(abs, newText);
  return result;
}

/** 插件包隔离：整个目录 rename 到 quarantine/<ts>/package/ 下（跨卷失败就报错，绝不复制后删）。 */
export function quarantinePackage({ dir, name, root = resolveQuarantineRoot(), ts = nowTs(), dryRun = false }) {
  const qroot = assertStateRoot(root); // state 根先过白名单
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`插件目录不存在: ${abs}`);
  const lower = abs.toLowerCase();
  for (const rootDir of FORBIDDEN_ROOTS) {
    if (lower.startsWith(rootDir.toLowerCase() + path.sep)) throw new Error(`拒绝移动安装目录内的包: ${abs}`);
  }
  const qid = dirNameOf(ts);
  const targetBase = path.join(qroot, qid, 'package');
  const target = path.join(targetBase, name.replace(/^@/, '').replace(/[/\\]/g, '__'));
  const digest = dirDigest(abs);
  const result = { ok: true, dryRun, quarantineId: qid, from: abs, to: target, digest, targetName: name };
  if (dryRun) return result;
  fs.mkdirSync(targetBase, { recursive: true });
  try {
    fs.renameSync(abs, target);
  } catch (err) {
    throw new Error(`插件包移动失败（不复制不删除）: ${err.message}`);
  }
  const meta = {
    schema: 'ownshield/debride/v1',
    quarantineId: qid,
    ts,
    kind: 'plugin-package',
    unit: `plugin:${name}`,
    from: abs,
    to: target,
    digest,
    beforeSha256: digest.sha256,
    afterSha256: null,
    restSha256: null,
    firstSeen: ts,
    recurCount: 1,
    probe: null,
    recovered: false,
  };
  fs.writeFileSync(path.join(qroot, qid, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return result;
}

/** 目录指纹：relpath + sha256 排序后整体 sha256；文件过多时退化为 size 指纹并标注。 */
export function dirDigest(dir, { maxFiles = 2000 } = {}) {
  const files = [];
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  };
  walk(dir);
  files.sort();
  const len = files.length;
  const rows = [];
  let total = 0;
  for (const f of files) {
    const size = fs.statSync(f).size;
    total += size;
    const rel = path.relative(dir, f).replace(/\\/g, '/');
    if (len <= maxFiles) rows.push(`${rel}\0${sha256(fs.readFileSync(f))}`);
    else rows.push(`${rel}\0${size}`);
  }
  return {
    files: len,
    bytes: total,
    hashMode: len <= maxFiles ? 'sha256' : 'size-only',
    sha256: sha256(rows.join('\n')),
  };
}

function atomicWrite(file, text) {
  const tmp = file + '.ownshield.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ── 回滚（把行移回） ────────────────────────────────────────────────────────

export function rollback({ quarantineId, root = resolveQuarantineRoot(), patchPath = '', force = false, ts = nowTs() }) {
  const qroot = assertStateRoot(root);
  const qdir = path.join(qroot, quarantineId);
  const metaPath = path.join(qdir, 'meta.json');
  if (!fileExists(metaPath)) throw new Error(`找不到隔离记录: ${metaPath}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const before = fs.readFileSync(path.join(qdir, 'before.patch.yml'), 'utf8');
  const unit = fs.readFileSync(path.join(qdir, 'unit.yml'), 'utf8');
  const target = path.resolve(patchPath || meta.patchPath);
  if (!fileExists(target)) throw new Error(`目标 patch 不存在: ${target}`);
  const current = fs.readFileSync(target, 'utf8');
  const currentSha = sha256(current);

  // 当前文件必须还是隔离后的那个（或至少含那行注释）
  if (currentSha !== meta.afterSha256 && !force) {
    throw new Error(
      `目标 patch 在隔离后又被改过（当前 ${currentSha.slice(0, 12)}… ≠ 隔离时 ${String(meta.afterSha256).slice(0, 12)}…）；` +
        `拒绝覆盖，确认后用 --force`,
    );
  }
  const commentLine = meta.comment;
  const idx = current.indexOf(commentLine);
  if (idx < 0) throw new Error(`目标 patch 里找不到隔离注释行（${commentLine}）；拒绝回滚`);
  const lineStart = current.lastIndexOf('\n', idx - 1) + 1;
  const lineEndNl = current.indexOf('\n', idx);
  if (lineStart !== idx) throw new Error('隔离注释行不在行首，拒绝回滚');

  const head = current.slice(0, lineStart);
  const tail = lineEndNl === -1 ? '' : current.slice(lineEndNl + 1);
  const restored = head + unit + tail;
  const restoredSha = sha256(restored);
  if (!force && restoredSha !== meta.beforeSha256) {
    throw new Error(`回滚结果 sha256 与隔离前不一致（${restoredSha.slice(0, 12)}… ≠ ${meta.beforeSha256.slice(0, 12)}…），拒绝写入`);
  }
  atomicWrite(target, restored);

  // 记一条回滚记录到 meta
  meta.rolledBackAt = ts;
  meta.redo = { sha256: currentSha };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { ok: true, patchPath: target, beforeSha256: meta.beforeSha256, restoredSha256: restoredSha, quarantineId, ts };
}

// ── 病历（ledger.jsonl） ────────────────────────────────────────────────────

export function ledgerFile(root = resolveQuarantineRoot()) {
  return path.join(assertStateRoot(root), 'ledger.jsonl');
}

export function appendLedger(root, record) {
  const qroot = assertStateRoot(root);
  fs.mkdirSync(qroot, { recursive: true });
  fs.appendFileSync(ledgerFile(qroot), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

export function readLedger(root = resolveQuarantineRoot()) {
  const file = ledgerFile(root);
  if (!fileExists(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* 坏行跳过，不影响其余病历 */
    }
  }
  return out;
}

/** 只数「隔离」事件：recovered / rolled-back 是同一事件的后续状态，不再算复发。 */
export function quarantineEvents(records) {
  return (records || []).filter((r) => r && r.quarantinedAt && r.event !== 'recovered' && r.event !== 'rolled-back');
}

/**
 * 归并病历：每一轮隔离（quarantineId）一行；recurCount 是该 unit 的第几次隔离，
 * firstSeen 是该 unit 首次被隔离的时刻。recovered / rolledBack 取该轮最新状态。
 * 返回按 quarantinedAt 倒序的记录数组。
 */
export function foldLedger(records) {
  const groups = new Map();
  const order = [];
  for (const r of records) {
    if (!r || !r.unit) continue;
    const key = r.quarantineId || r.unit;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(r);
  }
  const unitSeq = new Map();
  for (const r of quarantineEvents(records)) {
    if (!unitSeq.has(r.unit)) unitSeq.set(r.unit, []);
    unitSeq.get(r.unit).push(r);
  }
  const rows = [];
  for (const key of order) {
    const list = groups.get(key);
    const qEvent = quarantineEvents(list)[0] || list[0];
    const latest = list[list.length - 1];
    const seq = unitSeq.get(latest.unit) || [];
    const idx = qEvent ? seq.indexOf(qEvent) : -1;
    rows.push({
      unit: latest.unit,
      errcode: latest.errcode || qEvent?.errcode || '',
      firstSeen: seq.length ? seq[0].firstSeen || seq[0].quarantinedAt : latest.firstSeen || latest.quarantinedAt,
      recurCount: idx >= 0 ? idx + 1 : seq.length || latest.recurCount || 1,
      quarantinedAt: qEvent?.quarantinedAt || latest.quarantinedAt || '',
      recovered: latest.recovered === true,
      quarantineId: key,
      rolledBack: list.some((r) => r.rolledBack === true),
      events: list.length,
    });
  }
  rows.sort((a, b) => String(b.quarantinedAt).localeCompare(String(a.quarantinedAt)));
  return rows;
}

/** 隔离时写病历：firstSeen/recurCount 从既有病历累计。 */
export function recordQuarantine(root, { unit, errcode, quarantineId, ts = nowTs(), patchPath = '', lines = null, action = 'quarantine-lines', detail = '' }) {
  const prev = quarantineEvents(readLedger(root).filter((r) => r.unit === unit));
  const firstSeen = prev.length ? prev[0].firstSeen || prev[0].quarantinedAt : ts;
  return appendLedger(root, {
    unit,
    errcode: errcode || '',
    firstSeen,
    recurCount: prev.length + 1,
    quarantinedAt: ts,
    recovered: false,
    quarantineId,
    patchPath,
    lines,
    action,
    detail,
    event: 'quarantine',
  });
}

/** 探针通过：追加 recovered=true 的记录（append-only，不回头改旧行）。 */
export function recordRecovered(root, { unit, errcode, quarantineId, ts = nowTs(), probe = null, detail = '' }) {
  const prev = quarantineEvents(readLedger(root).filter((r) => r.unit === unit));
  const firstSeen = prev.length ? prev[0].firstSeen || prev[0].quarantinedAt : ts;
  return appendLedger(root, {
    unit,
    errcode: errcode || '',
    firstSeen,
    recurCount: prev.length || 1,
    quarantinedAt: prev.length ? prev[prev.length - 1].quarantinedAt : ts,
    recovered: true,
    quarantineId,
    probe,
    detail,
    event: 'recovered',
  });
}

/** 探针失败 → 行移回：追加 rolledBack 记录。 */
export function recordRolledBack(root, { unit, errcode, quarantineId, ts = nowTs(), err }) {
  const prev = quarantineEvents(readLedger(root).filter((r) => r.unit === unit));
  const firstSeen = prev.length ? prev[0].firstSeen || prev[0].quarantinedAt : ts;
  return appendLedger(root, {
    unit,
    errcode: errcode || '',
    firstSeen,
    recurCount: prev.length || 1,
    quarantinedAt: prev.length ? prev[prev.length - 1].quarantinedAt : ts,
    recovered: false,
    rolledBack: true,
    quarantineId,
    error: String(err || ''),
    event: 'rolled-back',
  });
}

// ── 探针 ────────────────────────────────────────────────────────────────────

/**
 * 跑一条外部探针命令（退出码 0 = 通过）。stdio 用 ignore：沙箱下管道会 EPERM。
 * 本机可能只有 Windows PowerShell 5.1（没有 pwsh），所以按 pwsh → powershell.exe → cmd
 * 顺序探一个可用 shell 并缓存；也可用 OWNSHIELD_PROBE_SHELL 指定。
 */
let PROBE_SHELL = null;

export function resolveProbeShell() {
  if (PROBE_SHELL) return PROBE_SHELL;
  const candidates = [];
  if (process.env.OWNSHIELD_PROBE_SHELL) candidates.push({ kind: 'ps', file: process.env.OWNSHIELD_PROBE_SHELL });
  candidates.push({ kind: 'ps', file: 'pwsh' });
  candidates.push({ kind: 'ps', file: 'powershell.exe' });
  candidates.push({ kind: 'cmd', file: process.env.ComSpec || 'C:\\Windows\\system32\\cmd.exe' });
  for (const c of candidates) {
    const args = c.kind === 'cmd' ? ['/d', '/s', '/c', 'exit 0'] : ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'];
    const probe = spawnSync(c.file, args, { stdio: 'ignore', timeout: 15000, windowsHide: true });
    if (!probe.error) {
      PROBE_SHELL = c;
      return c;
    }
  }
  PROBE_SHELL = { kind: 'cmd', file: process.env.ComSpec || 'cmd.exe' };
  return PROBE_SHELL;
}

export function runProbeCommand(cmd, { timeoutMs = 120000, cwd = process.cwd() } = {}) {
  const started = Date.now();
  const shell = resolveProbeShell();
  const args = shell.kind === 'cmd' ? ['/d', '/s', '/c', cmd] : ['-NoProfile', '-NonInteractive', '-Command', cmd];
  const res = spawnSync(shell.file, args, {
    stdio: 'ignore',
    timeout: timeoutMs,
    cwd,
    windowsHide: true,
  });
  return {
    ok: !res.error && res.status === 0,
    exitCode: res.status,
    error: res.error ? String(res.error.message || res.error) : '',
    durationMs: Date.now() - started,
    command: cmd,
    shell: shell.file,
  };
}

/** probe-<ts>.json：与 T2 契约 { ok, ts, checks, durationMs } 对齐，watch.mjs 认得。 */
export function writeProbeResult(qdir, { ok, checks = [], durationMs = 0, ts = nowTs(), source = 'debride' }) {
  const file = path.join(qdir, `probe-${ts.replace(/[:.]/g, '-')}.json`);
  const body = { ok, ts, checks, durationMs, source };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return { file, body };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--ok') args.ok = true;
    else if (a === '--fail') args.ok = false;
    else if (a === '--force') args.force = true;
    else if (a === '--allow-real-profile') args.allowRealProfile = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--error') args.error = argv[++i];
    else if (a === '--patch') args.patch = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--probe-cmd') args.probeCmd = argv[++i];
    else if (a === '--probe-json') args.probeJson = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--cmd') args.cmd = argv[++i];
    else if (a.startsWith('-')) throw new Error(`未知选项: ${a}`);
    else args._.push(a);
  }
  return args;
}

function usage() {
  return [
    'ownshield 清创（debride）第一级',
    '',
    '用法：',
    '  node debride.mjs attribute --error "<错误码或原文>" [--patch P] [--json]',
    '  node debride.mjs quarantine --error "<...>" [--patch P] [--state-dir D | --root R] [--apply] [--probe-cmd CMD] [--json]',
    '  node debride.mjs probe --id <隔离目录> [--state-dir D | --root R] (--cmd CMD | --probe-json FILE | --ok | --fail) [--error E] [--json]',
    '  node debride.mjs rollback --id <隔离目录> [--state-dir D | --root R] [--patch P] [--force] [--json]',
    '  node debride.mjs ledger [--state-dir D | --root R] [--json]',
    '',
    `state 根：--state-dir 或环境变量 OWNSHIELD_STATE_DIR，默认 ${DEFAULT_STATE_DIR}（工作区内）。`,
    `隔离区根：--root，默认 <state>/quarantine = ${DEFAULT_QUARANTINE_ROOT}。`,
    `安全：state 根必须落在允许列表内（默认 ${WORKSPACE_ROOT}），越界直接报错退出；`,
    '      真实 profile 与 DSH 安装目录（由 app.asar 推导，OWNSHIELD_ASAR / OWNSHIELD_EXE 可覆盖）永远拒绝写入。' +
        `默认 patch = ~/.dsh/profiles/${DEFAULT_PROFILE_NAME}/cordis.patch.yml。`,
  ].join('\n');
}

function print(obj, json) {
  if (json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    return;
  }
  const lines = [];
  const walk = (v, prefix = '') => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
          lines.push(`${prefix}${k}:`);
          walk(val, prefix + '  ');
        } else lines.push(`${prefix}${k}: ${JSON.stringify(val)}`);
      }
    } else lines.push(`${prefix}${JSON.stringify(v)}`);
  };
  walk(obj);
  process.stdout.write(lines.join('\n') + '\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0] || '';
  if (args.help || !cmd) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const patchPath = args.patch ? path.resolve(args.patch) : null;
  const root = cmd === 'attribute' ? null : resolveQuarantineRoot({ root: args.root, stateDir: args.stateDir });

  if (cmd === 'attribute') {
    // 归因只读：生产上必须能对着真实 profile 读（写才受限）
    const target = patchPath || DEFAULT_PATCH;
    if (!fileExists(target)) throw new Error(`patch 文件不存在: ${target}`);
    const res = attribute(args.error || '', { patchPath: target });
    print(res, args.json);
    return res.hit ? 0 : 1;
  }

  if (cmd === 'quarantine') {
    const target = patchPath || DEFAULT_PATCH;
    assertSafePatch(target, { allowRealProfile: args.allowRealProfile });
    const attr = attribute(args.error || '', { patchPath: target });
    if (!attr.hit) {
      print({ ok: false, phase: 'attribute', attr, action: 'l2-rollback' }, args.json);
      return 1;
    }
    const ts = nowTs();
    if (attr.action === 'quarantine-package') {
      const dry = !args.apply;
      const res = quarantinePackage({ dir: attr.plugin.dir, name: attr.plugin.name, root, ts, dryRun: dry });
      if (!dry) {
        recordQuarantine(root, {
          unit: attr.unit,
          errcode: attr.errcode,
          quarantineId: res.quarantineId,
          ts,
          patchPath: target,
          action: 'quarantine-package',
          detail: res.to,
        });
      }
      print({ ...res, attr }, args.json);
      return 0;
    }
    const dry = !args.apply;
    const res = quarantineLines({ patchPath: target, attribution: attr, root, ts, dryRun: dry, allowRealProfile: args.allowRealProfile });
    if (!dry) {
      const rec = recordQuarantine(root, {
        unit: attr.unit,
        errcode: attr.errcode,
        quarantineId: res.quarantineId,
        ts,
        patchPath: target,
        lines: res.attr.lines,
        detail: attr.detail,
      });
      const metaFile = path.join(res.dir, 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      meta.recurCount = rec.recurCount;
      meta.firstSeen = rec.firstSeen;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
      if (args.probeCmd) {
        const probe = runProbeCommand(args.probeCmd);
        const pr = writeProbeResult(res.dir, {
          ok: probe.ok,
          durationMs: probe.durationMs,
          checks: [{ name: 'probe-cmd', ok: probe.ok, error: probe.error, detail: `cmd=${String(args.probeCmd).slice(0, 160)} exit=${probe.exitCode}` }],
        });
        meta.probe = { ...pr.body, file: pr.file };
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
        if (probe.ok) {
          meta.recovered = true;
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
          recordRecovered(root, { unit: attr.unit, errcode: attr.errcode, quarantineId: res.quarantineId, ts, probe: pr.body });
          print({ ...res, probe: pr.body, recovered: true }, args.json);
          return 0;
        }
        const rb = rollback({ quarantineId: res.quarantineId, root, patchPath: target, ts });
        recordRolledBack(root, { unit: attr.unit, errcode: attr.errcode, quarantineId: res.quarantineId, ts, err: 'probe failed' });
        print({ ...res, probe: pr.body, recovered: false, rollback: rb }, args.json);
        return 1;
      }
      print({ ...res, firstSeen: rec.firstSeen, recurCount: rec.recurCount, probePending: true }, args.json);
      return 0;
    }
    print({ ...res, dryRun: true }, args.json);
    return 0;
  }

  if (cmd === 'probe') {
    if (!args.id) throw new Error('缺 --id');
    const qdir = path.join(root, args.id);
    const metaFile = path.join(qdir, 'meta.json');
    if (!fileExists(metaFile)) throw new Error(`找不到隔离记录: ${metaFile}`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    let probe;
    if (args.cmd) {
      const r = runProbeCommand(args.cmd);
      probe = { ok: r.ok, durationMs: r.durationMs, checks: [{ name: 'probe-cmd', ok: r.ok, error: r.error, detail: `cmd=${String(args.cmd).slice(0, 160)} exit=${r.exitCode}` }] };
    } else if (args.probeJson) {
      const body = JSON.parse(fs.readFileSync(path.resolve(args.probeJson), 'utf8'));
      probe = {
        ok: body.ok === true,
        durationMs: Number(body.durationMs) || 0,
        checks: Array.isArray(body.checks) ? body.checks : [],
      };
    } else if (typeof args.ok === 'boolean') {
      probe = {
        ok: args.ok,
        durationMs: 0,
        checks: [{ name: 'external-session-probe', ok: args.ok, error: args.ok ? '' : String(args.error || ''), detail: args.error ? String(args.error).slice(0, 400) : '' }],
      };
    } else {
      throw new Error('探针需要 --cmd / --probe-json / --ok / --fail 之一');
    }
    const ts = nowTs();
    const pr = writeProbeResult(qdir, { ...probe, ts });
    meta.probe = { ...pr.body, file: pr.file };
    if (probe.ok) {
      meta.recovered = true;
      const rec = recordRecovered(root, { unit: meta.unit, errcode: meta.errcode, quarantineId: meta.quarantineId, ts, probe: pr.body });
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
      print({ ok: true, probe: pr.body, recovered: true, firstSeen: rec.firstSeen, recurCount: rec.recurCount }, args.json);
      return 0;
    }
    meta.recovered = false;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    if (meta.kind === 'plugin-package') {
      print({ ok: false, probe: pr.body, note: '插件包隔离回滚需人工移回（本阶段只做行级自动回滚）' }, args.json);
      return 1;
    }
    const rb = rollback({ quarantineId: args.id, root, patchPath: patchPath || meta.patchPath, ts });
    recordRolledBack(root, { unit: meta.unit, errcode: meta.errcode, quarantineId: args.id, ts, err: 'probe failed' });
    print({ ok: false, probe: pr.body, rollback: rb }, args.json);
    return 1;
  }

  if (cmd === 'rollback') {
    if (!args.id) throw new Error('缺 --id');
    const res = rollback({ quarantineId: args.id, root, patchPath: patchPath || '', force: args.force });
    print(res, args.json);
    return 0;
  }

  if (cmd === 'ledger') {
    const records = readLedger(root);
    const folded = foldLedger(records);
    print({ root, records: records.length, units: folded }, args.json);
    return 0;
  }

  throw new Error(`未知命令: ${cmd}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`[debride] ${err.message}\n`);
    process.exitCode = 2;
  }
}
