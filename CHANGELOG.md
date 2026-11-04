# Changelog

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
