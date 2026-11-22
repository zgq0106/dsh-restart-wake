/**
 * Built-in protocol prompt — 2.0：重启/唤醒与本体自愈合并成一段。
 *
 * 工具只给 Agent「能做」；没有自备笔记的 Agent 仍然不知道何时该重启、是否该启动看门狗看护。
 * 本段注册在 Host 根作用域，profile 里每个 Agent 每一步都会看到，与预设和记忆无关。
 *
 * 两小节正文分别逐字搬自 dsh-restart-wake 0.1.6 与 dsh-ownshield 0.1.0，只把标题里的包名
 * 统一成 dsh-restart-wake。不要为省字符改写正文句子——改一个字都可能让模型误判顺序规则。
 *
 * 开关：restartPromptEnabled / ownshieldPromptEnabled，都缺省 true；
 * 旧字段 promptEnabled:false 等价于两者都关（升级兼容）。
 */

export const PROMPT_SECTION_NAME = 'dsh-restart-wake'

/** Late enough to read like operating notes, early enough to stay out of persona text. */
export const PROMPT_ORDER = 512

/**
 * 重启与唤醒小节。
 * @param {{ pendingDir?: string }} [options] Reserved for future per-install wording.
 */
export function restartPromptText(options = {}) {
  void options
  return [
    '## 重启与唤醒（dsh-restart-wake）',
    '本 Harness 装了 dsh-restart-wake：`restart_now` 通过计划任务重启 Harness，重启后自动唤醒本会话继续；`restart_status` 自检；`cookie_status` 查 dsh-auth-* cookie 堆积。',
    '何时重启：改了 `src/`、`package.json`、`cordis.patch.yml` 或已安装插件的代码/配置，且必须重新加载才能验证时，调用 `restart_now`。只改文档、记忆或普通内容一般不需要。',
    '顺序：`restart_now` 必须是本轮最后一步——回复、日志都写完再调用；它默认会拒绝在其它未登记的运行中会话存在时重启（调用方自己不算阻塞）。',
    '被阻塞只能等待时：**先调用 `wake_register` 写好唤醒登记**，再挂一条重检提醒——`schedule_create({ title, prompt, target: "this_session", rrule })`，`rrule` 是两行：第一行 `DTSTART;TZID=Asia/Shanghai:YYYYMMDDTHHMMSS`（当前时间 +5 分钟，较急可 +1 分钟），第二行 `RRULE:FREQ=DAILY;COUNT=1`；并**记下返回的 id**。不要只挂提醒不登记——别人触发重启时没有登记就不会被叫醒。',
    '确定可以重启时：先 `schedule_edit({ id: 记下的 id, action: "delete" })` 删掉重检提醒（未触发、已触发都能删），**再**调用 `restart_now`；否则旧提醒会在重启后再触发。',
    '重启后：先按记下的 id 再 `schedule_edit({ id, action: "delete" })` 一次（清掉已结束的记录），再调用 `restart_status` 确认日志末尾是 `RESULT: OK`，然后继续；不要重复重启，也不要把长任务安排在重启前。',
  ].join('\n')
}

/**
 * 本体自愈小节（原标题行按合并后的包名重写，其余五行正文逐字不动）。
 * @param {{ promptEnabled?: boolean }} [options] Reserved for per-install wording.
 */
export function ownshieldPromptText(options = {}) {
  void options
  return [
    '## 本体自愈（dsh-restart-wake）',
    '改 `src/`、asar 或 DSH 内核前：先用 `ownshield_snapshot` 建快照，再用 `ownshield_arm` 启动看护。',
    '启动看护后若把 DSH 改坏，看门狗会自动回滚、重启并校验，不需要人工守。',
    '连续失败三次会停手并写 needs-human 通报；此时先看 `ownshield_status`，不要反复启动看护。',
    '恢复成功后会自动停止看护，无需人工收尾。',
    '只在确实要动内核时启动看护——平时不要看护。',
  ].join('\n')
}

/**
 * 合并文本：两小节之间空一行；只开一个开关时就只有那一节。
 */
export function promptText({ restart = true, ownshield = true } = {}) {
  const parts = []
  if (restart) parts.push(restartPromptText())
  if (ownshield) parts.push(ownshieldPromptText())
  return parts.join('\n\n')
}

/**
 * Register the section on the calling scope (the Host root in `apply`).
 *
 * @returns {boolean} false when this profile has no systemPrompt registry or
 *   when both halves are disabled by config.
 */
export function registerPrompt(ctx, options = {}) {
  const legacyOff = options.promptEnabled === false
  /** 旧字段 promptEnabled 作为两者共同 fallback；任一显式 true 可单独重开。 */
  const on = (value) => {
    if (legacyOff) return false
    if (value === false) return false
    if (value === true) return true
    return true
  }
  const restartOn = on(options.restartPromptEnabled)
  const ownshieldOn = on(options.ownshieldPromptEnabled)
  if (!restartOn && !ownshieldOn) return false

  const service = ctx.get('systemPrompt')
  if (!service || typeof service.section !== 'function') return false

  const register = () =>
    service.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_ORDER,
      text: promptText({ restart: restartOn, ownshield: ownshieldOn }),
    })

  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-restart-wake.prompt()')
  } else {
    register()
  }
  return true
}
