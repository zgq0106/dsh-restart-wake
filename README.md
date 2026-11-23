# dsh-restart-wake

**让 Agent 安全地重启 DeepSeek Harness、重启后自动回到原会话；改内核改坏了就把它救回来，让模型自己修。**

一个包，十一件工具，一套启动钩子：重启与唤醒、本体探针、快照与看门狗、故障回注。

**一句话说清它做什么：它把模型救回来，修由模型自己做。**

DSH 崩了、挂了，或者改内核改到启动后跑不动——这时模型没法干活，谁来修？没有这个插件，得人自己去翻日志、手动换文件、重启、再把会话捡起来。有了它：看门狗一分钟内发现，把 `app.asar`（或 profile 层）回滚到快照那一刻、重启、校验，把 DSH 拉回「模型能建会话、能调工具」的状态，然后把现场——崩溃原因、失败记录、中断前的目标——注入回原会话。**模型重新上线，看到现场，自己动手修。**

插件本身不做根因分析、不改一行代码；它保证模型能重新上线，并且一上线就拿到出事时的现场。默认不常驻：没调 `ownshield_arm` 之前，它不会自动做任何事。

- 插件名：`dsh-restart-wake`
- 版本：**2.1.0**
- 平台：**重启、cookie 清理、自愈链仅 Windows**；唤醒、登记、状态查询跨平台
- 依赖：无（只用 Node 内置模块）
- DSH 版本：要求 **≥ `0.2.2-alpha.2`**；`0.2.2-rc.2` 实测

> ## 从 0.1.x 升级到 2.x：直接更新
>
> 2.x 在同一个包里补上自愈与回注能力：工具从 6 个增加到 11 个，profile 的 `dsh.profile.bundles` 里那一行保持不动，状态目录 `~/.dsh/ownshield` 由本包沿用（里面是首次使用才生成的运行时文件，没有也不影响）。
>
> **行为变化**：`ownshield_probe` 默认不再建会话——需要验证「会话能不能跑」时传 `deep: true`。工具名与其余行为不变。

---

## 兼容的 DSH 版本

`package.json` 声明了 `engines.dsh: ">=0.2.2-alpha.2"`，所以版本对不上时**在安装阶段就会被兼容性检查拒绝**——不会装上去之后再悄悄坏掉。按你手上的 DSH 版本选：

| DSH 版本 | 该用哪个插件版本 | 说明 |
|---|---|---|
| `≥ 0.2.2-alpha.2` | **2.x（当前 2.1.0）** | 实测 `0.2.2-rc.2`；11 个工具，含自愈。`0.2.2-alpha.2` – `0.2.2-rc.1` 未逐个实测 |
| `0.2.1`（含 `0.2.1-rc.x`） | **v0.1.5** | 实测 `0.2.1-rc.5`；只有重启与唤醒，**没有自愈**。v0.1.5 不声明 `engines.dsh`，不做拦截 |
| 更低（0.1.x、0.2.0） | v0.1.5，未验证 | 能装上，但没测过；建议先升 DSH |

分界点在 `0.2.2-alpha.2`：这一版改了 Schedule 工具——时间参数从 `after_seconds` 改成必填 `rrule` + `target`，`schedule_update` / `schedule_delete` 合并为 `schedule_edit`。本插件注入给 Agent 的操作规程（每一步都会看到）跟的是新形态；放到旧版 DSH 上，它会指向不存在的工具，凡是「让 Agent 建/改提醒」的流程都会失败。所以这不是「勉强能用」，而是版本对不上就换版本。

要用旧版本就指定 tag：

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake#v0.1.5
```

升级顺序：先把 DSH 升到 `≥ 0.2.2-alpha.2`，再更新到 2.x。反过来会先被拒绝安装。

---

## 它解决什么问题

### 一、重启与唤醒

改 `src/`、`package.json`、`cordis.patch.yml`、插件包之后，Host 必须重启才生效。但「让 Harness 重启自己」有三道物理障碍，每一步都踩过坑：

| 障碍 | 现象 | 原因 |
|---|---|---|
| 在 Harness 内启动重启脚本 | 脚本日志停在 `killing`，永远不回来 | Harness 把子进程放进 Windows Job Object，杀 Harness 时脚本一起被砍 |
| 杀完立刻启动 | 新实例刚起来就退出 | Electron 单实例锁还没释放，新实例把参数交给正在退出的旧实例后自杀 |
| 重启后没人通知 | 会话停在原地，等人来敲 | 脚本在进程外跑，没有能力在「刚启动」那一刻通知会话 |

做法：**计划任务**在进程树之外执行重启（绕过 Job Object）→ **先杀浏览器主进程、再杀子进程**并等单实例锁释放 → 重启前把「醒来要做什么」写成登记文件，**启动唤醒器**在新进程就绪后通过 `sessionController.prompt` 投递（该接口会自动 resume 冷会话）。

### 二、本体自愈

有些故障不写 crash log：DSH 正常启动、界面可用，但一建会话就报 `Duplicate tool group identifier: outbound`；或新建会话报 `agent-preset/invalid`、旧会话报 `resume failed`。这类错误只以 RemoteError 返回客户端，日志里查不到——只看「进程活着 / 没 crash log」永远发现不了。

于是有了两张面孔：

| 面孔 | 工具 | 做什么 |
|---|---|---|
| 探针（默认，随时可用） | `ownshield_probe` | 只检测不修复。默认四项静态检查（工具清单 / 服务 / 心跳 / 凭据），零会话零 token；传 `deep: true` 才建临时会话、发 `probe`、resume 固定会话 |
| 自愈链（按需看护，非常驻） | `ownshield_snapshot` / `ownshield_arm` / `ownshield_disarm` / `ownshield_status` | 改 `src/`、asar 或内核前建快照并看护；崩了由看门狗回滚 → 重启 → 校验 → 通报；**恢复成功自动停止看护** |

自愈链不常驻：只有看护期间看门狗才持有回滚权。恢复链脚本随包分发在 `scripts/ownshield/`。

**分工是这样的：**

| 谁 | 做什么 |
|---|---|
| 插件 | 发现坏了 → 回滚文件 → 重启 → 校验「模型能建会话、能调工具」→ 把现场送回原会话（崩溃原因、失败记录、中断前的目标） |
| 模型 | 被救回来之后，读现场、判根因、自己改代码，然后继续原来的活 |
| 人 | 看护没开时的一切；连续三次失败后的处置（插件写 `needs-human.json` 停手，不无限重试） |

所以准确的说法是「**插件复活，模型修复**」。插件不猜根因、不改代码——它保证模型能重新上线，并且一上线就带着出事时的现场。这也是为什么验收线定在「模型能建会话、能调工具」而不是「错误消失」。

还有第三条不显眼的能力：**故障回注**。看门狗判失败、熔断交人时写下的通报，会在下次启动（或运行中每 5 分钟的扫描）投递回受影响的会话；模型请求失败时（`401` / `429`）也会立刻把失败现场注入当前会话一轮，让它自己看见并告知主人。

### 三、能救什么，不能救什么

**一句话口径**：改内核前开启看护——DSH 崩了、挂了、或启动后跑不动，一分钟内发现、二十秒左右回滚重启并回到原会话，无人值守。看护按需开启、只回滚内核、失败三次停手交人。

能救（真机验过）：

| 故障 | 发现时延 | 处置 |
|---|---|---|
| 主进程崩溃 / 被杀 / 自己退出 | ≤ 60 s | 清创 → 回滚 `app.asar` → 重启 → 校验 → 通报，实测 22 s |
| 新 crash log 落盘 | ≤ 60 s | 同上 |
| Host 挂死（进程在、心跳 90 s 不刷新） | 2–3 min（软信号复现两次） | 重启 |
| 启动后跑不动：`agent-preset/invalid`、`Duplicate tool group`、`resume failed`、工具/服务清单缺失 | **最长 6 小时**（探针闸限流） | 归因到具体 patch 条目则隔离；归因不命中则回滚 |
| 本地 Web cookie 过期（401，刷新页面即失败） | ≤ 1 min（守卫在未看护时也在跑） | 只重启，不回滚 |
| 模型改坏 profile（`cordis.patch.yml` / 预设 / `package.json`） | 不额外计时（排在 L2 之后） | **L3**：只还原 profile 层；`node_modules` 实体不动 |

救不了，别指望：

1. **看护没开启时，任何故障都不救。** 这是设计：平时它不持有回滚权。
2. **回滚分两层，两层都有边界。** L1/L2 回滚 `app.asar`；L3 只还原 profile 层（`cordis.patch.yml`、预设目录、`package.json`、`link:` 关系）。`node_modules` 实体、会话、记忆、凭据、网络、磁盘都不在任何快照内。
3. **未知形态**：清创认不出的错误只能回滚内核；根因在 profile 层时回滚无效，连续失败三次即熔断，写 `needs-human.json` 交人。
4. **快照缺失或与当前内核不一致**（例如中途升级过 DSH）时，哈希闸拒绝回滚。
5. **无信号盲区**：渲染进程白屏但不写 log、窗口无响应、会话文件损坏、凭据被服务端吊销、第三方插件 `apply()` 抛错，以及**代码能启动但功能坏了**。
6. **「原地」的边界**：活回来的是新进程。会话从磁盘恢复并 resume；崩溃瞬间未落盘的工具调用、写了一半的文件不会被修复。

再补一句：这条链不区分故障由谁造成，它只认「内核层可回滚的坏」。所以「模型造成的故障」不是它的一个特殊覆盖面——写介绍时别把这个定语当能力。口径统一成「**插件复活，模型修复**」：插件的产出是「模型又能干活了」，不是「错误被修好了」；根因分析与改代码，是模型被救回来之后自己做的事。

---

## 安装

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

装完**重启一次 Harness**（Host 插件模块按包名缓存，启用/禁用不会重读）。

pnpm 不认 `github:` 前缀时用完整地址：

```powershell
dsh plugin --profile desktop add "git+https://github.com/zgq0106/dsh-restart-wake.git"
```

从 0.1.x 升级直接更新即可（见首屏）。状态目录 `~/.dsh/ownshield` **不用动**——2.x 沿用同一位置。

### 安装后自检

在新会话里让 Agent 调用 `restart_status` 与 `ownshield_status`：

- `restart_status` 报告可执行文件路径、重启脚本 / 计划任务入口是否就位、登记目录、重启锁、运行中会话、日志末尾；
- `ownshield_status` 报告是否看护、计划任务是否存在、快照库路径、最近一次恢复结论、cookie 守卫退避、`needs-human.json` 是否存在。

`exePath` 显示 `⚠ 不存在` 时，在插件配置里显式指定（见「配置」）。

---

## 十一个工具

重启与唤醒（6 个）：

| 工具 | 作用 |
|---|---|
| `restart_now` | 登记唤醒 → 检查互斥锁 → 检查阻塞会话 → 挂计划任务 → 在 `delaySeconds` 秒后重启 |
| `wake_register` | 只登记唤醒，不重启。本会话收尾后等别的会话触发重启时把自己叫醒 |
| `wake_list` | 查看待唤醒登记、最近归档、重启锁状态 |
| `wake_cancel` | 取消本会话的唤醒登记 |
| `restart_status` | 自检与验收：路径、脚本、锁、运行中会话、日志末尾 |
| `cookie_status` | 查看 `dsh-auth-*` cookie 堆积情况与清理阈值（431 崩溃的根因） |

本体自愈（5 个）：

| 工具 | 作用 |
|---|---|
| `ownshield_probe` | 默认四项静态检查（零会话、零 token）；`deep: true` 再加建会话三项。结果写到 `~/.dsh/ownshield/probe-<时间戳>.json` |
| `ownshield_snapshot` | 给 `app.asar` 建内容寻址快照，返回 tag 与占用 |
| `ownshield_arm` | 检查快照存在 / 快照闸 / DSH 进程 / Node 可执行，写 `arm.json` 并幂等创建每分钟一次的计划任务；**已在看护时默认拒绝覆盖回滚点**，要换快照请显式传 `replace: true`（同一 tag 重复调用按幂等放行） |
| `ownshield_disarm` | 停止看护：`arm.json` 归档到 `disarm/`，不删计划任务（未在看护时它仍跑 cookie 守卫） |
| `ownshield_status` | 只读自检：看护状态、任务、快照库解析路径、最近恢复结论、熔断交接文件；**看护与计划任务/启动器不一致时报 `ok:false` 并打 `⚠`**（防「看起来已在看护、实际没人盯」） |

调用方不需要手填会话 id：工具从执行上下文 `exec.agent.id` 自动读取。

### 内置协议提示（不依赖 Agent 自己的记忆）

插件通过 `ctx.systemPrompt.section()` 在 Host 根作用域注册一段说明，**所有经过这个 profile 的 Agent 每一步都会看到**，分两小节：

- **重启与唤醒**：何时该重启、`restart_now` 必须是本轮最后一步、被阻塞时的登记与重检顺序、重启后先 `restart_status` 验收；
- **本体自愈**：改内核前先快照再看护、启动看护后看门狗自理、连续三次失败会停手交人、恢复成功自动停止看护、平时不要看护。

两节可以分别关闭：`restartPromptEnabled` / `ownshieldPromptEnabled`；旧的 `promptEnabled: false` 等价于两个都关。

### 典型用例（Agent 侧）

```text
【重启】改完插件配置，需要重启生效。
1. restart_status   → 确认 exeExists / scriptExists 都为 true，没有阻塞会话
2. restart_now({ prompt: "重启完成，读取日志确认 RESULT: OK，然后继续" })
3. 回复主人：「已安排重启，约 12 秒后回来」，本回合结束
4. 重启后插件自动投递 prompt，会话继续
5. restart_status   → 验收：锁已释放、登记已消费、日志末尾 RESULT: OK

【自愈】要改 DSH 内核文件。
1. ownshield_snapshot({})        → 得到 tag
2. ownshield_arm({ tag })        → 快照闸通过、任务创建成功
3. 改内核
4. 改崩了就等看门狗：自动回滚 → 重启 → 校验 → 通报原会话，然后自动停止看护
```

### 重启 × 自愈：两条链怎么协同（2.0 合包后）

合包不只是省一次安装——两条链现在能互相看见：

- **看护状态下正常重启**：`restart_now` 会在调度前给 `arm.json` 打 `expectGracefulExit`。
  看门狗看到进程消失会按「正常退出」处理：不拉起重启、直接停止看护，不会把这次重启判成崩溃
  去回滚。`restart_status` 的 `ownshield` 字段直接显示当前是否 armed、是否已标记。
- **恢复后的续跑**：看门狗救回来时，如果目标会话写过遗嘱（`will.mjs`），投递给它的是
  `[还魂]` 消息——中断时刻、中断前的目标、已完成、下一步原计划、工具集指纹是否变更；
  没有遗嘱就退回一句事后通报，**不编造**续跑内容。
- **看护状态的假象**：`arm.json` 在、计划任务不在时，`ownshield_status` 报 `ok:false` 并在
  首行打 `⚠`。看到「看护：是」却感觉没人管时，先看这一行。

---

## 第一部分：重启链路

### 重启过程

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
        ├─ cookie 清理：dsh-auth-* 超过阈值就删（防 431 崩溃）
        ├─ cookie 快照（只读）
        ├─ 等单实例锁释放（3 秒）
        ├─ 启动 → 等 8 秒 → 数进程，最多重试 3 次
        ├─ 写 RESULT: OK / FAILED
        └─ 删除一次性计划任务
        ↓
      新 Host 启动
        ├─ 清除 restart.lock
        ├─ 扫描 wake-pending-*.json
        ├─ 扫描 ~/.dsh/ownshield 下的故障回注登记
        └─ sessionController.prompt(...) → 会话被唤醒 / 收到故障通报
```

没有登记时，唤醒器完全静默，只写一行 `no-pending` 日志。

### 431 启动崩溃与 cookie 清理

Harness 桌面端每次启动都监听随机端口，并下发一个 `dsh-auth-<authority哈希>` cookie。端口变、名字就变，Chromium 只累加不清理；攒到约 70 条时 Cookie 请求头超过 Node 的 16 KB 上限，Host 返回 `431 Request Header Fields Too Large`，外壳只检查 `response.ok`，于是报「Web authentication failed」并退出。

这个库在 Harness 运行期间被独占，唯一可读写的窗口就是「浏览器进程已死、新实例未起」的那几秒。所以每次重启做两件事：

1. `scripts/cookie-cleanup.mjs`：统计 `dsh-auth-*` 条数，达到 `cookieThreshold`（默认 50，约 11 KB）就只删这一族，其它 cookie 与账号凭据不碰；
2. `scripts/cookie-probe.mjs`：记录新实例启动前的 cookie 数量与剩余寿命。

日志形如：

```text
cookie cleanup: authCookies=52 others=38 headerKB=11 threshold=50 action=purged removed=52
cookie snapshot: authCookies=0 ttl=[]
```

要手动清理（例如已经启动不了）：

```powershell
node <包目录>\scripts\cookie-cleanup.mjs "$env:APPDATA\@deepseek-ai\dsh-desktop\Network\Cookies" --dry-run
node <包目录>\scripts\cookie-cleanup.mjs "$env:APPDATA\@deepseek-ai\dsh-desktop\Network\Cookies"
```

手动清理必须**完全退出 Harness**。另一个缓解手段是把 profile 的 `client-connection.cookieMaxAgeDays` 从 30 调到 1，把累积窗口压到单日；插件不替你改这份配置。

---

## 第二部分：本体自愈

### 七项检查

**默认只跑后四项**（工具 / 服务 / 心跳 / 凭据）：零会话、零 token、用户完全无感。前三项会建临时会话，只在传 `deep: true` 时执行，用完自动归档会话并删临时目录。

| 检查 | 动作 | 抓什么 |
|---|---|---|
| `create-session` | 用默认预设创建临时会话，cwd 用系统临时目录 | `agent-preset/invalid`、`agent-preset/not-found`、工具组重复导致建会话失败 |
| `prompt-first-turn` | 向该会话投一条 `probe`，等首轮 settled（默认 60 秒） | 会话建出来但首轮跑不起来、prompt 不被接受 |
| `resume-probe-session` | 对固定探针会话调用 `sessionController.resolveAgent()` | `resume failed`、`session/not-found`、`session/writer-held`、日志损坏 |
| `tool-inventory` | 预期清单 vs `ctx.tools.definitions()` | 工具缺 `output.schema`/`render` 导致整批不注册、`ctx.get` 误用导致工具静默消失 |
| `service-inventory` | 基线服务是否仍可解析 | 服务被禁/改名后插件静默降级 |
| `plugin-heartbeat` | 插件心跳文件是否新鲜 | Host 挂死、心跳停更 |
| `auth-gate` | 凭据文档是否存在 + 近 24h 日志有无 `401/402/429/rejectToken/model-discovery-rejected`（**只读，绝不发模型请求**） | 模型不可用。**ok 恒为 true**，问题只写 `warn`——回滚 asar 对认证问题没有意义 |

每次执行写一份 `~/.dsh/ownshield/probe-<时间戳>.json`：

```json
{
  "ok": false,
  "ts": "2026-11-17T15:30:12.345Z",
  "durationMs": 8421,
  "checks": [
    { "name": "create-session", "ok": true, "error": "", "detail": "sessionId=... preset=default cwd=..." },
    { "name": "prompt-first-turn", "ok": true, "error": "", "detail": "settledMs=... reply=..." },
    { "name": "resume-probe-session", "ok": true, "error": "", "detail": "liveBefore=false status=idle" },
    { "name": "tool-inventory", "ok": false, "error": "缺少预期工具：present", "detail": "expected=12 actual=11 missing=1 extra=0" }
  ]
}
```

### 预期工具清单

默认读 `~/.dsh/ownshield/tool-baseline.json`，两种格式都行：

```json
["read", "write", "edit", "glob", "grep", "ownshield_probe"]
```

```json
{ "tools": ["read", "write", "ownshield_probe"] }
```

文件不存在时 `tool-inventory` 记 `ok: true` 并注明「跳过」。**只检查预期工具是否缺失，不把多出来的新工具算失败**——装了新插件不该让探针变红。

### 环境要求（动手前先对一遍）

| 项 | 要求 | 说明 |
|---|---|---|
| 平台 | **仅 Windows** | 依赖 `schtasks`、`wscript`（隐藏窗口启动器）、PowerShell。macOS / Linux 未实现 |
| Node | **Node.js 22+**，且可执行文件能被探测到 | 探测顺序：`nodePath` 配置 → `OWNSHIELD_NODE` → `DSH_NODE` → `NODE_EXE` → `where node` → 常见安装位置（`%ProgramFiles%\nodejs\node.exe`、`%LOCALAPPDATA%\Programs\nodejs\node.exe`、DSH 自带的 `~/.dsh/dsh-runtimes/.../node.exe`）。**探测不到会明确报错**（`ok:false` + problems），不会静默失败 |
| 权限 | 装插件**不需要管理员** | 启动看护时创建的是**当前用户级**计划任务，不加 `/RU`，不需要提权 |
| 磁盘 | 单次快照约 **200 MB**（去重后按实际 blobs 计） | 快照库默认 `~/.dsh/ownshield/snapshots`（`OWNSHIELD_SNAPSHOTS` 可覆盖）；低于 512 MB 会在 `ownshield_arm` / `ownshield_status` 里告警，低于 2 GB 时看门狗判观测基础设施异常、转人工 |
| 状态目录 | `~/.dsh/ownshield`（`OWNSHIELD_DIR` 可覆盖） | `arm.json` / `boot.json` / `recovery.log` / 生成的 `watch-silent.vbs` / `needs-human.json` 都在这里 |

启动看护时 `arm.mjs` 把**运行时探测到的** node 路径与 `watch.mjs` 绝对路径写进 `<状态目录>\watch-silent.vbs`，计划任务指向这一份；仓库里的同名文件只是注释模板，不再被引用。换机器不需要改任何文件。

### 看护 / 停止看护 / 卸载

**看护**（要改内核时）：

```text
ownshield_snapshot ──建快照──▶ ownshield_arm ──看护──▶ 改内核 ──崩了──▶ 自动回滚/重启/校验/通报
```

**停止看护**：恢复成功会自动停止看护（`arm.json` 移进 `disarm/`）。手工停止看护用 `ownshield_disarm`，或命令行：

```powershell
node <包目录>\scripts\ownshield\arm.mjs disarm --reason manual
```

**卸载**（本插件没有自动卸载）：

```powershell
schtasks /Delete /TN ownshield-watch /F
schtasks /Delete /TN DshRestartWake /F
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\ownshield"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\restart-wake"
```

> 停止看护**不删**计划任务：未在看护时它还每分钟跑一次 cookie 守卫（只读，不持有回滚权）。真正不想让它跑，才执行上面的 `schtasks /Delete`。

### 恢复链怎么判

- 看护期间每分钟跑一次：检查 DSH 主进程、探针或崩溃信号、cookie 是否过期。
- 判定为硬故障就回滚 asar → 重启 Harness → 启动后校验（进程 + 工具清单）→ 成功则停止看护，并把结论回注到原会话。
- **连续失败三次**停手，写 `~/.dsh/ownshield/needs-human.json` 并停止看护——这是设计，不是缺陷。此时先看 `ownshield_status`，处理完再决定要不要重新启动看护。
- cookie 过期是特例：看护状态只重启不回滚（回滚 asar 对登录过期没有意义）；未在看护态由每分钟守卫独立处理，失败退避 10 分钟。

---

## 配置

**默认值即开即用**：可执行文件从运行中的进程自动探测，重启登记在 `~/.dsh/restart-wake`，自愈状态在 `~/.dsh/ownshield`，脚本随包分发。

要改时在 profile 的 `cordis.patch.yml` 里覆盖这一行（`config` 整体替换，但插件对缺失字段回落默认值，只写要改的即可）：

```yaml
- id: restart-wake
  name: dsh-restart-wake
  config:
    pendingDir: 'D:\dsh-wake'
    delaySeconds: 15
```

重启与唤醒：

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `pendingDir` | `~/.dsh/restart-wake` | 唤醒登记、锁、日志、脚本参数的存放目录 |
| `logPath` | `<pendingDir>/wake.log` | 唤醒器与重启日志 |
| `lockPath` | `<pendingDir>/restart.lock` | 重启互斥锁 |
| `exePath` | 自动探测 | Harness 可执行文件；探测失败时必须显式指定 |
| `processName` | 自动推导 | 进程名（不含 `.exe`），用于杀进程与计数；**同时驱动看门狗**（脚本侧通过 `OWNSHIELD_PROC_NAME` 收到同一个值） |
| `scriptPath` | 包内 `scripts/restart-dsh.ps1` | 重启脚本 |
| `commandPath` | 包内 `scripts/run-restart.cmd` | 计划任务入口 |
| `taskName` | `DshRestartWake` | 一次性计划任务名；多份安装要改成不同的名字 |
| `delaySeconds` | `12` | 挂任务后等多久再重启 |
| `launchWaitSeconds` | `8` | 每次启动后等待多久再数进程 |
| `maxLaunchAttempts` | `3` | 启动尝试次数 |
| `graceSeconds` | `8` | 优雅关窗等待秒数 |
| `killTimeoutSeconds` | `20` | 强杀后等待进程消失的上限 |
| `singleInstanceWaitSeconds` | `3` | 等 Electron 单实例锁释放 |
| `lockStaleMs` | `600000` | 超过这个年龄的锁视为失效 |
| `maxAgeMs` | `86400000` | 登记超过这个年龄不投递 |
| `maxAttempts` | `3` | 单条投递重试次数 |
| `retryDelayMs` | `15000` | 重试间隔 |
| `startupDelayMs` | `3000` | 启动后延迟多久开始扫描 |
| `readyTimeoutMs` | `60000` | 等 `sessionController` 可用的上限 |
| `presetsReadyTimeoutMs` | `20000` | 等 Agent 预设注册表就绪的上限（冷 resume 时预设没加载完会丢整套预设工具） |
| `deliverTimeoutMs` | `30000` | 单次投递超时 |
| `cookieDbPath` | 自动探测 | Chromium cookie 库路径 |
| `cookieProbePath` / `cookieCleanupPath` | 包内 `scripts/cookie-*.mjs` | cookie 快照 / 清理脚本 |
| `cookieThreshold` | `50` | `dsh-auth-*` 达到这个条数时重启窗口自动清理 |
| `restartPromptEnabled` | `true` | 是否注入「重启与唤醒」小节 |
| `ownshieldPromptEnabled` | `true` | 是否注入「本体自愈」小节 |
| `promptEnabled` | — | 兼容旧字段：`false` 等价于上面两个都关 |
| `crashLogDir` | 空 | 可选：崩溃日志目录，用于统计杀进程有没有新增渲染崩溃 |
| `keepArchives` | `10` | 失败/过期/重复归档最多保留几个 |
| `maxLogBytes` | `262144` | `wake.log` 超过这个字节数轮转为 `wake.log.1` |
| `timeZone` | `Asia/Shanghai` | 投递 prompt 时带的时区 |

本体自愈：

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `ownshieldDir` | `~/.dsh/ownshield` | 探针结果、`arm.json`、`recovery.log` 的状态目录 |
| `baselinePath` | `<ownshieldDir>/tool-baseline.json` | 预期工具清单 |
| `serviceBaselinePath` | `<ownshieldDir>/service-baseline.json` | 预期服务清单 |
| `heartbeatDir` | `<ownshieldDir>/plugins` | 插件心跳文件目录 |
| `probeSessionPath` | `<ownshieldDir>/probe-session.json` | 固定 resume 的探针会话 |
| `tmpBase` | 系统临时目录 | 临时会话 cwd 的父目录 |
| `probeMessage` | `probe` | 投给临时会话的短消息 |
| `probeTimeoutMs` | `60000` | 创建会话 / 首轮 settled 的超时 |
| `probePollMs` | `500` | 轮询事件日志的间隔 |
| `resumeTimeoutMs` | `30000` | resume 超时 |
| `scriptsDir` | `<pluginDir>/scripts/ownshield`，开发检出回落到 `<repo>/tools/ownshield` | 恢复链脚本位置 |
| `watchTaskName` | `ownshield-watch` | 每分钟一次看门狗的计划任务名 |
| `nodePath` | 空（启动看护时运行时探测） | 写进生成启动器的 node 路径；等价环境变量 `OWNSHIELD_NODE` |

故障回注：

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `injectDir` | `~/.dsh/ownshield` | 回注登记目录（**注意：与重启侧的 `pendingDir` 是两个不同目录**） |
| `injectLogPath` | `<injectDir>/inject.log` | 回注日志 |
| `scanIntervalMs` | `300000` | 启动扫描之后的重扫间隔（5 分钟）；设 `0` 退回只在启动时扫一次 |
| `maxErrorLines` | `20` | 注入消息里保留的错误尾部行数 |
| `maxMessageChars` | `6000` | 注入消息长度上限 |
| `probeGateEnabled` | `true` | 是否启用探针闸（6 小时限流触发一次本体探针，结构性失败写 `probe-failure.json` 供看门狗判硬信号） |
| `probeIntervalMs` | `21600000` | 探针闸间隔（6 小时） |
| `probeStartDelayMs` | `45000` | 探针闸起跑延迟 |
| `requestWatchEnabled` | `true` | 模型请求失败（`401` / `429`）时是否立即注入回会话 |
| `requestWatchCooldownMs` | `600000` | 同一 agent 同一失败码的注入冷却（10 分钟），防 401 循环刷爆会话 |

> `pendingDir` 的路径会影响计划任务命令行长度（上限 260 字符）。路径过长时 `restart_now` 会直接报错并建议换到更短的目录。

---

## 安全边界

- 只投递文本，不执行命令；
- 每条登记最多投递 3 次，失败归档，**绝不无限重试**；
- **成功投递不留文件**（只写日志一行）；失败/过期/重复归档最多保留 10 个；
- 日志超过 256 KB 轮转，目录里最多两个日志文件；
- 登记超过 24 小时自动过期；
- 互斥锁保证同一时刻只有一次重启；
- 默认拒绝在「其他未登记的运行中会话」存在时重启（`force: true` 可覆盖）；
- 重启前校验可执行文件、脚本、计划任务入口，缺一个就**不动手**；
- 探针的失败**不自动触发**任何回滚/重启——刻意划的边界，避免「越修越坏」的自激系统；
- 看门狗只在看护期间持有回滚权，恢复成功自动停止看护，连续失败三次停手交人；
- 回滚对象只有安装目录的 `app.asar`（可选纳入 profile 层），**不碰** `~/.dsh` 下的记忆与会话；
- 不碰凭据、不上传任何数据、不包含任何遥测。

---

## 平台与限制

- **重启与 cookie 清理**：仅 Windows（`schtasks` + PowerShell）。非 Windows 上 `restart_now` 直接报错，不做任何破坏性动作。
- **自愈链**：仅 Windows（`schtasks` + `wscript` + PowerShell）。
- **唤醒与探针工具**：纯 Node，跨平台可用。
- 重启会中断当前回合；未保存的输入会丢失。
- 前提是 Harness 桌面端会恢复上次窗口（默认会）。即使不恢复，登记也不会丢，下次打开会话时补投，只是不再「自动回来」。
- 探针每次新建一个临时会话，这是检测预设装配失败的必经动作。**用完即归档**（DSH 没有删除会话的 Host API，可用的是归档——会话进 `archivedSessionIds`，侧栏默认不显示），同时删掉临时目录；结果文件里的 `cleanup` 字段记录归档与清理实况。定时探针由 Host 直调，**不往用户会话里投递任何消息**。
- 如果同时装了别的「启动即投递」插件并共用同一个登记目录，会重复投递——给它们配不同的 `pendingDir` / `injectDir`。

---

## 故障排查

重启侧：

| 现象 | 检查 |
|---|---|
| `restart_now` 返回 `blocked` | 有别的会话在跑且没登记；等它收尾，或确认可打断后传 `force: true` |
| `restart_now` 返回 `busy` | 10 分钟内已有别人挂了重启任务；等它执行完，不要重复挂 |
| `schtasks /Create` 报「找不到路径」 | 先跑全量 `schtasks /Query /FO LIST` 判断是权限还是任务不存在，别把「任务不存在」误读成被拦 |
| 日志停在 `killing` | 脚本被 Job Object 连带杀了：确认是计划任务在执行，不是从 Harness 内 `Start-Process` |
| 日志停在 `attempt N : running processes = 0` | 启动失败：手动双击 Harness，查 `RESULT: FAILED` 附近的 throw 信息 |
| 重启后有 Windows 报错音 | 杀进程顺序错了：必须**先杀浏览器主进程**，再杀子进程 |
| 醒来后没有收到 prompt | 看 `wake.log`：`delivered` = 成功；`controller-unavailable` = 会话服务没就绪；`expired` = 登记过期 |

自愈侧：

| 现象 | 先看什么 | 处置 |
|---|---|---|
| 计划任务存在但「什么都没发生」 | `ownshield_status`：任务是否存在、启动器是否存在、node / exe 解析结果、磁盘剩余 | 启动器丢失就重新启动看护（会重新生成）；任务被禁用就 `schtasks /Run /TN ownshield-watch` 试跑一次，看 `recovery.log` 末尾 |
| 找不到 Node | `ownshield_arm` 返回 `ok:false`，problems 里有「找不到 Node」 | 装 Node.js 22+，或设 `nodePath` / `OWNSHIELD_NODE` 指向 `node.exe`。**不会静默失败** |
| 找不到 DSH 可执行文件 | `ownshield_status` 的 exe 解析来源 | 设 `OWNSHIELD_EXE`，或在 `arm.json` 里写 `exePath` |
| 快照库在旧路径 | `ownshield_status` 的告警行 | 把快照目录搬到 `~/.dsh/ownshield/snapshots`（或设 `OWNSHIELD_SNAPSHOTS`） |
| 看护被拒（退出码 3） | problems 逐项：快照不存在 / 快照闸拒绝 / 没有 DSH 主进程 / 找不到 Node | 逐项修；快照闸拒绝通常意味着 DSH 升级过，旧快照回滚会降级，先重建快照 |
| 连续失败三次后停手 | `~/.dsh/ownshield/needs-human.json` | 这是设计（熔断交人）：读文件里的原因，人工处理后再重新启动看护 |

---

## 目录与开发

```
index.js                     宿主插件入口（三块启动钩子 + 11 个工具 + 注入段）
lib/config.js                重启侧配置、可执行文件与 cookie 库探测
lib/config-ownshield.js      自愈侧配置（探针与恢复链）
lib/config-inject.js         回注侧配置
lib/pending.js               唤醒登记文件
lib/pending-inject.js        故障回注登记文件
lib/wake.js                  启动唤醒循环
lib/restart.js               互斥锁、会话检查、计划任务、日志
lib/inject.js                启动回注循环
lib/message.js               故障通报文本拼装
lib/probe-gate.js            探针闸（6 小时限流）
lib/request-watch.js         模型请求失败即注入
lib/cookie.js                cookie 库只读检查
lib/prompt.js                内置协议提示（两小节）
lib/tools.js                 重启侧 6 个工具
lib/tools-ownshield.js       自愈侧 5 个工具
lib/probe.js                 探针（默认静态四项；deep 才建会话）
lib/auth-gate.js             凭据文档与登录日志只读检查
lib/node-runtime.js          node.exe 探测
lib/util.js                  共用小工具
scripts/restart-dsh.ps1      参数化重启脚本（纯 ASCII）
scripts/run-restart.cmd      计划任务入口
scripts/cookie-cleanup.mjs   重启窗口内的 cookie 清理
scripts/cookie-probe.mjs     cookie 快照
scripts/ownshield/           恢复链运行期脚本：arm / asar / debride / snapshot / watch
docs/restart-protocol.md     给 Agent 看的重启协议
```

`scripts/ownshield/` 只带**运行期闭包**（5 个）加两个可自验的测试（`watch.test.mjs`、`cookie-guard.test.mjs`）。开发目录 `tools/ownshield/` 里的验收脚本、演练脚本、取证工具（`acceptance.mjs`、`drill-a4.mjs`、`probe-matrix.mjs`、`secure.mjs`、`plugin-check.mjs` 等）**不进发布包**——它们依赖本机工作区路径与源包，对使用者没有意义。

> 改包内 `scripts/ownshield/*.mjs` 之前先改 `tools/ownshield/` 的同名文件再复制过来，否则两边会漂移。

### 测试

```powershell
node test/smoke.mjs                          # 重启侧，离线
node test/ownshield-smoke.mjs                # 自愈侧工具，离线
node test/inject/smoke.mjs                   # 回注侧，离线
node test/inject/probe-gate.test.mjs
node test/inject/request-watch.test.mjs
node scripts/ownshield/watch.test.mjs        # 看门狗 38 项
node scripts/ownshield/cookie-guard.test.mjs # cookie 守卫 7 项
```

全部离线：用假 Cordis 上下文、桩 `sessionController` 与桩工具注册表驱动真实的 `apply()` 和 `execute()`。恢复链测试只碰临时目录，不动真实安装。

> 不要用 `node --test <文件>` 跑这些测试——它会再 spawn 一层进程，在受限沙箱下会 EPERM。直接 `node <文件>` 是权威结果。

## 兼容性

| 项 | 值 |
|---|---|
| 实测 DSH | `0.2.2-rc.2`（Windows，Node 24.21.0） |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 依赖 | 仅 Node 内置模块 |
| 构建 | 无 |

## 许可

MIT
