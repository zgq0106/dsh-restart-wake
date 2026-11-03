# dsh-restart-wake

让 Agent **安全地重启 DeepSeek Harness，并在重启后自动回到原会话继续干活**。

给 DeepSeek Harness 用的 Host 插件：五个 Agent 工具 + 一个启动唤醒器 + 一套参数化的重启脚本。装上之后，模型可以自己安排重启、自己回来验收，不需要人盯着。

- 插件名：`dsh-restart-wake`
- 平台：**重启仅 Windows**；唤醒、登记、状态查询跨平台
- 依赖：无（不引入任何 npm 包）
- DSH 版本：`0.2.1-rc.5` 实测

---

## 它解决什么问题

改 `src/`、`package.json`、`cordis.patch.yml`、插件包之后，Host 必须重启才生效。但「让 Harness 重启自己」有三道物理障碍，每一步都踩过坑：

| 障碍 | 现象 | 原因 |
|---|---|---|
| 在 Harness 内启动重启脚本 | 脚本日志停在 `killing`，永远不回来 | Harness 把子进程放进 Windows Job Object，杀 Harness 时脚本一起被砍 |
| 杀完立刻启动 | 新实例刚起来就退出 | Electron 单实例锁还没释放，新实例把参数交给正在退出的旧实例后自杀 |
| 重启后没人通知 | 会话停在原地，等人来敲 | 脚本在进程外跑，没有能力在「刚启动」那一刻通知会话 |

本插件的做法：

1. **计划任务**在 Harness 进程树之外执行重启（绕过 Job Object）；
2. **先杀浏览器主进程、再杀子进程**，并等待单实例锁释放（没有崩溃弹窗和报错音）；
3. 重启前把「醒来要做什么」写成登记文件，**启动唤醒器**在新进程就绪后通过 `sessionController.prompt` 投递——该接口会自动 resume 冷会话。

---

## 安装

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

装完**重启一次 Harness**（Host 插件模块按包名缓存，启用/禁用不会重读）。

如果 pnpm 不认 `github:` 前缀，用完整地址：

```powershell
dsh plugin --profile desktop add "git+https://github.com/zgq0106/dsh-restart-wake.git"
```

### 安装后自检

在新会话里让 Agent 调用 `restart_status`。它会报告：

- 探测到的 Harness 可执行文件路径、是否存在；
- 重启脚本 / 计划任务入口是否就位；
- 唤醒登记目录、重启锁状态、运行中的会话、日志末尾。

`exePath` 显示 `⚠ 不存在` 时，在插件配置里显式指定（见下方「配置」）。

---

## 五个工具

| 工具 | 作用 |
|---|---|
| `restart_now` | 登记唤醒 → 检查互斥锁 → 检查阻塞会话 → 挂计划任务 → 在 `delaySeconds` 秒后重启 |
| `wake_register` | 只登记唤醒，不重启。本会话收尾后等别的会话触发重启时把自己叫醒 |
| `wake_list` | 查看待唤醒登记、最近归档、重启锁状态 |
| `wake_cancel` | 取消本会话的唤醒登记 |
| `restart_status` | 自检与验收：路径、脚本、锁、运行中会话、日志末尾 |

调用方不需要手填会话 id：工具从执行上下文 `exec.agent.id` 自动读取。

### 典型用法（Agent 侧）

```text
模型：改完插件配置，需要重启生效。
1. restart_status        → 确认 exeExists / scriptExists 都为 true，没有阻塞会话
2. restart_now({ prompt: "重启完成，读取日志确认 RESULT: OK，然后继续完成 P2.4 连线可视化" })
3. 回复主人：「已安排重启，约 12 秒后回来」，本回合结束
4. 重启后插件自动投递 prompt，会话继续
5. restart_status        → 验收：锁已释放、登记已归档、日志末尾 RESULT: OK
```

---

## 重启过程

```
Agent 调用 restart_now
  ├─ 写 wake-pending-<sessionId>.json      （重启后要投递的话）
  ├─ 写 restart-config.json                （脚本参数）
  ├─ 写 restart.lock                       （互斥锁）
  └─ schtasks /Create + /Run               （一次性任务，12 秒后执行）
        ↓ 12 秒（给回复和日志留时间）
      restart-dsh.ps1（进程外）
        ├─ 优雅关窗（Harness 只是隐藏到托盘）
        ├─ 识别浏览器主进程 → 先杀它 → 再杀子进程
        ├─ 等所有进程消失
        ├─ （可选）cookie 快照
        ├─ 等单实例锁释放（3 秒）
        ├─ 启动 → 等 8 秒 → 数进程，最多重试 3 次
        ├─ 写 RESULT: OK / FAILED
        └─ 删除一次性计划任务
        ↓
      新 Host 启动
        ├─ 清除 restart.lock
        ├─ 扫描 wake-pending-*.json
        └─ sessionController.prompt(...) → 会话被唤醒
```

没有登记时，唤醒器完全静默，只写一行 `no-pending` 日志。

---

## 配置

**默认值即开即用**：可执行文件从运行中的进程自动探测，登记目录在 `~/.dsh/restart-wake`，脚本随包分发。

需要改时，在 profile 的 `cordis.patch.yml` 里覆盖这一行（`config` 整体替换，但插件对缺失字段回落默认值，所以只写要改的即可）：

```yaml
- id: restart-wake
  name: dsh-restart-wake
  config:
    pendingDir: 'D:\dsh-wake'
    delaySeconds: 15
```

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `pendingDir` | `~/.dsh/restart-wake` | 唤醒登记、锁、日志、脚本参数的存放目录 |
| `logPath` | `<pendingDir>/wake.log` | 唤醒器与重启日志 |
| `lockPath` | `<pendingDir>/restart.lock` | 重启互斥锁 |
| `exePath` | 自动探测 | Harness 可执行文件；探测失败时必须显式指定 |
| `processName` | 自动推导 | 进程名（不含 `.exe`），用于杀进程与计数 |
| `scriptPath` | 包内 `scripts/restart-dsh.ps1` | 重启脚本 |
| `commandPath` | 包内 `scripts/run-restart.cmd` | 计划任务入口 |
| `taskName` | `DshRestartWake` | 一次性计划任务名；多份安装要改成不同的名字 |
| `delaySeconds` | `12` | 挂任务后等多久再重启 |
| `launchWaitSeconds` | `8` | 每次启动后等待多久再数进程 |
| `maxLaunchAttempts` | `3` | 启动尝试次数 |
| `graceSeconds` | `8` | 优雅关窗等待秒数 |
| `killTimeoutSeconds` | `20` | 强杀后等待进程消失的上限 |
| `singleInstanceWaitSeconds` | `3` | 等 Electron 单实例锁释放 |
| `lockStaleMs` | `600000` | 超过这个年龄的锁视为失效（默认 10 分钟） |
| `maxAgeMs` | `86400000` | 登记超过这个年龄不投递（默认 24 小时） |
| `maxAttempts` | `3` | 单条投递重试次数 |
| `retryDelayMs` | `15000` | 重试间隔 |
| `startupDelayMs` | `3000` | 启动后延迟多久开始扫描 |
| `cookieDbPath` | 空 | 可选：Chromium Cookies 数据库路径，用于重启时快照登录 cookie 寿命 |
| `cookieProbePath` | 包内 `scripts/cookie-probe.mjs` | 可选：cookie 探针脚本 |
| `crashLogDir` | 空 | 可选：崩溃日志目录，用于统计「杀进程有没有新增渲染崩溃」 |

> `pendingDir` 的路径会影响计划任务命令行长度（上限 260 字符）。路径过长时 `restart_now` 会直接报错并建议换到更短的目录。

---

## 安全边界

- 只投递文本，不执行命令；
- 每条登记最多投递 3 次，失败归档，**绝不无限重试**；
- 登记超过 24 小时自动过期；
- 互斥锁保证同一时刻只有一次重启；
- 默认拒绝在「其他未登记的运行中会话」存在时重启（`force: true` 可覆盖）；
- 重启前校验可执行文件、脚本、计划任务入口，缺一个就**不动手**；
- 不碰凭据、不上传任何数据、不包含任何遥测。

---

## 平台与限制

- **重启**：仅 Windows（`schtasks` + PowerShell）。非 Windows 上 `restart_now` 直接报错，不做任何破坏性动作。
- **唤醒**：纯 Node，跨平台可用。
- 重启会中断当前回合；未保存的输入会丢失。
- 前提是 Harness 桌面端会恢复上次窗口（默认会）。即使不恢复，登记也不会丢，主人在下次打开会话时补投，只是不再「自动回来」。
- 如果 Harness 同时装了别的「启动即投递」插件并共用同一个登记目录，会造成重复投递——请给两份插件配置不同的 `pendingDir`。

---

## 故障排查

| 现象 | 检查 |
|---|---|
| `restart_now` 返回 `blocked` | 有别的会话在跑且没登记；等它收尾，或确认可打断后传 `force: true` |
| `restart_now` 返回 `busy` | 10 分钟内已有别人挂了重启任务；等它执行完，不要重复挂 |
| `schtasks /Create` 报「找不到路径」 | 先跑全量 `schtasks /Query /FO LIST` 判断是权限还是任务不存在，别把「任务不存在」误读成被拦 |
| 日志停在 `killing` | 脚本被 Job Object 连带杀了：确认是计划任务在执行，不是从 Harness 内 `Start-Process` |
| 日志停在 `attempt N : running processes = 0` | 启动失败：手动双击 Harness，查 `RESULT: FAILED` 附近的 throw 信息 |
| 重启后有 Windows 报错音 | 杀进程顺序错了：必须**先杀浏览器主进程**，再杀子进程 |
| 醒来后没有收到 prompt | 看 `wake.log`：`delivered` = 成功；`controller-unavailable` = 会话服务没就绪；`expired` = 登记超过 24 小时 |

---

## 开发

```powershell
node --check index.js
node test/smoke.mjs        # 离线测试，不需要 Harness / 计划任务
```

目录：

```
index.js                   宿主插件入口（唤醒 + 注册工具）
lib/config.js              配置解析与可执行文件探测
lib/pending.js             唤醒登记文件
lib/wake.js                启动唤醒循环
lib/restart.js             互斥锁、会话检查、计划任务、日志
lib/tools.js               五个 Agent 工具
scripts/restart-dsh.ps1    参数化重启脚本（纯 ASCII）
scripts/run-restart.cmd    计划任务入口
scripts/cookie-probe.mjs   可选的 cookie 快照
docs/restart-protocol.md   给 Agent 看的重启协议
```

## 许可

MIT
