# dsh-restart-wake

Restart DeepSeek Harness **safely**, and wake sessions back up **automatically** afterwards.

A Host plugin for DeepSeek Harness: five Agent tools, a startup wake dispatcher, and parameterized restart scripts. An agent can schedule its own restart, survive it, and continue working — no human babysitting.

- Package: `dsh-restart-wake`
- Platform: **restart is Windows-only**; wake, registry and status work everywhere
- Dependencies: none
- Tested with DSH `0.2.1-rc.5`

---

## The problem

After changing `src/`, `package.json`, `cordis.patch.yml` or an installed plugin, the Host must restart. But "let Harness restart itself" hits three hard walls:

| Wall | Symptom | Cause |
|---|---|---|
| Starting the restart script from inside Harness | The log stops at `killing` and the app never returns | Harness puts its children in a Windows Job Object, so the script dies with it |
| Relaunching immediately | The new instance exits right away | Electron's single-instance lock is still held by the dying process |
| Nobody tells the session | The session sits idle forever | The script runs outside the process and cannot notify anything at startup time |

How this plugin handles it:

1. A **one-shot Task Scheduler task** runs the restart outside the Job Object.
2. It kills the **browser (Electron main) process first**, then its children, and waits for the single-instance lock — no crash dialog, no Windows error chime.
3. Before the kill, the agent's "what to do when I wake up" note is written to a registry file. A **startup wake loop** delivers it through `sessionController.prompt`, which resumes cold sessions.

---

## Install

```powershell
dsh plugin --profile desktop add github:zgq0106/dsh-restart-wake
```

Then **restart Harness once** (Host plugin modules are cached by package name; disabling/enabling does not reload them).

If pnpm rejects the `github:` prefix:

```powershell
dsh plugin --profile desktop add "git+https://github.com/zgq0106/dsh-restart-wake.git"
```

### First check

Ask the agent to call `restart_status`. It reports the detected executable, script availability, registry directory, restart mutex, running sessions, and the log tail.

If `exePath` is missing, set it explicitly in the plugin config (see *Configuration*).

---

## Tools

| Tool | Purpose |
|---|---|
| `restart_now` | Register the wake-up → check mutex → check blocked sessions → schedule the restart in N seconds |
| `wake_register` | Register a wake-up only; wait for another session to trigger the restart |
| `wake_list` | Pending entries, recent archives, mutex state |
| `wake_cancel` | Remove this session's wake-up |
| `restart_status` | Self-check and post-restart verification |

The caller does not pass a session id: it is read from the tool execution context (`exec.agent.id`).

### Typical flow

```text
1. restart_status        → exeExists / scriptExists are true, no blocked sessions
2. restart_now({ prompt: "Read the restart log, confirm RESULT: OK, continue the task" })
3. reply "restarting in ~12s", end the turn
4. the plugin wakes this session after the restart
5. restart_status        → lock released, entry archived, log ends with RESULT: OK
```

---

## What happens during a restart

```
restart_now
  ├─ write wake-pending-<sessionId>.json
  ├─ write restart-config.json
  ├─ write restart.lock
  └─ schtasks /Create + /Run          (one-shot task, fires in 12s)
        ↓
      restart-dsh.ps1 (outside Harness)
        ├─ graceful close (Harness only hides to tray)
        ├─ kill browser process first, then children
        ├─ wait for every process to exit
        ├─ optional cookie snapshot
        ├─ wait for the single-instance lock
        ├─ launch → wait → verify, up to 3 attempts
        ├─ log RESULT: OK / FAILED
        └─ delete the one-shot task
        ↓
      new Host starts
        ├─ clear restart.lock
        ├─ scan wake-pending-*.json
        └─ sessionController.prompt(...) → sessions resume
```

With no entries the wake loop stays silent and only logs `no-pending`.

---

## Configuration

Defaults work out of the box: the executable is detected from the running process, the registry lives in `~/.dsh/restart-wake`, and the scripts ship with the package.

To change anything, override the row in the profile's `cordis.patch.yml` (`config` is replaced wholesale, but missing fields fall back to defaults, so list only what you change):

```yaml
- id: restart-wake
  name: dsh-restart-wake
  config:
    pendingDir: 'D:\dsh-wake'
    delaySeconds: 15
```

| Key | Default | Meaning |
|---|---|---|
| `pendingDir` | `~/.dsh/restart-wake` | Registry, mutex, log and script payload |
| `logPath` | `<pendingDir>/wake.log` | Wake and restart log |
| `lockPath` | `<pendingDir>/restart.lock` | Restart mutex |
| `exePath` | auto-detected | Harness executable; required when detection fails |
| `processName` | derived | Process name without `.exe` |
| `scriptPath` | bundled | `scripts/restart-dsh.ps1` |
| `commandPath` | bundled | `scripts/run-restart.cmd` |
| `taskName` | `DshRestartWake` | One-shot task name; change it for multiple installs |
| `delaySeconds` | `12` | Delay between scheduling and the kill |
| `launchWaitSeconds` | `8` | Wait after each launch attempt |
| `maxLaunchAttempts` | `3` | Launch attempts |
| `graceSeconds` | `8` | Graceful-close wait |
| `killTimeoutSeconds` | `20` | Wait for processes to exit after the force kill |
| `singleInstanceWaitSeconds` | `3` | Wait for the Electron lock |
| `lockStaleMs` | `600000` | A lock older than this is abandoned |
| `maxAgeMs` | `86400000` | Entries older than this are not delivered |
| `maxAttempts` | `3` | Delivery attempts per entry |
| `retryDelayMs` | `15000` | Delay between attempts |
| `startupDelayMs` | `3000` | Delay before the first scan |
| `cookieDbPath` | empty | Optional Chromium Cookies DB for a per-restart snapshot |
| `cookieProbePath` | bundled | Optional cookie-probe script |
| `crashLogDir` | empty | Optional crash-log directory for the crash-report check |

> `pendingDir` length affects the Task Scheduler command line (260-character limit). `restart_now` refuses to schedule with a clear message when it would overflow.

---

## Safety boundaries

- Only text is delivered, never a command.
- At most 3 delivery attempts per entry; failures are archived, never retried forever.
- Entries expire after 24 hours.
- A mutex allows one restart at a time.
- By default it refuses to restart while another unregistered session is running (`force: true` overrides).
- The executable, the script and the task entry are validated before anything is killed.
- No credentials, no uploads, no telemetry.

---

## Limits

- **Restart**: Windows only (`schtasks` + PowerShell). On other platforms `restart_now` fails without side effects.
- **Wake**: plain Node, cross-platform.
- A restart interrupts the current turn; unsaved input is lost.
- If another "deliver on startup" plugin shares the same `pendingDir`, entries may be delivered twice — give each plugin its own directory.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `restart_now` returns `blocked` | Another session is running and unregistered; wait, or pass `force: true` |
| `restart_now` returns `busy` | Another restart was scheduled within the last 10 minutes; do not add a second one |
| `schtasks` says "path not found" | Run `schtasks /Query /FO LIST` to tell "task does not exist" from an actual permission problem |
| Log stops at `killing` | The script was killed with Harness — run it through Task Scheduler, not `Start-Process` inside Harness |
| Log stops at `attempt N : running processes = 0` | Launch failed; start Harness manually and read the error before `RESULT: FAILED` |
| Windows error chime after a restart | Wrong kill order: kill the browser process first, then its children |
| No prompt after waking | Check `wake.log`: `delivered` = success; `controller-unavailable` / `expired` explain the rest |

---

## Development

```powershell
node --check index.js
node test/smoke.mjs        # offline; no Harness or Task Scheduler needed
```

## License

MIT
