@echo off
rem Starts the MediaGrab Library Scanner (opens in your browser; stops shortly after you close the tab).
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0mediagrab-scan.ps1"
