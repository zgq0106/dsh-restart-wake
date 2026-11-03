# 发布到 GitHub

本包已按可发布状态整理完毕。下面每一步都有可验证的完成信号。

## 0. 发布前自查

```powershell
cd E:\HarnessWorkRoom\dsh-restart-wake
node --check index.js
node test/smoke.mjs                 # 应为 18 passed, 0 failed
npm pack --dry-run --json --cache E:\HarnessWorkRoom\tmp\npm-cache
```

`npm pack` 应列出 **20 个文件**，包含 `index.js`、`lib/`、`scripts/`、`docs/`、`locale/`、`icon.svg`，且没有 `node_modules` 或日志。

## 1. 建仓库

1. 打开 <https://github.com/new>。
2. 仓库名：`dsh-restart-wake`（必须与 `package.json` 的 `name` 一致）。
3. Description：

   ```text
   Restart DeepSeek Harness safely and wake sessions automatically afterwards — agent tools, startup wake registry, mutex-guarded restart protocol.
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
git commit -m "feat: initial release 0.1.0"
git remote add origin https://github.com/zgq0106/dsh-restart-wake.git
git push -u origin main
```

首次推送用 Personal Access Token 当密码（GitHub 不再接受账号密码）。

### 路线 B：网页上传

1. 空仓库页点 **uploading an existing file**。
2. 拖入包目录的文件。**开「查看 → 隐藏的项目」**，否则会漏 `.gitignore`。
3. Commit message：`feat: initial release 0.1.0`。

完成信号：仓库根目录能看到 `package.json`、`index.js`、`lib/`、`scripts/`。

## 3. 仓库门面

- About → Description 填第 1 步那句话；
- Topics（每个回车）：`dsh-plugin`、`deepseek-harness`、`dsh`、`cordis`、`restart`、`session`、`agent`、`windows`、`automation`。

`dsh-plugin` 是社区目录的硬性要求，不能漏。

## 4. 版本标签与 Release

```powershell
git tag v0.1.0
git push origin v0.1.0
```

网页 → Releases → Draft a new release → 选 `v0.1.0` → 描述抄 `CHANGELOG.md` 的 0.1.0 段 → Publish。

网页上传路线等价做法：Draft a new release → Choose a tag 输入 `v0.1.0` → Create new tag on publish。

## 5. 验证别人真能装

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

1. 重启 Harness；
2. 插件管理页应出现「重启唤醒」条目与图标；
3. 新会话问 Agent「你有哪些 restart_ 或 wake_ 开头的工具」，应看到 5 个；
4. 调用 `restart_status`，应报出可执行文件路径与脚本状态。

## 6. 提交到社区目录（可选）

- `kejixiaoliang/awesome-dsh-plugins` → 分类 **Developer Tools / 开发工具**，加一行：

  ```markdown
  - [dsh-restart-wake](https://github.com/zgq0106/dsh-restart-wake) — 让 Agent 安全重启 Harness 并在重启后自动唤醒原会话：5 个工具 + 启动唤醒器 + 互斥锁重启协议
  ```

- `awesome-deepseekharness/awesome-deepseek-harness` → **🧩 Tools, Workflows & Presets**，同时改 `README.md` 与 `README.zh.md`。
- OpenClaw / DSH 官方 Discussions 发一条带截图的使用贴。

提交前先在该分类文件里搜 `zgq0106`，确认没有重复。

## 7. 发布后检查清单

- [ ] `package.json` 的 `name` 与仓库名一致
- [ ] LICENSE MIT，`license` 字段也是 MIT
- [ ] `v0.1.0` tag 与 Release 可打开
- [ ] `dsh-plugin` 等 topics 已设
- [ ] 全新 profile（或另一台机器）实测安装 + 重启后 5 个工具可见
- [ ] README 里没有本机私有路径、内网地址、凭据
