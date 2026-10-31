# MediaGrab Helper: Chrome native messaging host for Windows (PowerShell 5.1+).
#  - Shows the Windows Save dialog at the last folder you used and writes files sent by the extension.
#  - Runs yt-dlp (+ ffmpeg) for sites MediaGrab can't handle itself, and for MP3 audio.
# Protocol: 4-byte little-endian length + UTF-8 JSON, both directions. Nothing else may be
# written to stdout, so every expression's output is discarded explicitly.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Version = '1.3.1'
$null = Add-Type -AssemblyName System.Windows.Forms
$null = Add-Type -AssemblyName System.Drawing

$Root = Join-Path $env:LOCALAPPDATA 'MediaGrab'
$Bin = Join-Path $Root 'bin'
$StateFile = Join-Path $Root 'state.json'
# Our own bin first, then the current PATH from the registry (Chrome's copy may be stale).
$env:Path = (@($Bin, [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')) | Where-Object { $_ }) -join ';'

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
$open = @{}   # save id -> FileStream
$paths = @{}  # save id -> path
$temps = @{}  # save id -> temporary .m4a awaiting MP3 conversion

# ------------------------------------------------------------------ messaging

function Read-Exact([byte[]]$buf, [int]$count) {
  $off = 0
  while ($off -lt $count) {
    $r = $stdin.Read($buf, $off, $count - $off)
    if ($r -le 0) { return $false }
    $off += $r
  }
  return $true
}

function Read-Message {
  $len = New-Object byte[] 4
  if (-not (Read-Exact $len 4)) { return $null }
  $n = [BitConverter]::ToInt32($len, 0)
  $buf = New-Object byte[] $n
  if (-not (Read-Exact $buf $n)) { return $null }
  return [Text.Encoding]::UTF8.GetString($buf)
}

function Send([hashtable]$obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 4))
  $stdout.Write([BitConverter]::GetBytes([int32]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# ------------------------------------------------------------------ saving

function Get-LastDir {
  try {
    $s = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($s.lastDir -and (Test-Path -LiteralPath $s.lastDir -PathType Container)) { return $s.lastDir }
  } catch {}
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  if (Test-Path -LiteralPath $dl) { return $dl }
  return [Environment]::GetFolderPath('MyDocuments')
}

function Set-LastDir([string]$dir) {
  $null = New-Item -ItemType Directory -Force -Path $Root
  [IO.File]::WriteAllText($StateFile, (@{ lastDir = $dir } | ConvertTo-Json))
}

function Get-UniquePath([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $p }
  $d = [IO.Path]::GetDirectoryName($p)
  $b = [IO.Path]::GetFileNameWithoutExtension($p)
  $e = [IO.Path]::GetExtension($p)
  for ($i = 2; ; $i++) {
    $c = [IO.Path]::Combine($d, "$b ($i)$e")
    if (-not (Test-Path -LiteralPath $c)) { return $c }
  }
}

$Filters = @{
  mp4 = 'MP4 video (*.mp4)|*.mp4'; webm = 'WebM video (*.webm)|*.webm'
  m4a = 'M4A audio (*.m4a)|*.m4a'; mp3 = 'MP3 audio (*.mp3)|*.mp3'
  jpg = 'JPEG image (*.jpg)|*.jpg'; png = 'PNG image (*.png)|*.png'; gif = 'GIF image (*.gif)|*.gif'
  webp = 'WebP image (*.webp)|*.webp'; heic = 'HEIC image (*.heic)|*.heic'; avif = 'AVIF image (*.avif)|*.avif'
}

# Windows PowerShell isn't DPI-aware, so on scaled displays Windows bitmap-stretches its
# dialogs (blurry). Declare per-monitor DPI awareness once, before the first window.
$script:dpiReady = $false
function Enable-SharpDialogs {
  if ($script:dpiReady) { return }
  $script:dpiReady = $true
  try {
    Add-Type -Namespace MediaGrab -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
    try { $null = [MediaGrab.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) }  # per-monitor v2 (Windows 10 1703+)
    catch { $null = [MediaGrab.Dpi]::SetProcessDPIAware() }                         # older Windows: system DPI
  } catch {}
  try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch {}
}

# Returns the chosen path, or $null if the user cancelled. With $dir set (later files of a
# "Download all"), saves next to the first file without asking.
function Select-SavePath([string]$name, [string]$ext, [string]$dir) {
  if ($dir -and (Test-Path -LiteralPath $dir -PathType Container)) {
    return Get-UniquePath ([IO.Path]::Combine($dir, "$name.$ext"))
  }
  Enable-SharpDialogs
  # An invisible top-most owner window brings the dialog in front of Chrome.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.StartPosition = 'CenterScreen'
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Show()
  $owner.Activate()
  $dlg = New-Object System.Windows.Forms.SaveFileDialog
  $dlg.Title = 'Save with MediaGrab'
  $dlg.InitialDirectory = Get-LastDir
  $dlg.FileName = "$name.$ext"
  $f = $Filters[$ext]
  $dlg.Filter = $(if ($f) { "$f|All files (*.*)|*.*" } else { 'All files (*.*)|*.*' })
  $dlg.DefaultExt = $ext
  $dlg.AddExtension = $true
  $dlg.OverwritePrompt = $true
  try { $res = $dlg.ShowDialog($owner) } finally { $owner.Close(); $owner.Dispose() }
  if ($res -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  Set-LastDir ([IO.Path]::GetDirectoryName($dlg.FileName))
  return $dlg.FileName
}

# ------------------------------------------------------------------ yt-dlp

function Get-Ytdlp {
  $c = Get-Command yt-dlp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

function ConvertTo-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $sb = New-Object Text.StringBuilder
  $null = $sb.Append('"')
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') { $null = $sb.Append('\' * ($bs * 2 + 1)).Append('"') }
    else { $null = $sb.Append('\' * $bs).Append($ch) }
    $bs = 0
  }
  $null = $sb.Append('\' * ($bs * 2)).Append('"')
  return $sb.ToString()
}

# Runs yt-dlp; calls $onLine for each stdout line. Returns @{ code; err }.
function Invoke-Ytdlp([string[]]$argv, [scriptblock]$onLine) {
  $exe = Get-Ytdlp
  if (-not $exe) { throw 'yt-dlp not found. Run install.bat from the MediaGrab helper folder.' }
  return Invoke-Tool $exe $argv $onLine
}

# Runs an executable without a window; stdout lines go to $onLine. Returns @{ code; err }.
function Invoke-Tool([string]$exe, [string[]]$argv, [scriptblock]$onLine) {
  $psi = New-Object Diagnostics.ProcessStartInfo $exe
  $psi.Arguments = ($argv | ForEach-Object { ConvertTo-Arg $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
  $psi.EnvironmentVariables['PYTHONUTF8'] = '1'
  $psi.EnvironmentVariables['PATH'] = $env:Path
  $p = [Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  while ($null -ne ($line = $p.StandardOutput.ReadLine())) { if ($onLine) { $null = & $onLine $line } }
  $p.WaitForExit()
  return @{ code = $p.ExitCode; err = $errTask.Result }
}

function Get-YtdlpError([string]$err) {
  $lines = $err -split "`r?`n" | Where-Object { $_ -match '^ERROR' }
  if ($lines) { return (($lines | Select-Object -Last 1) -replace '^ERROR:\s*', '') }
  $t = $err.Trim()
  if ($t.Length -gt 300) { $t = $t.Substring($t.Length - 300) }
  if ($t) { return $t }
  return 'yt-dlp failed'
}

# YouTube sometimes offers no usable formats with login cookies; retry once without them.
function Test-FormatError([string]$err) {
  return $err -match 'Requested format is not available|Only images are available|No video formats found'
}

function Remove-CookieArgs([string[]]$argv) {
  $out = @()
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--cookies') { $i++; continue }
    $out += $argv[$i]
  }
  return ,$out
}

function Get-YoutubeHint([string]$err) {
  if ((Test-FormatError $err) -and -not (Get-Command deno -CommandType Application -ErrorAction SilentlyContinue)) {
    return ' (YouTube needs Deno: run install.bat from the MediaGrab helper folder again)'
  }
  return ''
}

function New-CookieFile($m) {
  if (-not $m.cookies) { return $null }
  $cf = Join-Path $env:TEMP ('mg-cookies-' + [guid]::NewGuid() + '.txt')
  [IO.File]::WriteAllText($cf, [string]$m.cookies)
  return $cf
}

function Get-BaseArgs($m, $cookieFile) {
  $a = @('--no-mtime', '--newline', '--no-colors', '--encoding', 'utf-8')
  if ($m.playlistItem) { $a += @('--yes-playlist', '--playlist-items', [string]$m.playlistItem) } else { $a += '--no-playlist' }
  if ($cookieFile) { $a += @('--cookies', $cookieFile) }
  return $a
}

function Invoke-Info($m) {
  $cf = New-CookieFile $m
  try {
    $tmp = Join-Path $env:TEMP ('mg-info-' + [guid]::NewGuid())
    $out = New-Object Collections.Generic.List[string]
    $argv = (Get-BaseArgs $m $cf) + @('--no-simulate', '--skip-download', '--write-info-json', '-o', "$tmp.%(ext)s",
      '-O', '%(uploader_id)s', '-O', '%(uploader)s', '-O', '%(title)s', '-O', '%(id)s',
      '-O', '%(formats.:.width)j', '-O', '%(formats.:.height)j', '-O', '%(formats.:.vcodec)j', '--', [string]$m.url)
    $r = Invoke-Ytdlp $argv { param($l) $out.Add($l) }
    if ($r.code -ne 0 -and $cf -and (Test-FormatError $r.err)) {
      $out.Clear()
      $r = Invoke-Ytdlp (Remove-CookieArgs $argv) { param($l) $out.Add($l) }
    }
    if ($r.code -ne 0) { throw ((Get-YtdlpError $r.err) + (Get-YoutubeHint $r.err)) }
    $v = @(@($out | Select-Object -Last 7) | ForEach-Object { if ($_ -eq 'NA') { '' } else { $_ } })
    $info = "$tmp.info.json"
    Send @{ rid = $m.rid; event = 'info'; uploader_id = $v[0]; uploader = $v[1]; title = $v[2]; id = $v[3]
      widths = $v[4]; heights = $v[5]; vcodecs = $v[6]
      infoFile = $(if (Test-Path -LiteralPath $info) { $info } else { $null }) }
  } finally {
    if ($cf) { Remove-Item -LiteralPath $cf -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-Download($m) {
  $ext = [string]$m.ext
  $path = Select-SavePath ([string]$m.name) $ext ([string]$m.dir)
  if (-not $path) { Send @{ rid = $m.rid; event = 'cancelled' }; return }
  $dir = [IO.Path]::GetDirectoryName($path)
  $stem = [IO.Path]::Combine($dir, [IO.Path]::GetFileNameWithoutExtension($path))
  $cf = New-CookieFile $m
  try {
    $argv = Get-BaseArgs $m $cf
    if ($m.audio) {
      $argv += @('-f', 'ba/b', '-x', '--audio-format', [string]$m.audio)
      if ($m.audio -eq 'mp3' -and $m.mp3Quality) { $argv += @('--audio-quality', [string]$m.mp3Quality) }
    } else {
      $sort = @()
      $res = $(if ([int]$m.maxHeight -gt 0) { "res:$([int]$m.maxHeight)" } else { 'res' })
      if ($m.resFirst) {
        # Quality picked in the popup: highest resolution at or below it wins.
        $sort += $res
        if ($m.preferH264) { $sort += 'vcodec:h264' }
      } else {
        if ($m.preferH264) { $sort += 'vcodec:h264' }
        $sort += $res
      }
      $sort += 'ext:mp4:m4a'
      $argv += @('-f', 'bv*+ba/b', '-S', ($sort -join ','), '--merge-output-format', 'mp4', '--remux-video', 'mp4')
    }
    $argv += @('-o', ($stem.Replace('%', '%%') + '.%(ext)s'), '--progress-template', 'download:MGP %(progress._percent_str)s')
    if ($m.infoFile -and (Test-Path -LiteralPath $m.infoFile)) { $argv += @('--load-info-json', [string]$m.infoFile) }
    else { $argv += @('--', [string]$m.url) }

    $state = @{ last = -1 }
    $onLine = {
      param($l)
      if ($l -match '^MGP\s+([\d.]+)%') {
        $pct = [int][double]$Matches[1]
        if ($pct -ne $state.last) { $state.last = $pct; Send @{ rid = $m.rid; event = 'progress'; pct = $pct } }
      }
    }
    $r = Invoke-Ytdlp $argv $onLine
    if ($r.code -ne 0 -and $cf -and (Test-FormatError $r.err)) {
      $r = Invoke-Ytdlp (Remove-CookieArgs $argv) $onLine
    }
    if ($r.code -ne 0) { throw ((Get-YtdlpError $r.err) + (Get-YoutubeHint $r.err)) }
    $final = "$stem.$ext"
    if (-not (Test-Path -LiteralPath $final)) {
      $hit = Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.BaseName -eq [IO.Path]::GetFileName($stem) } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($hit) { $final = $hit.FullName }
    }
    $size = $(if (Test-Path -LiteralPath $final) { (Get-Item -LiteralPath $final).Length } else { $null })
    Send @{ rid = $m.rid; event = 'saved'; path = $final; size = $size }
  } finally {
    if ($cf) { Remove-Item -LiteralPath $cf -Force -ErrorAction SilentlyContinue }
    if ($m.infoFile) { Remove-Item -LiteralPath ([string]$m.infoFile) -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-Update($m) {
  $out = New-Object Collections.Generic.List[string]
  $r = Invoke-Ytdlp @('-U') { param($l) $out.Add($l) }
  $text = (($out -join "`n") + "`n" + $r.err).Trim()
  if ($text.Length -gt 2000) { $text = $text.Substring($text.Length - 2000) }
  Send @{ rid = $m.rid; event = 'updated'; output = $text; ok = ($r.code -eq 0) }
}

function Get-Hello($m) {
  $ver = $null
  if ($m.full -and (Get-Ytdlp)) {
    $out = New-Object Collections.Generic.List[string]
    try { $null = Invoke-Ytdlp @('--version') { param($l) $out.Add($l) }; $ver = ($out | Select-Object -First 1) } catch {}
  }
  $ff = [bool](Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue)
  $deno = [bool](Get-Command deno -CommandType Application -ErrorAction SilentlyContinue)
  Send @{ rid = $m.rid; event = 'hello'; version = $Version; ytdlp = $ver; hasYtdlp = [bool](Get-Ytdlp); ffmpeg = $ff; deno = $deno }
}

# ------------------------------------------------------------------ main loop

function Invoke-HostCommand($m) {
  switch ([string]$m.cmd) {
    'hello' { Get-Hello $m }
    'save-begin' {
      $p = Select-SavePath ([string]$m.name) ([string]$m.ext) ([string]$m.dir)
      if (-not $p) { Send @{ rid = $m.rid; event = 'cancelled' }; return }
      $target = $p
      if ($m.convert -eq 'mp3') {
        $target = "$p.mg-part.m4a"
        $temps[[string]$m.id] = $target
      }
      $open[[string]$m.id] = [IO.File]::Open($target, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $paths[[string]$m.id] = $p
      Send @{ rid = $m.rid; event = 'save-ready'; path = $p }
    }
    'save-end' {
      $id = [string]$m.id
      $open[$id].Close(); $open.Remove($id)
      $p = $paths[$id]; $paths.Remove($id)
      $tmp = $temps[$id]
      if ($tmp) {
        $temps.Remove($id)
        try {
          $ff = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
          if (-not $ff) { throw 'ffmpeg not found. Run install.bat from the MediaGrab helper folder.' }
          $q = [string]$m.mp3Quality
          $qa = $(if ($q -match '^\d+K$') { @('-b:a', $q.ToLower()) } else { @('-q:a', $(if ($q) { $q } else { '0' })) })
          $r = Invoke-Tool $ff.Source (@('-y', '-hide_banner', '-loglevel', 'error', '-i', $tmp, '-vn', '-c:a', 'libmp3lame') + $qa + @($p)) $null
          if ($r.code -ne 0) { throw "MP3 conversion failed: $($r.err.Trim())" }
        } finally {
          Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
      }
      Send @{ rid = $m.rid; event = 'saved'; path = $p; size = (Get-Item -LiteralPath $p).Length }
    }
    'save-abort' {
      $id = [string]$m.id
      if ($open[$id]) { $open[$id].Close(); $open.Remove($id) }
      if ($paths[$id]) { Remove-Item -LiteralPath $paths[$id] -Force -ErrorAction SilentlyContinue; $paths.Remove($id) }
      if ($temps[$id]) { Remove-Item -LiteralPath $temps[$id] -Force -ErrorAction SilentlyContinue; $temps.Remove($id) }
      Send @{ rid = $m.rid; event = 'aborted' }
    }
    'ytdlp-info' { Invoke-Info $m }
    'ytdlp-download' { Invoke-Download $m }
    'ytdlp-update' { Invoke-Update $m }
    'open-file' {
      $p = [string]$m.path
      if (-not ($p -and (Test-Path -LiteralPath $p -PathType Leaf))) { throw 'File not found (moved or deleted?)' }
      Invoke-Item -LiteralPath $p
      Send @{ rid = $m.rid; event = 'opened' }
    }
    'open-folder' {
      $p = [string]$m.path
      if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$p`"" }
      else { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$(Get-LastDir)`"" }
      Send @{ rid = $m.rid; event = 'opened' }
    }
    default { Send @{ rid = $m.rid; event = 'error'; error = "unknown command $($m.cmd)" } }
  }
}

while ($true) {
  $raw = Read-Message
  if ($null -eq $raw) { break }
  $rid = $null
  try {
    if ($raw.StartsWith('{"cmd":"save-chunk"')) {
      # Fast path for file data: {"cmd":"save-chunk","rid":"..","id":"..","data":"<base64>"}
      $rid = [regex]::Match($raw, '"rid":"([^"]+)"').Groups[1].Value
      $id = [regex]::Match($raw, '"id":"([^"]+)"').Groups[1].Value
      $i = $raw.IndexOf('"data":"') + 8
      $bytes = [Convert]::FromBase64String($raw.Substring($i, $raw.Length - $i - 2))
      $open[$id].Write($bytes, 0, $bytes.Length)
      Send @{ rid = $rid; event = 'ack' }
    } else {
      $m = $raw | ConvertFrom-Json
      $rid = $m.rid
      $null = Invoke-HostCommand $m
    }
  } catch {
    Send @{ rid = $rid; event = 'error'; error = $_.Exception.Message }
  }
}
foreach ($fs in $open.Values) { try { $fs.Close() } catch {} }
