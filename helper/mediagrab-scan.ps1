# MediaGrab Library Scanner
# A small local web app (http://127.0.0.1 only) that ranks the videos in a folder by how
# much HEVC compression would save, using short stratified sample encodes with your real
# encoder settings, and compresses the ones you pick. Windows PowerShell 5.1+.
# Reuses the MediaGrab Helper's functions (probe, encoders, quality, limits, compress).
param([int]$Port = 0, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Here = $PSScriptRoot
$HostScript = Join-Path $Here 'mediagrab-host.ps1'
$UiFile = Join-Path $Here 'scan-ui.html'
$Root = Join-Path $env:LOCALAPPDATA 'MediaGrab'
$null = New-Item -ItemType Directory -Force -Path $Root
$SettingsFile = Join-Path $Root 'scan-settings.json'
$CacheFile = Join-Path $Root 'scan-cache.json'
$LogFile = Join-Path $Root 'scan.log'

$null = Add-Type -AssemblyName System.Windows.Forms

function Write-Log([string]$msg) {
  try { Add-Content -LiteralPath $LogFile -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg) } catch {}
}

# ------------------------------------------------------------------ settings

$Defaults = [ordered]@{
  folder = ''; recurse = $true
  extensions = '.mp4,.mkv,.mov,.webm'; minSizeMB = 50; exclude = ''; skipComp = $true
  samplesShort = 3; samplesLong = 5; longMinutes = 5; sampleSeconds = 6
  vmaf = $true; vmafSubsample = 5
  skipEfficient = $true; efficientBpp = 0.06
  encoder = 'auto'; quality = '24'; x265Preset = 'slow'
  limit720 = 3000; limit1080 = 5000; limit2160 = 8000
  audioCompress = $true; audioLimit = 200; audioTarget = 128
  minSavings = 15; original = 'recycle'
  # Encode speed (frames/s) by resolution, used to estimate encode time. Defaults are
  # estimates for an RTX 5070 with HEVC NVENC p7 + tune hq + full-res multipass + lookahead.
  fps480 = 800; fps720 = 480; fps1080 = 240; fps1440 = 140; fps2160 = 65
}

function Get-Settings {
  $s = [ordered]@{}
  foreach ($k in $Defaults.Keys) { $s[$k] = $Defaults[$k] }
  try {
    $o = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
    foreach ($p in $o.PSObject.Properties) { if ($s.Contains($p.Name)) { $s[$p.Name] = $p.Value } }
  } catch {}
  return $s
}

function Save-Settings($s) {
  [IO.File]::WriteAllText($SettingsFile, ($s | ConvertTo-Json -Depth 4))
}

# ------------------------------------------------------------------ shared (main + worker)

$SharedText = @'
function ConvertTo-Hash($o) {
  $h = @{}
  foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
  return $h
}

function Get-VideoFiles([string]$folder, [bool]$recurse, $s) {
  if (-not $folder -or -not (Test-Path -LiteralPath $folder -PathType Container)) { throw "Folder not found: $folder" }
  $exts = @(([string]$s.extensions -split '[,; ]+') | Where-Object { $_ } | ForEach-Object { $e = $_.Trim().ToLower(); if (-not $e.StartsWith('.')) { ".$e" } else { $e } })
  $minBytes = [double]$s.minSizeMB * 1MB
  $excl = @(([string]$s.exclude -split '[,;]+') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  $files = Get-ChildItem -LiteralPath $folder -File -Recurse:$recurse -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    if ($exts -notcontains $f.Extension.ToLower()) { continue }
    if ($f.Length -lt $minBytes) { continue }
    if ($s.skipComp -and $f.BaseName -match '_comp$') { continue }
    if ($excl.Count) {
      $parts = $f.DirectoryName.ToLower() -split '[\\/]'
      $skip = $false
      foreach ($x in $excl) { if ($parts -contains $x -or $f.FullName.ToLower().StartsWith($x)) { $skip = $true; break } }
      if ($skip) { continue }
    }
    $f
  }
}

# Copy of all results, taken under the table's lock (the worker writes while we read).
function Get-ResultsSnapshot($table) {
  [Threading.Monitor]::Enter($table.SyncRoot)
  try {
    $arr = New-Object object[] $table.Count
    $table.Values.CopyTo($arr, 0)
    return ,$arr
  } finally { [Threading.Monitor]::Exit($table.SyncRoot) }
}

# Settings that change the prediction: a cached result is reused only if these match.
function Get-AnalysisSig($s) {
  return (@($s.encoder, $s.quality, $s.x265Preset, $s.limit720, $s.limit1080, $s.limit2160,
    $s.audioCompress, $s.audioLimit, $s.audioTarget, $s.samplesShort, $s.samplesLong,
    $s.longMinutes, $s.sampleSeconds, $s.vmaf, $s.vmafSubsample) -join '|')
}
'@
. ([scriptblock]::Create($SharedText))

# ------------------------------------------------------------------ worker (runspace)

$WorkerScript = @'
param($sync, $HostScript, $Root, $CacheFile, $task, $arg, $s, $SharedText)
$ErrorActionPreference = 'Stop'
$env:MEDIAGRAB_LIB = '1'
. $HostScript
. ([scriptblock]::Create($SharedText))
$script:currentRid = 'scan'
$script:lastResult = $null

# Helper events end up here instead of on stdout.
function Send([hashtable]$obj) {
  if ($obj.pid) { $sync.pid = [int]$obj.pid }
  if ($obj.event -eq 'progress' -and $null -ne $obj.pct) {
    $sync.status.pct = $obj.pct
    $sync.status.kbps = $obj.kbps
  }
  if ($obj.event -eq 'compressed') { $script:lastResult = $obj }
}

function Fmt([double]$x) { return $x.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture) }

function Save-Cache {
  $list = Get-ResultsSnapshot $sync.results
  $tmp = "$CacheFile.tmp"
  [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $list -Depth 5 -Compress))
  Move-Item -LiteralPath $tmp -Destination $CacheFile -Force
}

function Set-Result([hashtable]$r) {
  $sync.version = [int]$sync.version + 1
  $r.v = $sync.version
  $sync.results[$r.path] = $r
}

$script:hasVmaf = $null
function Test-Vmaf {
  if ($null -eq $script:hasVmaf) {
    $o = New-Object Collections.Generic.List[string]
    $null = Invoke-Tool (Get-Ff 'ffmpeg') @('-hide_banner', '-filters') { param($l) $o.Add($l) }
    $script:hasVmaf = [bool](($o -join "`n") -match '\blibvmaf\b')
  }
  return $script:hasVmaf
}

function Get-Bucket([int]$short) {
  if ($short -le 480) { return 480 }
  if ($short -le 720) { return 720 }
  if ($short -le 1080) { return 1080 }
  if ($short -le 1440) { return 1440 }
  return 2160
}

# Source video bytes in each window (reads only those parts of the file).
function Measure-Windows([string]$path, [double[]]$starts, [double]$len) {
  $iv = ($starts | ForEach-Object { '{0}%+{1}' -f (Fmt $_), (Fmt $len) }) -join ','
  $out = New-Object Collections.Generic.List[string]
  $null = Invoke-Tool (Get-Ff 'ffprobe') @('-v', 'error', '-select_streams', 'v:0', '-read_intervals', $iv,
    '-show_entries', 'packet=pts_time,dts_time,size', '-of', 'csv=p=0', $path) { param($l) $out.Add($l) }
  $bytes = New-Object double[] $starts.Count
  foreach ($l in $out) {
    $f = $l.Split(',')
    if ($f.Count -lt 3) { continue }
    $t = 0.0
    if (-not [double]::TryParse($f[0], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$t)) {
      if (-not [double]::TryParse($f[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$t)) { continue }
    }
    $sz = 0.0
    if (-not [double]::TryParse($f[2], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$sz)) { continue }
    for ($k = 0; $k -lt $starts.Count; $k++) {
      if ($t -ge $starts[$k] -and $t -lt $starts[$k] + $len) { $bytes[$k] += $sz; break }
    }
  }
  return ,$bytes
}

# Encode one window with the real settings; returns output bytes, measured speed, VMAF.
function Invoke-Sample([string]$path, [double]$start, [double]$len, [string]$enc, [string]$tier, [int]$cap) {
  $ff = Get-Ff 'ffmpeg'
  $tmp = Join-Path $env:TEMP ('mg-sample-' + [guid]::NewGuid().ToString('N') + '.mkv')
  $st = @{ t0 = -1.0; f0 = 0.0; t1 = 0.0; f1 = 0.0; fps = 0.0; sw = [Diagnostics.Stopwatch]::StartNew() }
  $onLine = {
    param($l)
    if ($l -match '^frame=\s*(\d+)\s+fps=\s*([\d.]+)') {
      $fr = [double]$Matches[1]
      $st.fps = [double]$Matches[2]
      $now = $st.sw.Elapsed.TotalSeconds
      if ($st.t0 -lt 0 -and $fr -gt 0) { $st.t0 = $now; $st.f0 = $fr }
      $st.t1 = $now; $st.f1 = $fr
    }
    if ($sync.cancel) { return 'abort' }
  }
  $q = Get-Quality $enc ([string]$s.quality)
  $argv = @('-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', (Fmt $start), '-i', $path, '-t', (Fmt $len),
    '-map', '0:v:0', '-an', '-sn', '-dn') + (Get-EncoderArgs $enc $q $cap $tier ([string]$s.x265Preset)) +
    @('-stats', '-stats_period', '0.5', '-f', 'matroska', $tmp)
  try {
    $r = Invoke-Ffmpeg $ff $argv $onLine (Join-Path $Root 'last-scan-sample.log')
    if ($r.aborted -or $sync.cancel) { throw 'cancelled' }
    if ($r.code -ne 0 -or -not (Test-Path -LiteralPath $tmp)) { throw "sample encode failed: $(($r.err.Trim() -split "`r?`n" | Select-Object -Last 1))" }
    $bytes = (Get-Item -LiteralPath $tmp).Length
    # Speed between the first and last status lines (excludes encoder start-up).
    $speed = $st.fps
    if ($st.t0 -ge 0 -and $st.t1 -gt $st.t0 + 0.4 -and $st.f1 -gt $st.f0) { $speed = ($st.f1 - $st.f0) / ($st.t1 - $st.t0) }
    $vm = $null
    if ($s.vmaf -and (Test-Vmaf)) {
      $sub = [math]::Max(1, [int]$s.vmafSubsample)
      $threads = [math]::Max(1, [Environment]::ProcessorCount)
      $va = @('-hide_banner', '-nostdin', '-v', 'info', '-i', $tmp, '-ss', (Fmt $start), '-t', (Fmt $len), '-i', $path,
        '-lavfi', "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=n_subsample=${sub}:n_threads=${threads}:shortest=1",
        '-f', 'null', '-')
      $rv = Invoke-Ffmpeg $ff $va { param($l) if ($sync.cancel) { return 'abort' } } (Join-Path $Root 'last-scan-vmaf.log')
      if ($rv.aborted -or $sync.cancel) { throw 'cancelled' }
      if ($rv.err -match 'VMAF score:\s*([\d.]+)') { $vm = [double]$Matches[1] }
    }
    return @{ bytes = [double]$bytes; fps = [double]$speed; vmaf = $vm }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Measure-File([IO.FileInfo]$fi, [string]$sig, $encs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $path = $fi.FullName
  $r = @{ path = $path; name = $fi.Name; dir = $fi.DirectoryName; size = [double]$fi.Length
    mtime = $fi.LastWriteTimeUtc.Ticks.ToString(); sig = $sig; status = 'ok'; note = '' }
  try {
    $p = Get-Probe $path
    $fps = 30.0
    if ($p.dur -gt 0 -and $p.frames -gt 0) { $fps = $p.frames / $p.dur }
    $short = [math]::Min($p.w, $p.h)
    if ($short -le 0) { $short = [math]::Max($p.w, $p.h) }
    $frames = [double]$p.frames
    if ($frames -le 0) { $frames = $p.dur * $fps }
    $videoBytes = [math]::Max(0, $p.size - $p.audioBytes)
    $bpp = 0.0
    if ($p.w * $p.h * $fps -gt 0) { $bpp = $p.vkbps * 1000 / ($p.w * $p.h * $fps) }
    $r.w = $p.w; $r.h = $p.h; $r.short = $short; $r.bucket = (Get-Bucket $short); $r.codec = $p.codec
    $r.dur = $p.dur; $r.fps = [math]::Round($fps, 3); $r.frames = $frames; $r.vkbps = $p.vkbps; $r.akbps = $p.akbps
    $r.bpp = [math]::Round($bpp, 4); $r.videoBytes = $videoBytes; $r.audioBytes = $p.audioBytes
    if ($p.dur -le 0) { throw 'unknown duration' }

    if ($s.skipEfficient -and $p.codec -match '^(hevc|av1|vp9)$' -and $bpp -lt [double]$s.efficientBpp) {
      $r.status = 'efficient'
      $r.note = "already $($p.codec) at $([math]::Round($bpp, 3)) bits/pixel"
      $r.predicted = $p.size; $r.saved = 0.0
      return $r
    }

    # Encoder as the compressor would pick it.
    $enc = [string]$s.encoder
    if ($enc -eq 'auto' -or -not $enc) { $enc = 'x265'; foreach ($e in 'nvenc', 'qsv', 'amf') { if ($encs.$e) { $enc = $e; break } } }
    $tier = $null
    if ($enc -ne 'x265') { $tier = $encs.$enc; if (-not $tier) { $enc = 'x265' } }
    $limit = [int](Get-LimitKbps $short ([double]$s.limit720) ([double]$s.limit1080) ([double]$s.limit2160))
    $cap = [int][math]::Min($limit, [math]::Max(300, $p.vkbps))
    $r.encoder = $enc; $r.limit = $limit

    # Windows: whole clip if short, else stratified picks from 12 candidates by bitrate.
    $len = [double]$s.sampleSeconds
    $n = $(if ($p.dur / 60 -ge [double]$s.longMinutes) { [int]$s.samplesLong } else { [int]$s.samplesShort })
    $starts = @(); $src = @()
    if ($p.dur -le [math]::Max($n * $len * 1.5, 12 * $len)) {
      # Short video: candidate windows would overlap, so encode it whole (more accurate).
      $starts = @(0.0); $len = $p.dur; $src = @([double]$videoBytes)
    } else {
      $cands = @(for ($k = 0; $k -lt 12; $k++) { $p.dur * 0.05 + ($p.dur * 0.9 - $len) * $k / 11 })
      $sync.status.step = 'measuring bitrate'
      $cb = Measure-Windows $path ([double[]]$cands) $len
      $order = @(0..11 | Sort-Object { $cb[$_] })
      for ($j = 0; $j -lt $n; $j++) {
        $idx = $order[[int][math]::Floor(($j + 0.5) * 12 / $n)]
        $starts += $cands[$idx]; $src += $cb[$idx]
      }
    }

    $outs = @(); $speeds = @(); $vmafs = @(); $ratios = @()
    for ($k = 0; $k -lt $starts.Count; $k++) {
      if ($sync.cancel) { throw 'cancelled' }
      $sync.status.step = "sample $($k + 1)/$($starts.Count)"
      $sm = Invoke-Sample $path $starts[$k] $len $enc $tier $cap
      $outs += $sm.bytes; $speeds += $sm.fps
      if ($null -ne $sm.vmaf) { $vmafs += $sm.vmaf }
      if ($src[$k] -gt 0) { $ratios += $sm.bytes / $src[$k] }
    }
    $srcSum = ($src | Measure-Object -Sum).Sum
    if ($srcSum -le 0) { throw 'could not measure the source bitrate' }
    $ratio = ($outs | Measure-Object -Sum).Sum / $srcSum
    $reAudio = $s.audioCompress -and $p.akbps -gt [double]$s.audioLimit
    $predAudio = $(if ($reAudio) { [double]$s.audioTarget * 125 * $p.dur } else { [double]$p.audioBytes })
    $pred = $ratio * $videoBytes + $predAudio
    $r.ratio = [math]::Round($ratio, 4)
    $r.ratios = @($ratios | ForEach-Object { [math]::Round($_, 4) })
    $mean = ($ratios | Measure-Object -Average).Average
    $r.spread = $(if ($ratios.Count -gt 1 -and $mean -gt 0) { [math]::Round((($ratios | Measure-Object -Maximum).Maximum - ($ratios | Measure-Object -Minimum).Minimum) / $mean, 3) } else { 0 })
    $r.reAudio = [bool]$reAudio
    $r.predicted = [math]::Round($pred)
    $r.saved = [math]::Max(0, $p.size - $pred)
    $r.measuredFps = [math]::Round((($speeds | Measure-Object -Average).Average), 1)
    if ($vmafs.Count) {
      $r.vmaf = [math]::Round((($vmafs | Measure-Object -Average).Average), 2)
      $r.vmafMin = [math]::Round((($vmafs | Measure-Object -Minimum).Minimum), 2)
    }
    if ($r.saved -le 0) { $r.status = 'no-gain'; $r.note = 'HEVC would not be smaller' }
  } catch {
    if ($sync.cancel -or "$_" -match 'cancelled') { throw 'cancelled' }
    $r.status = 'error'; $r.note = "$($_.Exception.Message)"
  } finally {
    $r.analysisSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  }
  return $r
}

function Invoke-ScanTask {
  $folder = [string]$arg.folder
  $sig = Get-AnalysisSig $s
  $sync.status = @{ phase = 'listing'; message = 'Finding videos...'; i = 0; n = 0; file = ''; step = ''; eta = 0; pct = 0 }
  $files = @(Get-VideoFiles $folder ([bool]$arg.recurse) $s)
  $todo = @($files | Where-Object {
    $c = $sync.results[$_.FullName]
    -not ($c -and $c.sig -eq $sig -and [double]$c.size -eq [double]$_.Length -and $c.mtime -eq $_.LastWriteTimeUtc.Ticks.ToString() -and $c.status -ne 'error')
  })
  $encs = Get-Encoders $false
  $sync.status = @{ phase = 'scanning'; message = ''; i = 0; n = $todo.Count; total = $files.Count; file = ''; step = ''; eta = 0; pct = 0 }
  $times = New-Object Collections.Generic.List[double]
  for ($i = 0; $i -lt $todo.Count; $i++) {
    if ($sync.cancel) { break }
    $f = $todo[$i]
    $sync.status.i = $i + 1
    $sync.status.file = $f.FullName
    $res = $null
    try { $res = Measure-File $f $sig $encs } catch { if ($sync.cancel) { break } else { throw } }
    Set-Result $res
    $times.Add([double]$res.analysisSec)
    $avg = ($times | Measure-Object -Average).Average
    $sync.status.eta = [math]::Round($avg * ($todo.Count - $i - 1))
    if ((($i + 1) % 10) -eq 0) { Save-Cache }
  }
  Save-Cache
  $sync.status.phase = $(if ($sync.cancel) { 'cancelled' } else { 'done' })
  $sync.status.message = "$($sync.status.i) of $($todo.Count) analysed ($($files.Count - $todo.Count) already up to date)"
}

function Invoke-CompressTask {
  $paths = @($arg.paths)
  $sync.status = @{ phase = 'compressing'; message = ''; i = 0; n = $paths.Count; file = ''; step = ''; eta = 0; pct = 0; kbps = 0 }
  for ($i = 0; $i -lt $paths.Count; $i++) {
    if ($sync.cancel) { break }
    $path = [string]$paths[$i]
    $sync.status.i = $i + 1; $sync.status.file = $path; $sync.status.pct = 0; $sync.status.kbps = 0
    $r = $sync.results[$path]
    if (-not $r -or -not (Test-Path -LiteralPath $path)) { continue }
    $script:lastResult = $null
    $m = @{ rid = 'scan'; input = $path; output = $path; mode = 'force'
      limit720 = $s.limit720; limit1080 = $s.limit1080; limit2160 = $s.limit2160
      encoder = $s.encoder; quality = [string]$s.quality; x265Preset = $s.x265Preset; minSavings = $s.minSavings
      audioCompress = $s.audioCompress; audioLimit = $s.audioLimit; audioTarget = $s.audioTarget; onOriginal = $s.original }
    Invoke-Compress $m
    $sync.pid = 0
    $res = $script:lastResult
    $upd = @{}
    foreach ($k in $r.Keys) { $upd[$k] = $r[$k] }
    if ($res) {
      $upd.outcome = $res.outcome
      $upd.outPath = $res.path
      $upd.outSize = $res.size
      $upd.actualSavedPct = $res.savedPct
      $upd.original = $res.original
      $upd.error = $res.error
      $upd.status = $(if ($res.outcome -eq 'compressed') { 'compressed' } else { $r.status })
    }
    Set-Result $upd
    Save-Cache
  }
  $sync.status.phase = $(if ($sync.cancel) { 'cancelled' } else { 'done' })
  $sync.status.message = 'Compression finished'
}

try {
  if ($task -eq 'scan') { Invoke-ScanTask } elseif ($task -eq 'compress') { Invoke-CompressTask }
} catch {
  $sync.status.phase = 'error'
  $sync.status.message = "$($_.Exception.Message)"
} finally {
  $sync.busy = $false
  $sync.pid = 0
}
'@

# ------------------------------------------------------------------ state

$sync = [hashtable]::Synchronized(@{
  status = @{ phase = 'idle'; message = ''; i = 0; n = 0; file = ''; step = ''; eta = 0; pct = 0 }
  cancel = $false; pid = 0; busy = $false; version = 0
  results = [hashtable]::Synchronized(@{})
  lastPing = [DateTime]::UtcNow
})

try {
  if (Test-Path -LiteralPath $CacheFile) {
    foreach ($o in @(Get-Content -LiteralPath $CacheFile -Raw | ConvertFrom-Json)) {
      $h = ConvertTo-Hash $o
      if ($h.path) { $h.v = 0; $sync.results[$h.path] = $h }
    }
  }
} catch { Write-Log "cache load failed: $_" }

$script:worker = $null
function Start-Worker([string]$task, $arg) {
  if ($sync.busy) { throw 'Another job is running.' }
  $sync.busy = $true
  $sync.cancel = $false
  $rs = [runspacefactory]::CreateRunspace()
  $rs.ApartmentState = 'STA'
  $rs.Open()
  $ps = [powershell]::Create()
  $ps.Runspace = $rs
  $null = $ps.AddScript($WorkerScript).AddArgument($sync).AddArgument($HostScript).AddArgument($Root).AddArgument($CacheFile).
    AddArgument($task).AddArgument($arg).AddArgument((Get-Settings)).AddArgument($SharedText)
  $script:worker = @{ ps = $ps; rs = $rs; handle = $ps.BeginInvoke() }
}

function Stop-Job2 {
  $sync.cancel = $true
  $procId = [int]$sync.pid
  if ($procId -gt 0) {
    # Same marker the helper uses, so a cancelled GPU encode isn't retried on the CPU.
    try { [IO.File]::WriteAllText((Join-Path $Root "cancel-$procId"), '') } catch {}
    try { $null = & (Join-Path $env:WINDIR 'System32\taskkill.exe') /PID $procId /T /F 2>&1 } catch {}
  }
}

function Get-EncodersCached {
  try {
    $o = Get-Content -LiteralPath (Join-Path $Root 'state.json') -Raw | ConvertFrom-Json
    return $o.encoders
  } catch { return $null }
}

# ------------------------------------------------------------------ HTTP (127.0.0.1 only)

$token = [guid]::NewGuid().ToString('N')
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$url = "http://127.0.0.1:$port/?t=$token"
Write-Log "listening on $url"
if (-not $NoBrowser) { Start-Process $url }

$latin1 = [Text.Encoding]::GetEncoding(28591)

function Read-Request($client) {
  $stream = $client.GetStream()
  $stream.ReadTimeout = 5000
  $ms = New-Object IO.MemoryStream
  $buf = New-Object byte[] 16384
  $headEnd = -1
  while ($headEnd -lt 0) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { return $null }
    $ms.Write($buf, 0, $n)
    if ($ms.Length -gt 2MB) { return $null }
    $headEnd = $latin1.GetString($ms.ToArray()).IndexOf("`r`n`r`n")
  }
  $all = $ms.ToArray()
  $lines = $latin1.GetString($all, 0, $headEnd) -split "`r`n"
  $first = $lines[0] -split ' '
  $headers = @{}
  foreach ($l in @($lines | Select-Object -Skip 1)) {
    $i = $l.IndexOf(':')
    if ($i -gt 0) { $headers[$l.Substring(0, $i).Trim().ToLower()] = $l.Substring($i + 1).Trim() }
  }
  $len = 0
  if ($headers['content-length']) { $len = [int]$headers['content-length'] }
  $bodyStart = $headEnd + 4
  while ($all.Length - $bodyStart -lt $len) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
    $all = $ms.ToArray()
  }
  $body = ''
  if ($len -gt 0) { $body = [Text.Encoding]::UTF8.GetString($all, $bodyStart, [math]::Min($len, $all.Length - $bodyStart)) }
  return @{ method = $first[0]; target = $first[1]; headers = $headers; body = $body; stream = $stream }
}

function Send-Response($stream, [int]$code, [string]$type, [byte[]]$body) {
  $reason = @{ 200 = 'OK'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 409 = 'Conflict'; 500 = 'Internal Server Error' }[$code]
  $head = "HTTP/1.1 $code $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  $stream.Write($body, 0, $body.Length)
  $stream.Flush()
}

function Send-Json($stream, $obj, [int]$code = 200) {
  $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress
  Send-Response $stream $code 'application/json; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($json))
}

function Invoke-Route($req) {
  $st = $req.stream
  $pathOnly = ($req.target -split '\?')[0]
  # Only our own page may talk to us: Host must be us; API calls need the session token and
  # a same-origin (or absent) Origin. Stops other websites from driving the API.
  $okHost = @("127.0.0.1:$port", "localhost:$port")
  if ($okHost -notcontains $req.headers['host']) { Send-Response $st 403 'text/plain' ([Text.Encoding]::ASCII.GetBytes('forbidden')); return }
  if ($pathOnly -eq '/') {
    Send-Response $st 200 'text/html; charset=utf-8' ([IO.File]::ReadAllBytes($UiFile))
    return
  }
  if (-not $pathOnly.StartsWith('/api/')) { Send-Response $st 404 'text/plain' ([Text.Encoding]::ASCII.GetBytes('not found')); return }
  $origin = $req.headers['origin']
  if ($req.headers['x-token'] -ne $token -or ($origin -and $okHost -notcontains ($origin -replace '^https?://', ''))) {
    Send-Response $st 403 'text/plain' ([Text.Encoding]::ASCII.GetBytes('forbidden')); return
  }
  $sync.lastPing = [DateTime]::UtcNow
  $in = $null
  if ($req.body) { $in = $req.body | ConvertFrom-Json }

  switch ($pathOnly) {
    '/api/state' {
      Send-Json $st @{ status = $sync.status; busy = [bool]$sync.busy; version = [int]$sync.version; settings = (Get-Settings); encoders = (Get-EncodersCached) }
    }
    '/api/results' {
      $since = 0
      if ($req.target -match '[?&]since=(\d+)') { $since = [int]$Matches[1] }
      $list = @(Get-ResultsSnapshot $sync.results | Where-Object { $since -eq 0 -or [int]$_.v -gt $since })
      # Analysed with different settings than the current ones: flag as outdated.
      $sig = Get-AnalysisSig (Get-Settings)
      foreach ($r in $list) { $r.stale = ($r.sig -ne $sig) }
      Send-Json $st @{ version = [int]$sync.version; full = ($since -eq 0); results = $list }
    }
    '/api/settings' {
      $s = Get-Settings
      foreach ($p in $in.PSObject.Properties) { if ($s.Contains($p.Name)) { $s[$p.Name] = $p.Value } }
      Save-Settings $s
      Send-Json $st @{ ok = $true; settings = $s }
    }
    '/api/browse' {
      $owner = New-Object System.Windows.Forms.Form
      $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
      $owner.Show(); $owner.Activate()
      $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
      $dlg.Description = 'Folder to scan'
      $cur = [string](Get-Settings).folder
      if ($cur -and (Test-Path -LiteralPath $cur)) { $dlg.SelectedPath = $cur }
      $res = $dlg.ShowDialog($owner)
      $owner.Close()
      Send-Json $st @{ path = $(if ($res -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.SelectedPath } else { $null }) }
    }
    '/api/estimate' {
      $s = Get-Settings
      $files = @(Get-VideoFiles ([string]$in.folder) ([bool]$in.recurse) $s)
      $sig = Get-AnalysisSig $s
      $fresh = 0; $bytes = 0.0
      $times = @(Get-ResultsSnapshot $sync.results | Where-Object { $_.analysisSec -and $_.status -ne 'efficient' } | ForEach-Object { [double]$_.analysisSec })
      foreach ($f in $files) {
        $bytes += $f.Length
        $c = $sync.results[$f.FullName]
        if (-not ($c -and $c.sig -eq $sig -and [double]$c.size -eq [double]$f.Length -and $c.mtime -eq $f.LastWriteTimeUtc.Ticks.ToString())) { $fresh++ }
      }
      # Seconds per file: measured median if we have history, else a rough 1080p30 model.
      $per = 0.0
      if ($times.Count -ge 5) { $per = ($times | Sort-Object)[[int]($times.Count / 2)] }
      else {
        $n = [double]$s.samplesShort
        $sampleSec = [double]$s.sampleSeconds * 30 / [math]::Max(1, [double]$s.fps1080) + 0.8
        $per = 1.2 + $n * $sampleSec + $(if ($s.vmaf) { $n * 1.5 } else { 0 })
      }
      Send-Json $st @{ files = $files.Count; bytes = $bytes; toAnalyse = $fresh; secondsPerFile = [math]::Round($per, 1); seconds = [math]::Round($per * $fresh); measured = ($times.Count -ge 5) }
    }
    '/api/scan' {
      if ($sync.busy) { Send-Json $st @{ error = 'A job is already running.' } 409; return }
      $s = Get-Settings
      $s.folder = [string]$in.folder; $s.recurse = [bool]$in.recurse
      Save-Settings $s
      Start-Worker 'scan' @{ folder = [string]$in.folder; recurse = [bool]$in.recurse }
      Send-Json $st @{ ok = $true }
    }
    '/api/compress' {
      if ($sync.busy) { Send-Json $st @{ error = 'A job is already running.' } 409; return }
      Start-Worker 'compress' @{ paths = @($in.paths) }
      Send-Json $st @{ ok = $true }
    }
    '/api/cancel' { Stop-Job2; Send-Json $st @{ ok = $true } }
    '/api/open' {
      $p = [string]$in.path
      if ($p -and (Test-Path -LiteralPath $p)) { Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$p`"" }
      Send-Json $st @{ ok = $true }
    }
    '/api/quit' { $script:running = $false; Send-Json $st @{ ok = $true } }
    default { Send-Response $st 404 'text/plain' ([Text.Encoding]::ASCII.GetBytes('not found')) }
  }
}

$script:running = $true
$clients = New-Object Collections.Generic.List[object]
try {
  while ($script:running) {
    # Finished worker: collect it.
    if ($script:worker -and $script:worker.handle.IsCompleted) {
      try { $null = $script:worker.ps.EndInvoke($script:worker.handle) } catch { Write-Log "worker: $_" }
      foreach ($e in $script:worker.ps.Streams.Error) { Write-Log "worker error: $e" }
      $script:worker.ps.Dispose(); $script:worker.rs.Dispose()
      $script:worker = $null
    }
    # Page closed (no requests for 20 s) and nothing running: exit.
    if (-not $sync.busy -and ([DateTime]::UtcNow - $sync.lastPing).TotalSeconds -gt 20) { break }
    # Accept new connections, but only read the ones that have sent something: browsers
    # open idle "pre-connections" that would otherwise stall this single-threaded loop.
    while ($listener.Pending()) { $clients.Add(@{ c = $listener.AcceptTcpClient(); at = [DateTime]::UtcNow }) }
    $ready = @($clients | Where-Object { $_.c.Available -gt 0 })
    foreach ($old in @($clients | Where-Object { $_.c.Available -le 0 -and ([DateTime]::UtcNow - $_.at).TotalSeconds -gt 10 })) {
      try { $old.c.Close() } catch {}
      $null = $clients.Remove($old)
    }
    if (-not $ready.Count) { Start-Sleep -Milliseconds 30; continue }
    foreach ($item in $ready) {
      $null = $clients.Remove($item)
      $client = $item.c
      try {
        $req = Read-Request $client
        if ($req) {
          try { Invoke-Route $req }
          catch {
            Write-Log "route $($req.target): $_"
            try { Send-Json $req.stream @{ error = "$($_.Exception.Message)" } 500 } catch {}
          }
        }
      } catch { Write-Log "request: $_" }
      finally { $client.Close() }
    }
  }
} finally {
  if ($sync.busy) { Stop-Job2 }
  $listener.Stop()
  Write-Log 'stopped'
}
