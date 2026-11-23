# dsh-restart-wake

**Restart DeepSeek Harness safely, come back to the same conversation afterwards, and when a kernel change breaks it, revive the model so the model can fix it itself.**

One package, eleven Agent tools, one set of startup hooks: restart & wake, core probes, snapshots with a watchdog, and failure re-injection.

**Two main things: the Agent restarts Harness itself and keeps working, and a broken kernel gets revived so the model can fix it itself.**

**1. Restart & wake.** After editing `src/`, a plugin or the config, the Host must restart. `restart_now` lets the Agent schedule that restart itself: a Task Scheduler job runs outside the process tree (bypassing the Windows Job Object), writes "what to do on wake-up" to a registry file before restarting, and once the new process is ready the startup waker delivers it and resumes the session — the Agent lands back in the same conversation and continues the same work, with no one to click anything. Restarts are refused by default while other sessions are running; several sessions can each register and all get woken after the restart (`wake_register`). During the restart window it also prunes `dsh-auth-*` cookies so they never pile up into a 431 startup crash.

**2. Revive the model, and the model does the fixing.** Harness crashes, hangs, or starts but can no longer run after a kernel change — and then the model cannot work at all. Without this package a human has to dig through logs, swap files by hand, restart, and pick the conversation back up. With it: the watchdog notices within a minute, rolls `app.asar` (or the profile layer) back to the snapshot, restarts, verifies, gets Harness back to "the model can create sessions and call tools", and injects the scene — crash cause, failure record, the goal that was interrupted — into the affected session. **The model comes back online, reads the scene, and fixes it itself.**

For the second job the plugin does no root-cause analysis and edits no code; it guarantees the model gets back online with the scene that broke it. Not resident by default: until you call `ownshield_arm`, it does nothing on its own.

- Package: `dsh-restart-wake`
- Version: **2.1.0**
- Platform: **restart, cookie cleanup and the self-healing chain are Windows-only**; wake-up, registration and status queries are cross-platform
- Dependencies: none (Node built-ins only)
- DSH: requires **≥ `0.2.2-alpha.2`**; tested on `0.2.2-rc.2`

> ## Upgrading from 0.1.x to 2.x: just update
>
> 2.x adds self-healing and re-injection inside the same package: the tool count goes from 6 to 11, the `dsh.profile.bundles` row stays as it is, and the `~/.dsh/ownshield` state directory is reused (it only holds runtime files created on first use; a missing directory is fine).
>
> **Behaviour change**: `ownshield_probe` no longer creates a session by default — pass `deep: true` to verify that sessions can actually run. Tool names and everything else stay the same.

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
| Probe (always available) | `ownshield_probe` | Detect only. Four static checks by default (tools / services / heartbeat / credentials) — no session, no tokens; pass `deep: true` to create a temp session, send `probe`, and resume a fixed session |
| Recovery chain (armed on demand) | `ownshield_snapshot` / `ownshield_arm` / `ownshield_disarm` / `ownshield_status` | Snapshot and arm before touching `src/`, asar or the kernel; on breakage the watchdog rolls back → restarts → verifies → reports, then **disarms itself** |

The chain is not resident: only a watchdog with `arm.json` present holds rollback power.

**Who does what:**

| Actor | Job |
|---|---|
| The plugin | Notice the break → roll files back → restart → verify "the model can create sessions and call tools" → deliver the scene into the affected session (cause, failure record, interrupted goal) |
| The model | Once revived, read the scene, find the root cause, fix the code itself, and resume the original work |
| The human | Everything while nothing is armed; handling after three consecutive failures (the plugin writes `needs-human.json` and stops, never retrying forever) |

So the accurate phrasing is "**the plugin revives, the model repairs**". The plugin does not guess at root causes and edits no code — it makes sure the model gets back online carrying the scene from the moment of failure. That is also why acceptance is "the model can create a session and call tools", not "the error disappeared".

A third, quieter capability: **failure re-injection**. Recovery reports written when the watchdog gives up are delivered back into the affected session on the next startup (and every 5 minutes while running); a failing model request (`401` / `429`) injects its failure scene into the current conversation so the model can see it and tell the user.

### 3. What it recovers, and what it does not

**One sentence**: arm before you touch the core — if Harness crashes, hangs, or starts but cannot run, it is noticed within a minute, rolled back and restarted in about twenty seconds, and the session resumes, unattended. Arming is on demand, rollback covers the core only, and three consecutive failures stop the chain and hand over to a human.

What it recovers (verified on real machines):

| Failure | Detection | Action |
|---|---|---|
| Main process crashes / is killed / exits on its own | ≤ 60 s | debridement → roll back `app.asar` → restart → verify → report; measured 22 s |
| A new crash log appears | ≤ 60 s | same |
| Host hangs (process alive, heartbeat stale for 90 s) | 2–3 min (soft signal, two rounds) | restart |
| Starts but cannot run: `agent-preset/invalid`, `Duplicate tool group`, `resume failed`, missing tools/services | **up to 6 h** (probe gate is rate-limited) | quarantine the offending patch entry; roll back when attribution misses |
| Local web cookie expired (401, page refresh fails) | ≤ 1 min (guard runs unarmed too) | restart only, no rollback |
| Model broke the profile (`cordis.patch.yml` / presets / `package.json`) | no extra time (runs after L2) | **L3**: restores the profile layer only; `node_modules` contents untouched |

What it does **not** recover:

1. **Anything at all while unarmed.** That is the design: it does not hold rollback power day to day.
2. **Rollback has two layers, both bounded.** L1/L2 roll back `app.asar`; L3 restores the profile layer only (`cordis.patch.yml`, preset dirs, `package.json`, `link:` entries). `node_modules` contents, sessions, memories, credentials, network and disk are never inside a snapshot.
3. **Unknown shapes**: if debridement cannot attribute the error, only the kernel can be rolled back; when the root cause lives in the profile layer that cannot help, so three failures trip the breaker and `needs-human.json` is written.
4. **Snapshot missing or not matching the live kernel** (e.g. DSH was upgraded in between) — the hash guard refuses to roll back.
5. **Blind spots with no signal**: a renderer that goes white without a log, a window that stops responding, a corrupted session file, a credential revoked server-side, a third-party plugin throwing inside `apply()`, and **code that still boots but no longer works**.
6. **The limits of "in place"**: what comes back is a new process. The session is restored from disk and resumed; tool calls that never landed and half-written files are not repaired.

One more note: this chain does not care who caused the failure — it only recognises "a rollbackable break in the kernel layer". So "failures caused by the model" is not a special coverage area; do not market that qualifier as a capability. The standard phrasing is "**the plugin revives, the model repairs**": the plugin's output is "the model can work again", not "the bug is fixed" — root-cause analysis and code changes happen after the model is back online.

---

### DSH version compatibility

`package.json` declares `engines.dsh: ">=0.2.2-alpha.2"`, so a mismatched version is **rejected by the compatibility check at install time** — it never gets installed only to break later. Pick by the DSH you have:

| DSH version | Plugin version to use | Notes |
|---|---|---|
| `≥ 0.2.2-alpha.2` | **2.x (currently 2.1.0)** | Tested on `0.2.2-rc.2`; 11 tools including self-healing. `0.2.2-alpha.2` – `0.2.2-rc.1` not tested individually |
| `0.2.1` (incl. `0.2.1-rc.x`) | **v0.1.5** | Tested on `0.2.1-rc.5`; restart & wake only, **no self-healing**. v0.1.5 declares no `engines.dsh`, so nothing blocks it |
| Older (0.1.x, 0.2.0) | v0.1.5, unverified | Installs, but untested; upgrade DSH first |

The split is at `0.2.2-alpha.2`, which changed the Schedule tools: the time argument moved from `after_seconds` to the required `rrule` + `target`, and `schedule_update` / `schedule_delete` were replaced by `schedule_edit`. The protocol prompt this plugin injects — which every Agent sees on every step — follows the new shape; on an older DSH it points at tools that do not exist, so any "have the Agent create or edit a reminder" flow fails. This is not "mostly works" — it is the wrong version pairing.

Pin an older release by tag:

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake#v0.1.5
```

Upgrade order: bring DSH to `≥ 0.2.2-alpha.2` first, then move to 2.x. The other way round is rejected at install.

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
