# 发布到 GitHub

本包已按可发布状态整理完毕。下面每一步都有可验证的完成信号。当前版本 **2.0.0**。

## 0. 发布前自查

```powershell
cd E:\HarnessWorkRoom\dsh-restart-wake
node --check index.js
npm test                            # 应为 5 套全绿：28 / 24 / 28 / 13 / 7
node scripts/ownshield/watch.test.mjs        # 38 passed, 0 failed
node scripts/ownshield/cookie-guard.test.mjs # 7 passed, 0 failed
npm pack --dry-run --json --cache E:\HarnessWorkRoom\tmp\npm-cache
```

`npm pack` 应列出 **46 个文件 / 约 627 KB**，包含 `index.js`、`lib/`（19 个）、`scripts/`（恢复链 7 个 + 重启 4 个）、`test/`（5 个）、`docs/`、`locale/`、`icon.svg`；**不得包含** `node_modules`、`tools/`、`scripts/ownshield/vendor/`、日志或 `tmp/`。

### 2.0.0 额外的发布前核对

- [ ] `scripts/ownshield/` 的 7 个文件与开发目录 `tools/ownshield/` 同名文件 **sha256 逐个一致**
- [ ] 包内**没有任何** `E:\HarnessWorkRoom` 字样的绝对路径（含注释与示例）
- [ ] `package.json` 的 `version` 与 `CHANGELOG.md` 顶部段落一致
- [ ] `README.md` 首屏仍有「升级须先卸两个旧包」的警示块

## 1. 建仓库

1. 打开 <https://github.com/new>。
2. 仓库名：`dsh-restart-wake`（必须与 `package.json` 的 `name` 一致）。
3. Description：

   ```text
   Restart DeepSeek Harness safely, wake the conversation afterwards, and keep a rollback net while editing the core — restart protocol, core probes, asar snapshots, a watchdog that rolls back and restarts, and failure re-injection.
   ```

4. 选 **Public**。
5. **不要**勾 Add a README / .gitignore / license（本地已有，勾了会冲突）。

完成信号：看到空仓库页和 `…or push an existing repository from the command line`。

## 2. 上传代码

### 路线 A：Git for Windows（推荐，便于持续更新）

```powershell
winget install --id Git.Git -e --source winget
```

装完**关掉终端再开新的**，然后：

```powershell
cd E:\HarnessWorkRoom\dsh-restart-wake
git init -b main
git add .
git commit -m "feat: 2.0.0 — merge core self-healing into the restart plugin"
git remote add origin https://github.com/zgq0106/dsh-restart-wake.git
git push -u origin main
```

首次推送用 Personal Access Token 当密码（GitHub 不再接受账号密码）。

### 路线 B：网页上传

1. 空仓库页点 **uploading an existing file**。
2. 拖入包目录的文件。**开「查看 → 隐藏的项目」**，否则会漏 `.gitignore`。
3. Commit message：`feat: 2.0.0 — merge core self-healing into the restart plugin`。

完成信号：仓库根目录能看到 `package.json`、`index.js`、`lib/`、`scripts/`。

## 3. 仓库门面

- About → Description 填第 1 步那句话；
- Topics（每个回车）：`dsh-plugin`、`deepseek-harness`、`dsh`、`cordis`、`restart`、`session`、`agent`、`windows`、`automation`、`self-healing`、`watchdog`、`rollback`、`snapshot`。

`dsh-plugin` 是社区目录的硬性要求，不能漏。

## 4. 版本标签与 Release

```powershell
git tag v2.0.0
git push origin v2.0.0
```

网页 → Releases → Draft a new release → 选 `v2.0.0` → 描述抄 `CHANGELOG.md` 的 2.0.0 段（**务必保留「破坏性变更：本包取代 dsh-ownshield 与 dsh-ownshield-inject，升级须先卸旧两包」那一段**）→ Publish。

网页上传路线等价做法：Draft a new release → Choose a tag 输入 `v2.0.0` → Create new tag on publish。

## 5. 验证别人真能装

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

1. 重启 Harness；
2. 插件管理页应出现「重启唤醒 + 本体自愈」条目与图标；
3. 新会话问 Agent「你有哪些 restart_、wake_ 或 ownshield_ 开头的工具」，应看到 **11 个**；
4. 调用 `restart_status`，应报出可执行文件路径与脚本状态；
5. 调用 `ownshield_status`，应报出武装状态、计划任务是否存在、快照库路径。

### 从 dsh-ownshield 迁移的真机验证

1. 在已装 `dsh-ownshield` 的 profile 里，先按 README 首屏卸掉 `dsh-ownshield` 与 `dsh-ownshield-inject`；
2. 装本包并重启；
3. 启动日志里**不应出现**重复工具标识告警；
4. 注入段应只有一段，含「重启与唤醒」「本体自愈」两个小节。

## 6. 提交到社区目录（可选）

- `kejixiaoliang/awesome-dsh-plugins` → 分类 **Developer Tools / 开发工具**，加一行：

  ```markdown
  - [dsh-restart-wake](https://github.com/zgq0106/dsh-restart-wake) — 让 Agent 安全重启 Harness 并自动唤醒原会话；改内核前建快照并武装看门狗，崩了自动回滚重启校验；11 个工具
  ```

- `awesome-deepseekharness/awesome-deepseek-harness` → **🧩 Tools, Workflows & Presets**，同时改 `README.md` 与 `README.zh.md`。
- OpenClaw / DSH 官方 Discussions 发一条带截图的使用贴。

提交前先在该分类文件里搜 `zgq0106`，确认没有重复。

## 7. 发布后检查清单

- [ ] `package.json` 的 `name` 与仓库名一致
- [ ] `version` 为 `2.0.0`，`CHANGELOG.md` 顶部有对应段落
- [ ] LICENSE MIT，`license` 字段也是 MIT
- [ ] `v2.0.0` tag 与 Release 可打开，Release 描述含升级须知
- [ ] `dsh-plugin` 等 topics 已设
- [ ] 全新 profile（或另一台机器）实测安装 + 重启后 11 个工具可见
- [ ] 已有 `dsh-ownshield` 的 profile 按升级须知操作后无重复工具告警
- [ ] README 里没有本机私有路径、内网地址、凭据
- [ ] `scripts/ownshield/` 里没有指向 `E:\HarnessWorkRoom` 的绝对路径
