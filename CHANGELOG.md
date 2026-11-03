# Changelog

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
