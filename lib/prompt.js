/**
 * Built-in protocol prompt.
 *
 * Tools alone only give an agent the *ability* to restart; an agent without its
 * own notes still does not know when a restart is warranted, that it must be the
 * last action of the turn, or that it should verify afterwards. This section is
 * registered on the Host root scope, so every Agent composed in this profile
 * receives it regardless of its preset or memory.
 *
 * Keep it short: it is injected on every model step.
 */

export const PROMPT_SECTION_NAME = 'dsh-restart-wake'

/** Late enough to read like operating notes, early enough to stay out of persona text. */
export const PROMPT_ORDER = 512

/**
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
 * Register the section on the calling scope (the Host root in `apply`).
 *
 * @returns {boolean} false when this profile has no systemPrompt registry.
 */
export function registerRestartPrompt(ctx, options) {
  if (options && options.promptEnabled === false) return false
  const service = ctx.get('systemPrompt')
  if (!service || typeof service.section !== 'function') return false

  const register = () =>
    service.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_ORDER,
      text: restartPromptText(options),
    })

  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-restart-wake.prompt()')
  } else {
    register()
  }
  return true
}
