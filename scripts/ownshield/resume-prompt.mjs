#!/usr/bin/env node
/**
 * ownshield · 续跑消息（resume）—— M2
 *
 * 设计依据：docs/ownshield-还魂设计-2026-11-19.md §2.3
 * 复活后注入的第一条消息结构固定：
 *
 *   [还魂] 我在 <时刻> 因 <错误码/阶段> 中断。
 *   中断前的目标：<will.goal>
 *   已完成：<will.done 最近 3 条>
 *   下一步原计划：<will.next>
 *   已隔离：<病历>（若无则写「无」）
 *   工具集指纹：<重新挂载后实际值> / 遗嘱值 <will.toolprint> → 一致 / 已变更
 *   请你先确认这三条是否仍成立，再继续。
 *
 * 关键规则：
 *   - toolprint 不一致 → 必须补一句「本次复活将发生缓存击穿，代价约 41k token 全价重算」
 *     （41000 来自 11-18 实测）；一致 → 不写这句；
 *   - 拿不到真实工具清单时写 unverified / 未采集，绝不假装一致；
 *   - 没有遗嘱 → 抛错，不编造续跑内容；
 *   - 已完成只展示最后 3 条，sha256 用遗嘱里的真实值，unverified 如实显示。
 *
 * CLI：
 *   node resume-prompt.mjs <sessionId> [--state-dir <dir>] [--reason "401 ..."]
 *        [--current-toolprint <12hex>] [--isolated "无"] [--tz-offset 480]
 *        [--interrupted-at <ISO>] [--out <file>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UNVERIFIED,
  fingerprintNames,
  normalizePrint,
  readLastWill,
  resolveStateDir,
  willFile,
} from './will.mjs'

/** 11-18 实测：toolprint 变更后缓存击穿约 41k token 全价重算。 */
export const CACHE_BREAK_TOKENS = 41000
export const CACHE_BREAK_NOTE = '本次复活将发生缓存击穿，代价约 41k token 全价重算'

const OFFSET_MINUTES = /^[+-]?\d{1,4}$/

export function formatTimestamp(value, offsetMinutes = -new Date().getTimezoneOffset()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const p = (n) => String(n).padStart(2, '0')
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const abs = Math.abs(offsetMinutes)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())} ` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

function clean(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

/** 遗嘱里的指纹格式不对（旧版/手工文件）时按 unverified 处理，不让续跑直接失败。 */
function readWillToolprint(value) {
  try {
    return normalizePrint(value, 'will.toolprint')
  } catch {
    return UNVERIFIED
  }
}

/** 已完成单条渲染：工具名 + 真实路径 + sha256 前 16 位（unverified 如实标注）。 */
export function formatDone(item) {
  const d = typeof item === 'string' ? { path: item } : item ?? {}
  const tool = typeof d.tool === 'string' && d.tool.trim() ? `${d.tool.trim()} ` : ''
  const file = d.path ? String(d.path) : '（无路径）'
  let sha
  if (!d.sha256 || d.sha256 === UNVERIFIED) {
    sha = 'sha256 unverified（文件不存在或未校验）'
  } else {
    sha = `sha256 ${d.sha256}`
  }
  if (d.hashMatch === false && d.claimedSha256) {
    sha += `；调用方声称 ${String(d.claimedSha256).slice(0, 16)}，与实际不符`
  }
  return `${tool}${file}（${sha}）`
}

/** 已隔离：字符串原样，数组逐条，空则「无」。 */
export function formatIsolated(isolated) {
  if (isolated == null || isolated === '') return '无'
  if (Array.isArray(isolated)) {
    const parts = isolated
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (!item || typeof item !== 'object') return ''
        const unit = item.unit ?? item.name ?? ''
        const code = item.error ?? item.errorCode ?? ''
        const when = item.firstSeen ? ` @${item.firstSeen}` : ''
        return unit ? `${unit}${code ? `（${code}）` : ''}${when}` : ''
      })
      .filter(Boolean)
    return parts.length ? parts.join('；') : '无'
  }
  return clean(String(isolated)) || '无'
}

/** 重新挂载后的「实际」工具指纹：必须由调用方给出，拿不到就是 unverified。 */
export function resolveCurrentToolprint(options = {}) {
  // 2026-11-19：接受 toolNames 作为 currentToolNames 的别名。
  // 背景：appendWill 认 toolNames，renderResume 认 currentToolNames，
  // 传错名不报错只静默降级成 unverified —— 端到端串联时才现形。
  const names = options.currentToolNames !== undefined ? options.currentToolNames : options.toolNames
  if (names !== undefined) {
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error(
        '工具清单必须是非空数组（currentToolNames 或 toolNames）：拿不到清单就不要传这个字段，不要传空数组冒充已采集',
      )
    }
    return fingerprintNames(names)
  }
  if (options.currentToolprint != null) return normalizePrint(options.currentToolprint, 'currentToolprint')
  if (options.toolprint != null) return normalizePrint(options.toolprint, 'toolprint')
  return UNVERIFIED
}

/**
 * 渲染续跑消息。options:
 *   stateDir / home      遗嘱位置（默认 ~/.dsh/ownshield）
 *   reason               中断的错误码/阶段（如 "llm/model-discovery-rejected（401）"）
 *   currentToolprint     重新挂载后的实际工具指纹；或 currentToolNames 数组
 *   isolated             已隔离病历（字符串或数组）；空 → 无
 *   interruptedAt        中断时刻（默认取 will.ts）
 *   tzOffsetMinutes      时区偏移，默认本机（+480）
 */
export function renderResume(sessionId, options = {}) {
  const found = readLastWill(sessionId, options)
  if (!found.entry) {
    throw new Error(
      `未找到 session ${sessionId} 的遗嘱（${willFile(resolveStateDir(options), sessionId)}），不能编造续跑内容`,
    )
  }
  const will = found.entry
  const offset = OFFSET_MINUTES.test(String(options.tzOffsetMinutes))
    ? Number(options.tzOffsetMinutes)
    : -new Date().getTimezoneOffset()
  const when = formatTimestamp(options.interruptedAt ?? will.ts, offset)
  const reason = clean(options.reason) || '未记录的错误（遗嘱不记录错误码）'
  const done = Array.isArray(will.done) ? will.done : []
  const lastDone = done.slice(-3)

  const lines = [
    `[还魂] 我在 ${when} 因 ${reason} 中断。`,
    `中断前的目标：${clean(will.goal) || '（未记录）'}`,
  ]
  if (lastDone.length) {
    lines.push('已完成：')
    for (const item of lastDone) lines.push(`  - ${formatDone(item)}`)
  } else {
    lines.push('已完成：无')
  }
  lines.push(`下一步原计划：${clean(will.next) || '（未记录）'}`)
  lines.push(`已隔离：${formatIsolated(options.isolated)}`)

  const willTp = readWillToolprint(will.toolprint)
  const currentTp = resolveCurrentToolprint(options)
  const willKnown = willTp !== UNVERIFIED
  const currentKnown = currentTp !== UNVERIFIED
  if (!willKnown || !currentKnown) {
    const missing = !currentKnown ? '当前工具清单未采集' : '遗嘱未采集'
    lines.push(`工具集指纹：${currentTp} / 遗嘱值 ${willTp} → 无法对账（${missing}）`)
  } else if (currentTp === willTp) {
    lines.push(`工具集指纹：${currentTp} / 遗嘱值 ${willTp} → 一致`)
  } else {
    lines.push(`工具集指纹：${currentTp} / 遗嘱值 ${willTp} → 已变更`)
    lines.push(CACHE_BREAK_NOTE)
  }
  lines.push('请你先确认这三条是否仍成立，再继续。')
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { _: [] }
  const valueOptions = new Set([
    '--state-dir',
    '--reason',
    '--current-toolprint',
    '--isolated',
    '--tz-offset',
    '--interrupted-at',
    '--out',
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (valueOptions.has(arg)) {
      args[arg.slice(2)] = argv[++i] ?? ''
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=')
      args[key] = rest.join('=')
    } else {
      args._.push(arg)
    }
  }
  return args
}

export const HELP = `ownshield resume-prompt —— 续跑消息渲染

node resume-prompt.mjs <sessionId> [--state-dir <dir>] [--reason "401 ..."]
     [--current-toolprint <12hex>] [--isolated "无"] [--tz-offset 480]
     [--interrupted-at <ISO>] [--out <file>]
`

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sessionId = args._[0]
  if (!sessionId) {
    console.error('缺少 <sessionId>')
    console.log(HELP)
    process.exitCode = 2
    return
  }
  try {
    const message = renderResume(sessionId, {
      stateDir: args['state-dir'],
      reason: args.reason,
      currentToolprint: args['current-toolprint'],
      isolated: args.isolated,
      tzOffsetMinutes: args['tz-offset'],
      interruptedAt: args['interrupted-at'],
    })
    if (args.out) {
      const target = path.resolve(args.out)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${message}\n`, 'utf8')
      console.log(`已写入 ${target}（${message.length} 字符）`)
    } else {
      console.log(message)
    }
  } catch (err) {
    console.error(`失败：${err.message}`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
