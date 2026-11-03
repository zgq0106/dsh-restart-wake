# Changelog

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
