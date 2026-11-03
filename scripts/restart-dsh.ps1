# DSH restart script (ASCII only -- avoid PowerShell 5.1 ANSI/UTF-8 parsing issues).
#
# Run this through Task Scheduler, never as a child of Harness:
#   Harness puts its children in a Windows Job Object, so a script started from
#   inside Harness is killed together with it and never reaches the relaunch.
#
# Order matters:
#   1. wait a few seconds so the caller's reply can leave the process,
#   2. ask the window to close (Harness hides to the tray instead of exiting),
#   3. kill the BROWSER process first (the Electron main process -- the one whose
#      parent is not itself a Harness process), then its children. Killing the
#      renderer first makes the browser process report a renderer crash, write a
#      crash report, and show a native error dialog; the dialog disappears with
#      the process, leaving only the Windows error chime.
#   4. wait for every process to disappear,
#   5. wait again for the Electron single-instance lock to be released,
#   6. launch, wait, verify, and retry,
#   7. remove the one-shot task and write RESULT: OK / FAILED.
#
# Usage: schtasks /Run /TN <task>  (the task calls run-restart.cmd with this file)
#        powershell -File restart-dsh.ps1 -Config <restart-config.json>

param(
  [Parameter(Mandatory = $true)][string]$Config
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $Config)) {
  Write-Output "restart-dsh: config not found: $Config"
  exit 2
}

$cfg = [System.IO.File]::ReadAllText($Config, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

$log = [string]$cfg.logPath
$exe = [string]$cfg.exePath
$name = [string]$cfg.processName
$task = [string]$cfg.taskName
$delay = [int]$cfg.delaySeconds
$grace = [int]$cfg.graceSeconds
$killTimeout = [int]$cfg.killTimeoutSeconds
$lockWait = [int]$cfg.singleInstanceWaitSeconds
$launchWait = [int]$cfg.launchWaitSeconds
$maxAttempts = [int]$cfg.maxLaunchAttempts
$cookieDb = [string]$cfg.cookieDbPath
$cookieProbe = [string]$cfg.cookieProbePath
$cookieCleanup = [string]$cfg.cookieCleanupPath
$cookieThreshold = [int]$cfg.cookieThreshold
if ($cookieThreshold -le 0) { $cookieThreshold = 50 }
$crashDir = [string]$cfg.crashLogDir

$logDir = Split-Path -Parent $log
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Log([string]$msg) {
  try {
    "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff') $msg" | Out-File -FilePath $log -Append -Encoding utf8
  } catch {
    # logging is best effort
  }
}

function HarnessProcesses() {
  return @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function CrashCount() {
  if (-not $crashDir) { return -1 }
  try {
    return @(Get-ChildItem -LiteralPath $crashDir -Filter 'crash-*-renderer.log' -ErrorAction SilentlyContinue).Count
  } catch {
    return -1
  }
}

Log '=== restart requested ==='

# Give the caller time to finish its reply before the window goes away.
Start-Sleep -Seconds $delay

if (-not (Test-Path -LiteralPath $exe)) {
  Log "FATAL: executable not found: $exe"
  Log 'RESULT: FAILED - executable missing'
  exit 1
}

# --- 1) ask the window to close (Harness hides to the tray instead of exiting) ---
$before = HarnessProcesses
Log "graceful close requested on $($before.Count) process(es)"
foreach ($p in $before) {
  try { [void]$p.CloseMainWindow() } catch { Log "CloseMainWindow pid $($p.Id) threw: $($_.Exception.Message)" }
}

$waited = 0
while (((HarnessProcesses).Count -gt 0) -and $waited -lt $grace) {
  Start-Sleep -Milliseconds 500
  $waited += 0.5
}
Log "after graceful wait ${waited}s : $((HarnessProcesses).Count) process(es) still up"

# --- 2) identify the browser (Electron main) process ---
$stillUp = HarnessProcesses
$ids = @($stillUp | ForEach-Object { $_.Id })
$owner = @{}
foreach ($id in $ids) {
  try {
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
    $owner[$id] = @{ Parent = [int]$ci.ParentProcessId; Cmd = [string]$ci.CommandLine }
  } catch { Log "wmi lookup pid $id failed: $($_.Exception.Message)" }
}

$browserId = $null
# Preferred: the process whose parent is not one of our own processes.
foreach ($id in $ids) {
  $o = $owner[$id]
  if ($o -eq $null) { continue }
  if ($ids -notcontains $o.Parent) { $browserId = $id; break }
}
# Fallback: a command line without Chromium's --type= switch.
if ($browserId -eq $null) {
  foreach ($id in $ids) {
    $o = $owner[$id]
    if ($o -eq $null) { continue }
    if ($o.Cmd -notmatch '--type=') { $browserId = $id; break }
  }
}
Log "browser process: $(if ($browserId -eq $null) { 'not identified' } else { "pid $browserId" }) of $($ids.Count) process(es)"

$crashBefore = CrashCount
Log "renderer crash reports before kill: $crashBefore"

# --- 3) kill the browser process first, then the rest ---
if ($browserId -ne $null) {
  try { Stop-Process -Id $browserId -Force -ErrorAction Stop; Log "killed browser process pid $browserId first" }
  catch { Log "kill browser pid $browserId failed: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 900
}
foreach ($id in $ids) {
  if ($id -eq $browserId) { continue }
  try { Stop-Process -Id $id -Force -ErrorAction Stop }
  catch { Log "force kill pid $id failed: $($_.Exception.Message)" }
}

$waited = 0
while (((HarnessProcesses).Count -gt 0) -and $waited -lt $killTimeout) {
  Start-Sleep -Milliseconds 500
  $waited += 0.5
}
Log "after force kill: $((HarnessProcesses).Count) process(es) remaining, waited ${waited}s"
Log "renderer crash reports after kill: $(CrashCount)"

# --- 3b) cookie hygiene (optional, and only possible in this window) ---
# Chromium holds the Cookies SQLite file exclusively while it runs, so this
# window -- browser dead, new instance not yet started -- is the only moment the
# file is readable and writable.
#
# Cleanup first: the Desktop Host mints a new dsh-auth-<authority-hash> cookie on
# every launch and Chromium never removes old names. Around 70 entries the Cookie
# header passes Node's 16 KB limit, the Host answers 431, and the Electron shell
# reports "Web authentication failed" and aborts startup. Purging only
# dsh-auth-% rows keeps that from ever happening; every other cookie and the
# account credentials are untouched.
#
# The snapshot afterwards records what the new instance starts with.
try {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'node' }

  if ($cookieDb -and $cookieCleanup -and (Test-Path -LiteralPath $cookieCleanup) -and (Test-Path -LiteralPath $cookieDb)) {
    $cleanup = (& $nodeExe $cookieCleanup $cookieDb --auto "--threshold=$cookieThreshold" 2>&1 | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($cleanup)) { $cleanup = '(no output)' }
    Log "cookie cleanup: $cleanup"
  } else {
    Log 'cookie cleanup skipped: script or Cookies DB missing'
  }

  if ($cookieDb -and $cookieProbe -and (Test-Path -LiteralPath $cookieProbe) -and (Test-Path -LiteralPath $cookieDb)) {
    $snapshot = (& $nodeExe $cookieProbe $cookieDb 2>&1 | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($snapshot)) { $snapshot = '(no output)' }
    Log "cookie snapshot: $snapshot"
  } else {
    Log 'cookie snapshot skipped: probe script or Cookies DB missing'
  }
} catch {
  Log "cookie hygiene failed: $($_.Exception.Message)"
}

# Electron keeps a single-instance lock briefly; launching too early makes the
# new instance hand its arguments to the dying one and quit.
Start-Sleep -Seconds $lockWait

# --- 4) launch with verification and retry ---
$ok = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  try {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -LiteralPath $exe) -ErrorAction Stop
    Log "attempt $attempt : launch command issued"
  } catch {
    Log "attempt $attempt : launch threw: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $launchWait
  $running = (HarnessProcesses).Count
  Log "attempt $attempt : running processes = $running"
  if ($running -gt 0) { $ok = $true; break }
}

if ($ok) { Log 'RESULT: OK - harness is running' } else { Log 'RESULT: FAILED - harness did not start after all attempts' }
Log "renderer crash reports after start: $(CrashCount)"

# --- 5) clean up the one-shot scheduled task ---
try { schtasks /Delete /TN $task /F 2>&1 | Out-Null; Log 'scheduled task removed' } catch { Log 'scheduled task removal failed' }

if ($ok) { exit 0 } else { exit 1 }
