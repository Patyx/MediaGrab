# Installs the MediaGrab Helper for the current Windows user (no admin rights needed):
#   - copies the helper to %LOCALAPPDATA%\MediaGrab\helper
#   - downloads yt-dlp.exe and ffmpeg into %LOCALAPPDATA%\MediaGrab\bin (unless already there)
#   - registers the helper with Chrome (HKCU registry key)
param(
  [string]$ExtensionId = 'akdihefcbbgbeokfllakmflnelonapfa',
  [switch]$SkipTools
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HostName = 'com.mediagrab.helper'
$Root = Join-Path $env:LOCALAPPDATA 'MediaGrab'
$HelperDir = Join-Path $Root 'helper'
$Bin = Join-Path $Root 'bin'
$null = New-Item -ItemType Directory -Force -Path $HelperDir, $Bin

Write-Host "Installing MediaGrab Helper to $HelperDir" -ForegroundColor Cyan
$files = 'mediagrab-host.ps1', 'mediagrab-host.bat', 'mediagrab-scan.ps1', 'scan-ui.html', 'MediaGrab Library Scanner.bat'
Copy-Item -LiteralPath ($files | ForEach-Object { Join-Path $PSScriptRoot $_ }) -Destination $HelperDir -Force
Get-ChildItem -LiteralPath $HelperDir | Unblock-File

if (-not $SkipTools) {
  $ytdlp = Join-Path $Bin 'yt-dlp.exe'
  if (Test-Path -LiteralPath $ytdlp) {
    Write-Host 'yt-dlp already installed; checking for updates...'
    & $ytdlp -U | Out-Host
  } else {
    Write-Host 'Downloading yt-dlp.exe (about 18 MB)...'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytdlp
  }

  if (-not (Test-Path -LiteralPath (Join-Path $Bin 'ffmpeg.exe'))) {
    Write-Host 'Downloading ffmpeg (about 140 MB, needed to merge video+audio and make MP3s)...'
    $zip = Join-Path $env:TEMP 'mediagrab-ffmpeg.zip'
    $tmp = Join-Path $env:TEMP ('mediagrab-ffmpeg-' + [guid]::NewGuid())
    Invoke-WebRequest -UseBasicParsing 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    Get-ChildItem -LiteralPath $tmp -Recurse -File | Where-Object { $_.Name -in 'ffmpeg.exe', 'ffprobe.exe' } | Copy-Item -Destination $Bin -Force
    Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  # yt-dlp needs a JavaScript runtime for YouTube; Deno is the one it uses by default.
  if (-not (Test-Path -LiteralPath (Join-Path $Bin 'deno.exe'))) {
    Write-Host 'Downloading Deno (about 45 MB, needed by yt-dlp for YouTube)...'
    $dzip = Join-Path $env:TEMP 'mediagrab-deno.zip'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile $dzip
    Expand-Archive -LiteralPath $dzip -DestinationPath $Bin -Force
    Remove-Item -LiteralPath $dzip -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -LiteralPath $Bin | Unblock-File
}

# Native messaging manifest (UTF-8 without BOM: Chrome rejects a BOM).
$manifestPath = Join-Path $HelperDir "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'MediaGrab Helper (save dialog + yt-dlp)'
  path            = (Join-Path $HelperDir 'mediagrab-host.bat')
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json))

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$null = New-Item -Path $key -Force
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath

# Start Menu shortcut for the Library Scanner.
try {
  $lnkPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'MediaGrab Library Scanner.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $HelperDir 'MediaGrab Library Scanner.bat'
  $lnk.WorkingDirectory = $HelperDir
  $lnk.WindowStyle = 7
  $lnk.Description = 'Rank your videos by how much HEVC compression would save'
  $lnk.Save()
  Write-Host 'Added Start Menu shortcut: MediaGrab Library Scanner'
} catch { Write-Host "Could not create the Start Menu shortcut: $_" -ForegroundColor Yellow }

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Helper:    $HelperDir"
Write-Host "  Tools:     $Bin"
Write-Host "  Extension: $ExtensionId"
Write-Host 'Open MediaGrab settings in Chrome and click "Check again" to confirm it is connected.'
