# MediaGrab Helper: Chrome native messaging host for Windows (PowerShell 5.1+).
#  - Shows the Windows Save dialog at the last folder you used and writes files sent by the extension.
#  - Runs yt-dlp (+ ffmpeg) for sites MediaGrab can't handle itself, and for MP3 audio.
# Protocol: 4-byte little-endian length + UTF-8 JSON, both directions. Nothing else may be
# written to stdout, so every expression's output is discarded explicitly.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Version = '1.4.0'
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
$staged = @{} # save id -> original video kept aside for compression

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

function Read-State {
  $h = @{}
  try {
    $o = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
  } catch {}
  return $h
}

function Write-State([hashtable]$h) {
  $null = New-Item -ItemType Directory -Force -Path $Root
  [IO.File]::WriteAllText($StateFile, ($h | ConvertTo-Json -Depth 5))
}

function Get-LastDir {
  $d = (Read-State).lastDir
  if ($d -and (Test-Path -LiteralPath $d -PathType Container)) { return $d }
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  if (Test-Path -LiteralPath $dl) { return $dl }
  return [Environment]::GetFolderPath('MyDocuments')
}

function Set-LastDir([string]$dir) {
  $s = Read-State
  $s.lastDir = $dir
  Write-State $s
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
      '-O', '%(formats.:.width)j', '-O', '%(formats.:.height)j', '-O', '%(formats.:.vcodec)j', '-O', '%(formats.:.acodec)j',
      '-O', '%(formats.:.filesize)j', '-O', '%(formats.:.filesize_approx)j', '-O', '%(formats.:.vbr)j', '-O', '%(formats.:.abr)j',
      '-O', '%(formats.:.tbr)j', '-O', '%(duration)s', '--', [string]$m.url)
    $r = Invoke-Ytdlp $argv { param($l) $out.Add($l) }
    if ($r.code -ne 0 -and $cf -and (Test-FormatError $r.err)) {
      $out.Clear()
      $r = Invoke-Ytdlp (Remove-CookieArgs $argv) { param($l) $out.Add($l) }
    }
    if ($r.code -ne 0) { throw ((Get-YtdlpError $r.err) + (Get-YoutubeHint $r.err)) }
    $v = @(@($out | Select-Object -Last 14) | ForEach-Object { if ($_ -eq 'NA') { '' } else { $_ } })
    $info = "$tmp.info.json"
    Send @{ rid = $m.rid; event = 'info'; uploader_id = $v[0]; uploader = $v[1]; title = $v[2]; id = $v[3]
      widths = $v[4]; heights = $v[5]; vcodecs = $v[6]; acodecs = $v[7]; filesizes = $v[8]; approx = $v[9]
      vbrs = $v[10]; abrs = $v[11]; tbrs = $v[12]; duration = $v[13]
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

# ------------------------------------------------------------------ compression (HEVC)

function Get-Ff([string]$name) {
  $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

# Resolution, video bitrate and duration of a file.
function Get-Probe([string]$path) {
  $ffprobe = Get-Ff 'ffprobe'
  if (-not $ffprobe) { throw 'ffprobe not found. Run install.bat from the MediaGrab helper folder.' }
  $out = New-Object Collections.Generic.List[string]
  $r = Invoke-Tool $ffprobe @('-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,bit_rate:format=duration,size', '-of', 'json', $path) { param($l) $out.Add($l) }
  if ($r.code -ne 0) { throw "ffprobe failed: $($r.err.Trim())" }
  $j = ($out -join "`n") | ConvertFrom-Json
  $s = @($j.streams)[0]
  if (-not $s) { throw 'no video stream found' }
  $dur = [double]$j.format.duration
  $size = [int64]$j.format.size
  $vbr = 0.0
  if ($s.bit_rate) { $vbr = [double]$s.bit_rate } elseif ($dur -gt 0) { $vbr = [math]::Max(0, $size * 8 / $dur - 128000) }
  return @{ codec = [string]$s.codec_name; w = [int]$s.width; h = [int]$s.height; vkbps = [int][math]::Round($vbr / 1000); dur = $dur; size = $size }
}

# Bitrate limit (kbps) for a resolution: a curve through the 720p and 1080p settings.
function Get-LimitKbps([int]$short, [double]$a720, [double]$a1080) {
  if ($a720 -le 0 -or $a1080 -le $a720) { $a720 = 3000; $a1080 = 5000 }
  $k2 = 2 * [math]::Log($a1080 / $a720) / [math]::Log(2.25)
  return $a1080 * [math]::Pow([math]::Max(144, $short) / 1080.0, $k2)
}

# Quality value per encoder for High / Balanced / Smaller (lower = better quality).
function Get-Quality([string]$enc, [string]$level) {
  $i = @{ high = 0; balanced = 1; small = 2 }[$level]
  if ($null -eq $i) { $i = 1 }
  $t = @{ x265 = @(22, 24, 27); nvenc = @(24, 27, 30); qsv = @(22, 25, 28); amf = @(22, 25, 28) }[$enc]
  return $t[$i]
}

# ffmpeg video encoder arguments. GPU encoders use their slowest, most efficient presets
# ('full'); 'basic' drops the options older GPUs/drivers reject.
function Get-EncoderArgs([string]$enc, [int]$q, [int]$capK, [string]$tier, [string]$x265Preset) {
  $cap = @()
  if ($capK -gt 0) { $cap = @('-maxrate', "${capK}k", '-bufsize', "$($capK * 2)k") }
  switch ($enc) {
    'nvenc' {
      if ($tier -eq 'basic') { return @('-c:v', 'hevc_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', "$q", '-b:v', '0') + $cap }
      return @('-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-multipass', 'fullres', '-rc', 'vbr', '-cq', "$q", '-b:v', '0',
        '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32') + $cap
    }
    'qsv' {
      if ($tier -eq 'basic') { return @('-c:v', 'hevc_qsv', '-global_quality', "$q") }
      return @('-c:v', 'hevc_qsv', '-preset', 'veryslow', '-global_quality', "$q")
    }
    'amf' {
      if ($tier -eq 'basic') { return @('-c:v', 'hevc_amf', '-rc', 'cqp', '-qp_i', "$q", '-qp_p', "$q") }
      return @('-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', "$q", '-qp_p', "$q", '-qp_b', "$q")
    }
    default {
      $preset = $(if ($x265Preset) { $x265Preset } else { 'slow' })
      return @('-c:v', 'libx265', '-preset', $preset, '-crf', "$q", '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error') + $cap
    }
  }
}

# Which HEVC encoders actually work here (a 1-second test encode each). Cached per ffmpeg build.
function Get-Encoders([bool]$force) {
  $ff = Get-Ff 'ffmpeg'
  if (-not $ff) { throw 'ffmpeg not found. Run install.bat from the MediaGrab helper folder.' }
  $stamp = "$ff|$((Get-Item -LiteralPath $ff).LastWriteTimeUtc.Ticks)"
  $s = Read-State
  if (-not $force -and $s.encoders -and $s.encoders.stamp -eq $stamp) { return $s.encoders }
  $out = New-Object Collections.Generic.List[string]
  $null = Invoke-Tool $ff @('-hide_banner', '-encoders') { param($l) $out.Add($l) }
  $listed = $out -join "`n"
  $res = [ordered]@{ stamp = $stamp; x265 = [bool]($listed -match '\blibx265\b') }
  foreach ($e in 'nvenc', 'qsv', 'amf') {
    $tier = $null
    if ($listed -match "\bhevc_$e\b") {
      foreach ($t in 'full', 'basic') {
        $argv = @('-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1') +
          (Get-EncoderArgs $e 28 0 $t 'slow') + @('-f', 'null', '-')
        if ((Invoke-Tool $ff $argv $null).code -eq 0) { $tier = $t; break }
      }
    }
    $res[$e] = $tier
  }
  $s.encoders = $res
  Write-State $s
  return $res
}

function Move-Result([string]$from, [string]$to) {
  if ($from -ne $to) { Move-Item -LiteralPath $from -Destination $to -Force }
}

# Re-encode the video to HEVC (audio copied). mode 'auto' only compresses when the video
# bitrate is over the limit; 'force' always tries. The original is kept when the saving is
# below minSavings %. The result always ends up at $m.output.
function Invoke-Compress($m) {
  $in = [string]$m.input
  $outPath = [string]$m.output
  try {
    $probe = Get-Probe $in
    $short = [math]::Min($probe.w, $probe.h)
    if ($short -le 0) { $short = [math]::Max($probe.w, $probe.h) }
    $limit = [int](Get-LimitKbps $short ([double]$m.limit720) ([double]$m.limit1080))
    $base = @{ rid = $m.rid; event = 'compressed'; vkbps = $probe.vkbps; limit = $limit; origSize = $probe.size }
    if ($m.mode -eq 'auto' -and $probe.vkbps -le $limit) {
      Move-Result $in $outPath
      Send ($base + @{ path = $outPath; size = $probe.size; outcome = 'under-limit' })
      return
    }

    $encs = Get-Encoders $false
    $choice = [string]$m.encoder
    if ($choice -eq 'auto' -or -not $choice) {
      $choice = 'x265'
      foreach ($e in 'nvenc', 'qsv', 'amf') { if ($encs.$e) { $choice = $e; break } }
    }
    $tier = $null
    if ($choice -ne 'x265') { $tier = $encs.$choice; if (-not $tier) { $choice = 'x265' } }
    $cap = [int][math]::Min($limit, [math]::Max(300, $probe.vkbps))

    $ff = Get-Ff 'ffmpeg'
    $tmp = "$outPath.mg-hevc.mp4"
    $state = @{ last = -1; dur = $probe.dur }
    $onLine = {
      param($l)
      if ($l -match '^out_time_(?:us|ms)=(\d+)' -and $state.dur -gt 0) {
        $pct = [int][math]::Min(99, [double]$Matches[1] / 1e6 / $state.dur * 100)
        if ($pct -ne $state.last) { $state.last = $pct; Send @{ rid = $m.rid; event = 'progress'; pct = $pct } }
      }
    }
    $encode = {
      param($enc, $tr)
      $q = Get-Quality $enc ([string]$m.quality)
      $argv = @('-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', $in, '-map', '0:v:0', '-map', '0:a?', '-c:a', 'copy') +
        (Get-EncoderArgs $enc $q $cap $tr ([string]$m.x265Preset)) +
        @('-tag:v', 'hvc1', '-movflags', '+faststart', '-map_metadata', '0', '-progress', 'pipe:1', '-nostats', $tmp)
      return Invoke-Tool $ff $argv $onLine
    }
    $r = & $encode $choice $tier
    if ($r.code -ne 0 -and $choice -ne 'x265') {
      # GPU encoder failed on this file: fall back to the CPU.
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $choice = 'x265'
      $r = & $encode 'x265' $null
    }
    if ($r.code -ne 0) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      throw "ffmpeg failed: $(($r.err.Trim() -split "`r?`n" | Select-Object -Last 2) -join ' ')"
    }

    $newSize = (Get-Item -LiteralPath $tmp).Length
    $saved = [math]::Round((1 - $newSize / [double]$probe.size) * 100)
    if ($saved -lt [double]$m.minSavings) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      Move-Result $in $outPath
      Send ($base + @{ path = $outPath; size = $probe.size; outcome = 'kept'; savedPct = $saved; encoder = $choice })
      return
    }
    Move-Item -LiteralPath $tmp -Destination $outPath -Force
    if ($in -ne $outPath) { Remove-Item -LiteralPath $in -Force -ErrorAction SilentlyContinue }
    Send ($base + @{ path = $outPath; size = $newSize; outcome = 'compressed'; savedPct = $saved; encoder = $choice })
  } catch {
    # Never lose the download: put the original where the user asked for it.
    if ((Test-Path -LiteralPath $in) -and -not (Test-Path -LiteralPath $outPath)) { Move-Result $in $outPath }
    elseif ((Test-Path -LiteralPath $in) -and $in -ne $outPath) { Move-Result $in $outPath }
    $size = $(if (Test-Path -LiteralPath $outPath) { (Get-Item -LiteralPath $outPath).Length } else { $null })
    Send @{ rid = $m.rid; event = 'compressed'; path = $outPath; size = $size; outcome = 'failed'; error = $_.Exception.Message }
  }
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
      } elseif ($m.stage) {
        # Will be compressed next: keep the original under a temporary name for now.
        $target = "$p.mg-src.mp4"
        $staged[[string]$m.id] = $target
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
      $st = $staged[$id]
      if ($st) {
        $staged.Remove($id)
        Send @{ rid = $m.rid; event = 'saved'; path = $p; staged = $st; size = (Get-Item -LiteralPath $st).Length }
      } else {
        Send @{ rid = $m.rid; event = 'saved'; path = $p; size = (Get-Item -LiteralPath $p).Length }
      }
    }
    'save-abort' {
      $id = [string]$m.id
      if ($open[$id]) { $open[$id].Close(); $open.Remove($id) }
      if ($paths[$id]) { Remove-Item -LiteralPath $paths[$id] -Force -ErrorAction SilentlyContinue; $paths.Remove($id) }
      if ($temps[$id]) { Remove-Item -LiteralPath $temps[$id] -Force -ErrorAction SilentlyContinue; $temps.Remove($id) }
      if ($staged[$id]) { Remove-Item -LiteralPath $staged[$id] -Force -ErrorAction SilentlyContinue; $staged.Remove($id) }
      Send @{ rid = $m.rid; event = 'aborted' }
    }
    'ytdlp-info' { Invoke-Info $m }
    'ytdlp-download' { Invoke-Download $m }
    'ytdlp-update' { Invoke-Update $m }
    'compress' { Invoke-Compress $m }
    'encoders' { Send @{ rid = $m.rid; event = 'encoders'; encoders = (Get-Encoders ([bool]$m.force)) } }
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
