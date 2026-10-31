@echo off
powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "%~dp0mediagrab-host.ps1" %*
