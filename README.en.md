# dsh-restart-wake

**Restart DeepSeek Harness safely, come back to the same conversation afterwards, and keep a rollback net while you edit the core.**

One package, eleven Agent tools, one set of startup hooks: restart & wake, core probes, snapshots with a watchdog, and failure re-injection.

- Package: `dsh-restart-wake`
- Version: **2.0.0**
- Platform: **restart, cookie cleanup and the self-healing chain are Windows-only**; wake-up, registration and status queries are cross-platform
- Dependencies: none (Node built-ins only)
- DSH: requires **≥ `0.2.2-alpha.2`**; tested on `0.2.2-rc.2`

> ## ⚠️ Upgrading from 0.1.x: uninstall the two old packages first
>
> 2.0.0 merges the former **`dsh-ownshield`** (probes, snapshots, arming) and **`dsh-ownshield-inject`** (failure re-injection, probe gate, request watch).
>
> Steps: ① remove `dsh-ownshield` and `dsh-ownshield-inject` from the profile's `dsh.profile.bundles`; ② drop their two `dependencies` entries; ③ install or update this package; ④ restart Harness.
>
> **Installing without uninstalling registers each `ownshield_*` tool twice**, which produces duplicate-identifier errors and can fail the whole tool group. Tool names and behaviour are unchanged in 2.0 — only the provider changed.

---

## What it solves

### 1. Restart & wake

Editing `src/`, `package.json`, `cordis.patch.yml` or an installed plugin requires a Host restart. Making Harness restart itself runs into three physical obstacles:

| Obstacle | Symptom | Cause |
|---|---|---|
| Launching the restarter from inside Harness | Log stops at `killing` and never returns | Harness puts child processes in a Windows Job Object; killing Harness kills the script |
| Relaunching immediately after the kill | The new instance quits on start | The Electron single-instance lock is still held; the new instance hands its arguments to the dying one |
| Nobody notifies the session afterwards | The conversation just sits there | The script runs outside the process and cannot reach a conversation at startup |

This package: runs the restart through a **Task Scheduler job** outside the process tree → **kills the browser main process first, then its children**, and waits for the single-instance lock → writes the "what to do when you wake up" entry to a file before restarting, and a **startup waker** delivers it through `sessionController.prompt` (which resumes cold sessions).

### 2. Core self-healing

Some failures never write a crash log: Harness starts, the UI works, but creating a session throws `Duplicate tool group identifier: outbound`, or new sessions fail with `agent-preset/invalid` and old ones with `resume failed`. These surface only as RemoteErrors on the client. Nobody watching "process alive / no crash log" will ever see them.

| Face | Tools | What it does |
|---|---|---|
| Probe (always available) | `ownshield_probe` | Detect only: create a temp session, send `probe`, resume a fixed session, compare tool/service inventories, read cookie and credential warnings |
| Recovery chain (armed on demand) | `ownshield_snapshot` / `ownshield_arm` / `ownshield_disarm` / `ownshield_status` | Snapshot and arm before touching `src/`, asar or the kernel; on breakage the watchdog rolls back → restarts → verifies → reports, then **disarms itself** |

The chain is not resident: only a watchdog with `arm.json` present holds rollback power.

A third, quieter capability: **failure re-injection**. Recovery reports written when the watchdog gives up are delivered back into the affected session on the next startup (and every 5 minutes while running); a failing model request (`401` / `429`) injects its failure scene into the current conversation so the model can see it and tell the user.

---

## Install

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

Restart Harness once afterwards — Host plugin modules are cached by package name.

### Post-install check

Ask an Agent to call `restart_status` and `ownshield_status`. The first reports the resolved executable, restart script and task entry, registry directory, restart lock, running sessions and the log tail. The second reports armed state, whether the scheduled task exists, the snapshot store path, the last recovery verdict, cookie-guard backoff, and whether `needs-human.json` exists.

---

## Eleven tools

Restart & wake (6): `restart_now`, `wake_register`, `wake_list`, `wake_cancel`, `restart_status`, `cookie_status`.

Self-healing (5): `ownshield_probe`, `ownshield_snapshot`, `ownshield_arm`, `ownshield_disarm`, `ownshield_status`.

Callers never pass a session id: tools read it from the execution context.

### Built-in protocol prompt

Registered through `ctx.systemPrompt.section()` on the Host root scope, so every Agent composed in this profile sees it on every step. Two sections — restart rules and self-healing rules — switchable with `restartPromptEnabled` / `ownshieldPromptEnabled`; the legacy `promptEnabled: false` disables both.

---

## Requirements (read before arming)

| Item | Requirement | Notes |
|---|---|---|
| Platform | **Windows only** | Uses `schtasks`, `wscript` (hidden launcher) and PowerShell |
| Node | **Node.js 22+**, discoverable | Probe order: `nodePath` → `OWNSHIELD_NODE` → `DSH_NODE` → `NODE_EXE` → `where node` → common install locations. If nothing runs, arming fails with `ok:false` and an explicit problem — never a task that can never run |
| Privileges | **No admin needed** | Arming creates a per-user scheduled task (no `/RU`) |
| Disk | ~**200 MB per snapshot** (deduplicated) | Store defaults to `~/.dsh/ownshield/snapshots`; below 512 MB warns, below 2 GB the watchdog treats observability as broken and hands over to a human |
| State | `~/.dsh/ownshield` (`OWNSHIELD_DIR`) | `arm.json`, `boot.json`, `recovery.log`, generated `watch-silent.vbs`, `needs-human.json` |

Arming writes the runtime-probed node path and the absolute `watch.mjs` path into `<stateDir>\watch-silent.vbs` and points the scheduled task at that copy. Moving to another machine needs no file edits.

### Arm / disarm / uninstall

```text
ownshield_snapshot ──snapshot──▶ ownshield_arm ──arm──▶ edit the core ──breakage──▶ rollback/restart/verify/report
```

Disarm happens automatically after a successful recovery; manually use `ownshield_disarm`. Uninstall:

```powershell
schtasks /Delete /TN ownshield-watch /F
schtasks /Delete /TN DshRestartWake /F
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\ownshield"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\restart-wake"
```

Disarming does **not** delete the scheduled task: while unarmed it still runs a cookie guard once a minute (read-only, no rollback power).

---

## Configuration

Defaults work out of the box: the executable is detected from the running process, the wake registry lives in `~/.dsh/restart-wake`, self-healing state in `~/.dsh/ownshield`, scripts ship inside the package. Override the Loader row's `config` in the profile's `cordis.patch.yml`; missing fields fall back to defaults.

Note the two state directories are distinct on purpose: `pendingDir` (wake registry) and `injectDir` (re-injection). The full field tables — restart, self-healing, re-injection — are in the Chinese README, which is the reference document.

---

## Safety boundaries

- Delivers text only, never executes commands;
- At most 3 delivery attempts per entry, then archived — **never an unbounded retry loop**;
- A successful delivery leaves no file behind;
- Locks guarantee one restart at a time;
- Refuses to restart while other unregistered sessions are running (`force: true` overrides);
- Validates the executable, script and task entry before acting — one missing and it does nothing;
- Probe failures **never** trigger rollback or restart (deliberate, to avoid a self-exciting repair loop);
- The watchdog holds rollback power only while armed, disarms after recovery, and stops after three consecutive failures;
- Rollback touches only the installed `app.asar` (optionally the profile layer), never `~/.dsh` memory or sessions;
- No credentials, no uploads, no telemetry.

---

## Tests

```powershell
node test/smoke.mjs
node test/ownshield-smoke.mjs
node test/inject/smoke.mjs
node test/inject/probe-gate.test.mjs
node test/inject/request-watch.test.mjs
node scripts/ownshield/watch.test.mjs
node scripts/ownshield/cookie-guard.test.mjs
```

All offline: fake Cordis contexts and stub services drive the real `apply()` and `execute()`. Do not run these with `node --test` — the extra spawned layer hits EPERM under a confined sandbox; `node <file>` is authoritative.

## Compatibility

| Item | Value |
|---|---|
| Tested DSH | `0.2.2-rc.2` (Windows, Node 24.21.0) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Dependencies | Node built-ins only |
| Build | none |

## License

MIT
