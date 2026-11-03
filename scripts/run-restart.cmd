@echo off
rem Task Scheduler entry point. Argument 1 is the restart-config.json path.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0restart-dsh.ps1" -Config "%~1"
