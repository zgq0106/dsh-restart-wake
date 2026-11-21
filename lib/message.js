/**
 * 把 pending 记录组装成一条给模型的注入消息。
 *
 * 结构（任务 5.4）：
 *   - 出错阶段 / 来源 / 级别
 *   - 错误尾部（默认最后 20 行）
 *   - 已回滚到哪个快照、哪些文件
 *   - 一句要求：先解释根因，再给最小修复，不要重做大改
 *
 * 所有内容来自磁盘记录，只做文本化，不执行任何东西；长度有硬上限。
 */

const INSTRUCTION =
  '请先解释根因，再给出最小修复方案：不要重做大改，也不要在无人确认时自动修改本体或重启。若根因不明确，先说清你验证过什么、还缺什么证据。'

/** 探针请求不是故障，不能套用「发生过故障」与「解释根因」那套话术。 */
const PROBE_INSTRUCTION =
  '这是定时自检，不是故障。请直接调用 ownshield_probe（无参数）跑一次本体探针即可；不要修改任何东西，也不要重启。'

/** 恢复成功是通报，不是处置请求（2026-11-21 起）：此前只写 recovered.json，无人值守时没人知道救过一次。 */
const RECOVERED_INSTRUCTION =
  '这是恢复成功的事后通报，不需要修改或重启任何东西。需要确认现场可以调用 ownshield_probe 跑一次探针；否则读完结论继续手上未完成的工作即可。'

/** 按级别换开头：2026-11-21 之前所有级别共用一句「发生过故障」，把自检消息渲染成了事故。 */
function headerFor(level) {
  if (level === 'probe') {
    return '（ownshield 定时自检）这是一条探针请求，**本会话没有发生故障**；看门狗也不要求你做任何处置。'
  }
  if (level === 'needs-human') {
    return '（ownshield 自愈停手）看门狗已按分级策略停止自动处理，把现场交给人判断。这是「需要人工确认」的状态，不等于已恢复。'
  }
  if (level === 'recovered') {
    return '（ownshield 已自动恢复）看门狗已在本轮自愈中把 DSH 拉起来并通过校验。**这是一条事后通报**，会话此刻是正常的。'
  }
  return '（ownshield 自愈注入）本会话的 DSH 发生过故障，看门狗已按分级策略处理，并把处理现场回注给你。'
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function listFiles(value) {
  if (Array.isArray(value)) return value.map(oneLine).filter(Boolean)
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[,，;；\r\n]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

/** recovered 既可能是布尔，也可能是看门狗写的一句结论。 */
export function describeRecovered(value) {
  if (typeof value === 'boolean') return value ? '已恢复（本级探针通过）' : '未恢复（本级失败，已按策略降级或停手）'
  const text = oneLine(value)
  return text === '' ? '未知' : text
}

/**
 * @param {object} task readTask() 的返回值
 * @param {{maxErrorLines?:number, maxMessageChars?:number}} [options]
 * @returns {string}
 */
export function buildInjectMessage(task, options = {}) {
  const maxErrorLines = Number.isFinite(options.maxErrorLines) && options.maxErrorLines > 0 ? options.maxErrorLines : 20
  const maxMessageChars =
    Number.isFinite(options.maxMessageChars) && options.maxMessageChars > 100 ? options.maxMessageChars : 6000

  const fields = []
  const push = (label, value) => {
    const text = oneLine(value)
    if (text !== '') fields.push(`- ${label}：${text}`)
  }

  push('级别', task.level ?? '未知')
  push('出错阶段', task.phase ?? '未知')
  if (task.source) push('出错来源', task.source)
  push('恢复结果', describeRecovered(task.recovered))
  if (task.snapshotTag) push('回滚快照', task.snapshotTag)
  const files = listFiles(task.rollbackFiles ?? task.files)
  if (files.length > 0) push('回滚文件', files.join('、'))
  if (task.note) push('备注', task.note)

  const rawTail = Array.isArray(task.errorTail) ? task.errorTail : []
  const tail = rawTail.slice(-maxErrorLines).map((line) => String(line).slice(0, 800))
  const errorSection =
    tail.length === 0
      ? []
      : ['', `错误尾部（最后 ${tail.length} 行）：`, '```', ...tail, '```']

  const promptSection =
    typeof task.prompt === 'string' && task.prompt.trim() !== ''
      ? ['', '看门狗留言：', task.prompt.trim()]
      : []

  const level = String(task.level ?? '').toLowerCase()
  const instruction =
    level === 'probe' ? PROBE_INSTRUCTION : level === 'recovered' ? RECOVERED_INSTRUCTION : INSTRUCTION
  const header = headerFor(level)
  let body = [header, '', ...fields, ...errorSection, ...promptSection].join('\n')

  const budget = Math.max(200, maxMessageChars - instruction.length - 2)
  if (body.length > budget) {
    body = `${body.slice(0, Math.max(0, budget - 20)).trimEnd()}\n…（内容过长，已截断）`
  }
  return `${body}\n\n${instruction}`
}
