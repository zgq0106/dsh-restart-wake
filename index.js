/**
 * dsh-restart-wake — Host half.
 *
 * On every Host startup this plugin:
 *   1. clears a stale restart mutex left by the previous restart, and
 *   2. delivers every registered wake-up through `sessionController.prompt`,
 *      which resumes cold sessions automatically.
 *
 * It also registers five Agent tools:
 *   restart_now / wake_register / wake_list / wake_cancel / restart_status
 *
 * There is no Client half: the plugin has no UI of its own.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './lib/config.js'
import { createTools } from './lib/tools.js'
import { startWakeLoop } from './lib/wake.js'

export const name = 'dsh-restart-wake'

/** `ctx.tools` must exist before the tools can be registered. */
export const inject = ['tools']

/**
 * @param ctx Cordis plugin context.
 * @param {Record<string, unknown>} [config] Loader row config, all fields optional.
 */
export function apply(ctx, config = {}) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const options = resolveConfig(pluginDir, config)

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }

  if (process.platform !== 'win32') {
    warn('自动重启目前只支持 Windows；唤醒、登记与状态查询仍可用。')
  }
  if (options.exePath === '' || !existsSync(options.exePath)) {
    warn(
      `未能定位 Harness 可执行文件（${options.exePath || '空'}）。restart_now 会拒绝执行；请在插件配置里设置 exePath。`,
    )
  }
  if (!existsSync(options.scriptPath)) {
    warn(`重启脚本缺失：${options.scriptPath}`)
  }

  startWakeLoop(ctx, options)

  for (const tool of createTools(ctx, options)) {
    const register = () => ctx.tools.register(tool)
    if (typeof ctx.effect === 'function') {
      ctx.effect(register, `${name}.tool.${tool.name}()`)
    } else {
      register()
    }
  }
}
