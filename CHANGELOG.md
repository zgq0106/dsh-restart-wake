# Changelog

## 2.1.0 (2026-11-22)

- **恢复校验看「模型能不能用」**（2026-11-22）：`verifyAfterRestart` 增加 `model-unusable` —— 只认**本次重启之后**的纸条记录（`activity.json`，用 `since` 排除旧账）：有成串失败且零成功则判失败，不再因为「进程在、没新 crash log」就报成功；无流量则记 `+model-unverified`，不阻塞。
- **熔断改挂起**（2026-11-22）：连续失败到阈值后不再撤防，`needs-human.json` 照写、自动修复停手，但 `arm.json` 保留继续观察；纸条出现成功操作即自动停止看护（`suspend-release`）。依据：模型能继续工作时，现场该交给它自己修。
- **`ownshield_probe` 默认静态化**（2026-11-22）：默认只跑工具 / 服务 / 心跳 / 凭据四项（零会话、零 token、用户完全无感）；`create-session` / `prompt-first-turn` / `resume-probe-session` 只在 `deep: true` 时执行。原有探针测试全部改传 `deep: true`，并新增「默认不建会话」断言。定时探针（probe-gate）直调因此也变轻量。
- **纸条即探针：用真实工作痕迹判定「跑不动」**（2026-11-22）：新增 `lib/activity-watch.js`——订阅每个 agent 的 `session/event`（`tool/result`、`turn/end`、`assistant/message`）与 `agent/request-error`，把最近 50 条成功/失败落到 `~/.dsh/ownshield/activity.json`。看门狗新增硬信号 `activity-failed`：**窗口内 ≥3 次失败且 0 次成功**才报警；有一次成功就算能用，零流量不下结论（空闲不等于坏了）。
  这样做的好处：测的是用户真实在用的预设与工具集、零额外会话、零额外 token、用户完全无感；模型一出问题当场就有记录，不用等探针窗口。主动探针因此从「主检测」降为「手动/兜底」。
  新增测试：`test/activity-watch.test.mjs`（6 项，判定与截断）、`watch.test.mjs` 增加 `activity-failed` 三项边界。
- **探针用完即清**（2026-11-22）：探针会话探测完调 `workspaceRegistry.archiveSession(..., { stopActivity: true })` 归档（侧栏默认不显示），并删除 `mkdtemp` 的临时目录；`probe-*.json` 里的 `cleanup` 字段记录实况。定时探针改为 Host 直调，不再往用户会话投递自检指令。
- **L3：profile 层还原**（2026-11-22）：看护链在 L2 之后增加一级——只还原 `cordis.patch.yml`、预设目录、`package.json` 与 `link:` 关系，**不碰 `app.asar`**。
  `snapshot.mjs` 新增 `--profile-only`（隐含 `--with-profile`）；`arm.mjs` 检测到快照带 profile 层时自动把 `arm.json` 的 `maxLevel` 提到 3 并写 `profileTag`；L3 跳过 asar 哈希闸（它本来就不动 asar）。
  不包含 `node_modules` 实体、会话、记忆、凭据——这几类不进任何快照。
  新增测试 `test/profile-layer.test.mjs`（3 项）：只还原 profile 且 asar 不动、原件留 `.bak-` 备份；asar-only 快照明确拒绝；manifest 能识别 profile 层。
  这一级解决的是「根因在 profile 层、回滚 asar 无效 → 三次熔断」那个缺口。

## 2.0.0 (2026-11-21)

三个包并成一个：本包现在同时提供**重启/唤醒**、**本体自愈**与**故障回注**。
一条安装命令、一个版本号、11 个 Agent 工具、1 段注入提示。

**破坏性变更（升级前必读）**

- 本包**取代** `dsh-ownshield`（0.1.0）与 `dsh-ownshield-inject`（0.1.0）。
  升级必须**先卸掉这两个旧包**，并清掉 profile `cordis.patch.yml` 里它们各自的 `insert` 行；
  否则同一个工具会被注册两次（重名注册的后果取决于 DSH 的注册实现），自愈提示也会出现两遍。
- 配置字段改名（仅回注侧，语义冲突）：`pendingDir` → `injectDir`，`logPath` → `injectLogPath`。
  状态目录不变，仍是 `~/.dsh/ownshield`，老用户历史文件原地可读。
- 提示开关拆成两个：`restartPromptEnabled` / `ownshieldPromptEnabled`（都缺省 `true`）。
  旧字段 `promptEnabled: false` 仍然有效，等价于两者都关。
- 自愈判定、回滚、快照闸、cookie 守卫等运行逻辑**一行未改**；工具名、参数与描述**一字未改**。

**修复（0.1.6 之后一直未发布，随 2.0 首次发出）**

- **冷唤醒时预设注册表竞态**：`startWakeLoop` 投递前现在会等 `agentPresets.resolve()` 就绪
  （新增 `awaitPresetsReady()` 与 `presetsReadyTimeoutMs`，默认 20 s）。原先在 19-bundle 的
  profile 上，重启后唤醒的会话会以**无预设**挂载，工具从 94 个掉到 35 个，shell / 文件 / 记忆
  全部消失（2026-11-19 实测）。超时仍照常投递并写日志，不阻断。
- 对应新增测试：`test/smoke.mjs` 的 `awaitPresetsReady waits for a late preset registry`。
- **清创（debride）的安装目录禁区写死了开发机路径**：安装根原先由一个硬编码的可执行文件路径推导，
  在别人的机器上会推出一个不存在的目录，禁区保护因此落空（等于没护住真正的安装目录）。
  现改为 `OWNSHIELD_ASAR` → `OWNSHIELD_EXE` → 运行中进程 → 常见安装位置逐级探测
  （复用 `arm.mjs` 的 `resolveInstalledExe`），**探测到的位置与全部常见位置一起列入禁区**，
  宁可多禁不漏禁；且做成惰性求值，不拖慢每分钟运行的看门狗。
- **清创在插件运行期会被自己的 state 白名单拦住**：`watch.mjs` 传给清创的 root 是
  `<状态目录>/quarantine`（生产即 `~/.dsh/ownshield/quarantine`），而 `debride` 的 state 白名单
  默认只认本模块所在根。现由 `watch.mjs` 在调用前把该目录写进 `OWNSHIELD_STATE_ALLOW` 显式加白，
  与设计约定一致；`debride` 默认拒绝写 `~/.dsh` 的边界保持不变（隔离、回滚、病历相关 23 项测试仍全绿）。
- **主动重启会被看门狗误判成崩溃**（合包后才可能撞上）：`restart_now` 现在在调度前给
  `arm.json` 打 `expectGracefulExit` 标记（`lib/arm-bridge.js`）。看门狗判崩溃只有「拿到
  退出码 0」这一条自证路径，而杀进程拿不到退出码；于是「旧进程已死、新进程未起」那十几秒里
  跑的那一轮会把主动重启判成崩溃 → 回滚 + 把看护态一起吃掉，恰好发生在我们最需要它安静的时候。
  调度失败会回滚标记，否则下一次**真崩溃**会被当成正常退出而不救。
- **假看护零告警**：`arm.mjs` 先写 `arm.json` 再建计划任务，建失败时 `arm.json` 会残留，
  而 `ownshield_status` 仍报 `ok:true`——「看起来已在看护、实际没人盯」比没看护更危险。
  现在任务创建失败会把 `arm.json` 移入 `failed/` 留档；`status` 增加一致性判定
  （已在看护但任务或启动器缺失 → `ok:false` 并写明原因），`ownshield_status` 在首行打 `⚠`。
- **重复看护静默覆盖回滚点**：`arm()` 默认拒绝覆盖既有 `arm.json`（返回退出码 3 并说明），
  需显式 `replace: true`；同一 tag 的重复调用按幂等放行。两个会话各自建快照时不再互相顶掉。
- **恢复后只有通报、没有续跑**：`will.mjs`（遗嘱）与 `resume-prompt.mjs`（`[还魂]` 消息）
  此前只在开发目录、未接入运行期。现在随包分发，`watch.mjs` 恢复成功时若有遗嘱就投递
  「[还魂] 我在…因…中断 / 中断前的目标 / 已完成 / 下一步 / 工具集指纹」；没有遗嘱如实降级为
  事后通报，绝不编造续跑内容。
- **`restart_status` 增加自愈视图**：合包后一个工具就能看到「现在重启会不会被看门狗当成崩溃」
  （`ownshield.armed / tag / expectGracefulExit`），不用先去问另一个工具。
- **主动重启标记没有失效机制**（2026-11-22 真机当场发现并修）：`restart_now` 打完
  `expectGracefulExit` 后，如果看门狗那一轮跑的时候新进程已经起来，`resolveBoot` 会重建 boot、
  判 `signals=none`，既不走 graceful-exit 也不停止看护——标记就永久留在 `arm.json` 里，之后
  **真崩溃**会被当成正常退出而不救，比不打标记更危险。现在标记带 `expectGracefulExitAt`
  时间戳，只在 10 分钟窗口内算数；看门狗建起新 boot 后主动清除，过期标记也清。
  没写时间戳的标记一律不认（人工声明正常退出请用 `autoGracefulExit: "no-crash-evidence"`）。
- **快照库只长不缩**：`snapshot.mjs` 新增 `prune`（`--keep N` / `--keep-tag` / `--dry-run` / `--json`）。
  快照库没有自动 GC，asar 每变一次就多一份约 200 MB 的 blob，此前只能靠人工判断该删哪份、删了
  目录还收不回空间。现在：`arm.json` 引用的 tag 与 `--keep-tag`（默认 `baseline`）**永不删除**，
  其余按时间保留最近 `--keep` 份（默认 3），最后只用**删完之后剩余的** manifest 建引用集合、
  回收孤儿 blob——宁可少删一个孤块，也不删错一个活块。`ownshield_status` 在快照超过 5 份时提示可清理。
- **术语统一**：面向用户的措辞由「武装 / 撤防」改为「看护 / 停止看护」。工具名 `ownshield_arm` /
  `ownshield_disarm`、状态文件 `arm.json`、归档目录 `disarm/` 保持不变（`arm`/`disarm` 是标准术语，
  改名会破坏兼容）。
- **文档补充能力边界**：README 新增「能救什么，不能救什么」一节——能救的五类标注实测时延
  （崩溃 ≤60 s、挂死 2–3 min、跑不动最长 6 h、cookie ≤1 min、救回约 22 s），救不了的六条明写
  （未看护一律不救、只回滚 `app.asar`、未知形态三次熔断、哈希闸拒绝回滚、无信号盲区、
  「原地」其实换的是新进程）。「原地复活」指内核层可回滚的坏，不指任何故障。
- **多会话改内核时能看到持有者**：`ownshield_status` 与 `restart_status` 显示发起看护的会话，
  被挡住的一方不用猜该等谁。

**新增**

- `lib/config-ownshield.js` / `lib/config-inject.js` / `lib/tools-ownshield.js` /
  `lib/pending-inject.js`：分别搬自 `dsh-ownshield` 与 `dsh-ownshield-inject`，只改导入与导出名。
- `scripts/ownshield/`：恢复链的**运行期闭包**随包发布（`arm.mjs` / `asar.mjs` / `debride.mjs` /
  `snapshot.mjs` / `watch.mjs`），外加两个可自验测试 `watch.test.mjs`（38 项）与
  `cookie-guard.test.mjs`（7 项）。验收、演练、取证类脚本（`acceptance.mjs`、`drill-a4.mjs`、
  `probe-matrix.mjs`、`secure.mjs`、`plugin-check.mjs`、各 `*.test.mjs` 等 30 个）留在开发目录，
  不进包——它们引用本机工作区路径与源包目录，对使用者无意义。
- `test/ownshield-smoke.mjs`、`test/inject/*.test.mjs` 随之入包；`npm test` 依次跑四套。
- `scripts/ownshield/vendor/` **不进包**：`doctor.mjs` 只被开发工具 `plugin-check.mjs` 使用，
  而该工具本身不留；同目录的 `snapshot-engine.mjs` / `redact-vault.mjs` / `zip-export.mjs`
  三个实验模块经核查**没有任何调用者**，同样留库。运行期不需要 vendor 下任何文件。
- `cookie-guard.test.mjs` 的 auth-gate 引用改为按布局解析：包内走 `../../lib/auth-gate.js`，
  开发目录回落 `../../dsh-ownshield/lib/auth-gate.js`。此前写死开发路径，用户装包后跑包内测试会红。
- `README.md` / `README.en.md` / `locale/*.json` 合并重写：首屏声明本包取代两个旧包、升级须先卸旧包。

## 0.1.6 (2026-11-12)

适配 DSH 0.2.2-rc.2 的 Schedule 工具改名。

DSH 0.2.2-alpha.2 移除了 `schedule_update` 与 `schedule_delete`，统一改用 `schedule_edit`（`action: "update" | "delete"`），`schedule_create` 也不再接受 `after_seconds`、`at`、`daily` 等时间选择参数，改为必填 `rrule`（两行 `DTSTART` + `RRULE`）与 `target`。本插件注入的文本此前仍在教模型调用已删除的工具。

- **协议提示改写**：`lib/prompt.js` 的重检提醒改为 `schedule_create({ title, prompt, target: "this_session", rrule })`，清理改用 `schedule_edit({ id, action: "delete" })`。
- **唤醒清理提示改写**：`WAKE_CLEANUP_NOTE`（`lib/wake.js`）同步改为 `schedule_edit`。
- **文档同步**：`docs/restart-protocol.md` 的「先清提醒再重启」一节更新工具名与 rrule 写法。
- **测试收紧**：断言提示文本包含 `schedule_edit` 且**不再包含** `schedule_delete`，防止残留旧名回归。
- **声明适配范围**：`engines.dsh` 设为 `>=0.2.2-alpha.2`，低于该版本会被兼容性检查拒绝安装；`dsh.compatibility.dshReleases` 记 `0.2.2-rc.2` 实测。旧版 DSH 请继续用 v0.1.5——它指向的 `schedule_delete` / `after_seconds` 在 0.2.2 起已不存在。

## 0.1.5 (2026-11-04)

插件自己管理文件生命周期，用户永远不需要清理残留。

- **成功投递不留文件**：投递成功直接删除登记，只在日志留一行 `delivered`；`wake-done-*` 不再产生。
- **异常归档有上限**：失败/过期/重复归档只保留最近 `keepArchives`（默认 10）个，启动时自动删更早的；旧版本遗留的 `wake-done-*` 也会在启动时清掉。
- **日志轮转**：`wake.log` 超过 `maxLogBytes`（默认 256 KB）轮转为 `wake.log.1`，目录里最多两个日志文件。
- 测试增至 25 项。

## 0.1.4 (2026-11-04)

把重检提醒的清理做成闭环：未触发的和已触发的都要删掉。

- **记 id**：`schedule_create` 时记下返回的 id。`schedule_delete` 对 active / inactive 都有效，但 `schedule_list` 只列未触发的，所以 id 是唯一能删到「已结束记录」的把手。
- **走前删**：确定可以重启时先 `schedule_delete(id)` 再 `restart_now`。
- **醒来也删**：每次唤醒投递的 prompt 末尾追加一段清理提示（`WAKE_CLEANUP_NOTE`），要求会话先按 id 删掉自己的重检提醒再继续。这样「等待中、被别人唤醒」的会话也会清干净。
- 重检提醒的默认间隔定为 **5 分钟**（300 秒），较急时可缩短到 60 秒。
- 测试增至 23 项。

## 0.1.3 (2026-11-04)

补上「等待-重检」流程里两个实测暴露的漏洞。

- **进入等待先写唤醒文件**：提示与协议文档现在明确要求，被阻塞时先 `wake_register` 再挂重检提醒。只挂提醒不登记的话，别人触发重启时不会叫醒你。
- **重检通过先清提醒再重启**：`schedule_list` → `schedule_delete` 删掉本次重检提醒 → 再 `restart_now`，否则旧提醒会在重启后再次触发（可能引发二次重启）。
- `docs/restart-protocol.md` 同步更新等待与重检两节。

## 0.1.2 (2026-11-04)

让**没有自己记忆的 Agent** 也能正确使用重启：协议提示随插件注入，不再依赖调用方是否读过文档。

- **新增内置协议提示**：通过 `ctx.systemPrompt.section()` 在 Host 根作用域注册一段说明，所有经过该 profile 的 Agent 每一步都会看到——何时该重启、`restart_now` 必须是本轮最后一步、重启后先 `restart_status` 验收再继续。
- 可用 `promptEnabled: false` 关闭（例如你已经把同样的规则写进了自己的预设）。
- **修复**：登记文件带 UTF-8 BOM 时被误判为损坏（`readTask` 先剥 BOM），手工编辑的登记不再被归档成 `wake-failed-*`。
- **工具描述**：`restart_now` 明确「调用方自己不算阻塞」，避免把自身误判成阻塞方。
- 测试增至 22 项，覆盖提示内容与开关默认值。

## 0.1.1 (2026-11-04)

补上 431 启动崩溃的治理：cookie 清理从「人工完全退出后手动跑」变成重启窗口内自动执行。

- **新增 `cookie_status` 工具**（第 6 个）：报告 `dsh-auth-*` 条数、估算请求头大小与清理阈值。
- **新增 `scripts/cookie-cleanup.mjs`**：只删 `dsh-auth-%`，不碰其它 cookie 与账号凭据；`--dry-run` / `--auto` / `--threshold=N` 三种模式；输出单行 ASCII，失败永不阻塞重启。
- **重启脚本自动清理**：在「浏览器进程已死、新实例未起」的唯一可读写窗口里，先清理再快照；默认阈值 50 条（约 11 KB，上限 16 KB）。
- **`cookieDbPath` 默认自动探测** Desktop 的 Cookies 库，开箱即用。
- 文档新增「431 启动崩溃与 cookie 清理」章节；测试增至 20 项，覆盖清理脚本的缺失库与工具返回。

## 0.1.0 (2026-11-04)

首个公开版本，把一套已在真实使用中验证过的重启 + 唤醒流程打包成插件。

- **五个 Agent 工具**：`restart_now` / `wake_register` / `wake_list` / `wake_cancel` / `restart_status`；会话 id 从工具执行上下文自动读取。
- **启动唤醒器**：Host 启动后扫描 `wake-pending-*.json`，通过 `sessionController.prompt` 投递并自动 resume 冷会话；每个会话一个文件，多个会话可同时唤醒。
- **参数化重启脚本**：先杀浏览器主进程（避免崩溃弹窗与报错音）、等待单实例锁释放、启动重试、写 `RESULT: OK / FAILED`、自动删除一次性计划任务；配置全部从 JSON 读入，脚本保持纯 ASCII。
- **重启互斥锁**：同一时刻只允许一次重启；10 分钟未更新的锁视为失效。
- **阻塞会话检查**：默认拒绝在其他未登记的运行中会话存在时重启，可 `force` 覆盖。
- **可选诊断**：cookie 寿命快照、渲染崩溃报告计数。
- **文档**：`docs/restart-protocol.md` 给出 Agent 侧的决策顺序与全部已知坑位。
- **测试**：18 项离线冒烟测试（`npm test`）。
