# Process stats helper started by procstats.js. Samples the watched processes
# every interval from Windows performance counters only.
#   stdin : one JSON object per line, replacing the watched set:
#           { "pids": [..], "pathPids": [..] }
#   stdout: one JSON object per round:
#           { system: {cores,cpuPct,memTotal,memUsed}, procs: { "<pid>": {...} } }
#
# CPU, memory, threads, handles and start time come from the "Process V2"
# counter set and GPU from "GPU Engine" / "GPU Process Memory", all of which
# Windows collects itself. The exe path comes from WMI, once per PID in pathPids.
#
# CPU % is of the whole PC (all cores = 100%), matching Elastic's
# system.process.cpu.total.norm.pct x 100. GPU % is the 3D engine.
# Exits when the Node app closes stdin.
param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'Continue'
# [Console]::In.ReadLineAsync() blocks in Windows PowerShell 5.1; this doesn't.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$readTask = $reader.ReadLineAsync()
$pids = @()
$pathPids = @{}

$cores = [Environment]::ProcessorCount
$memTotal = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$cpuTotal = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total')
$null = $cpuTotal.NextValue()
$memAvail = New-Object System.Diagnostics.PerformanceCounter('Memory', 'Available Bytes')
function Get-Category($name) {
  try { if ([System.Diagnostics.PerformanceCounterCategory]::Exists($name)) { return New-Object System.Diagnostics.PerformanceCounterCategory($name) } } catch {}
  return $null
}
$procCat = Get-Category 'Process V2'
$gpuEngineCat = Get-Category 'GPU Engine'
$gpuMemCat = Get-Category 'GPU Process Memory'
if (-not $procCat) { [Console]::Error.WriteLine('Process V2 counters not available; CPU and memory will be blank.') }

$paths = @{}      # pid -> exe path from WMI (cached)
$counters = @{}   # "category|counter|instance" -> PerformanceCounter

function Read-Perf($cat, $counter, $inst) {
  $key = "$cat|$counter|$inst"
  try {
    if (-not $counters.ContainsKey($key)) {
      $c = New-Object System.Diagnostics.PerformanceCounter($cat, $counter, $inst, $true)
      $null = $c.NextValue()   # rate counters read 0 the first time; this primes them
      $counters[$key] = $c
    }
    return [double]$counters[$key].NextValue()
  } catch {
    $counters.Remove($key)
    return $null
  }
}

# PID a counter instance belongs to: "name:1234" (Process V2) or "pid_1234_..." (GPU).
function Get-InstancePid($inst) {
  if ($inst -match ':(\d+)$') { return [int]$matches[1] }
  if ($inst -match '^pid_(\d+)_') { return [int]$matches[1] }
  return $null
}

while ($true) {
  $sw = [Diagnostics.Stopwatch]::StartNew()

  while ($readTask.IsCompleted) {
    $line = $readTask.Result
    if ($null -eq $line) { exit 0 }  # parent closed stdin
    if ($line.Trim()) {
      $parsed = $line | ConvertFrom-Json
      $pids = @(foreach ($x in $parsed.pids) { [int]$x })
      $pathPids = @{}
      foreach ($x in $parsed.pathPids) { $pathPids[[string][int]$x] = $true }
      # forget counters for processes no longer watched
      foreach ($k in @($counters.Keys)) {
        $p = Get-InstancePid ($k -split '\|', 3)[2]
        if ($null -eq $p -or $pids -notcontains $p) { $counters.Remove($k) }
      }
    }
    $readTask = $reader.ReadLineAsync()
  }

  if ($pids.Count -gt 0) {
    $procNames = @(); $engineNames = @(); $memNames = @()
    try { if ($procCat) { $procNames = $procCat.GetInstanceNames() } } catch {}
    try { if ($gpuEngineCat) { $engineNames = $gpuEngineCat.GetInstanceNames() } } catch {}
    try { if ($gpuMemCat) { $memNames = $gpuMemCat.GetInstanceNames() } } catch {}
    $instOf = @{}
    foreach ($n in $procNames) { $p = Get-InstancePid $n; if ($null -ne $p) { $instOf[[string]$p] = $n } }

    $procs = @{}
    foreach ($id in $pids) {
      $inst = $instOf[[string]$id]
      if (-not $inst) { continue }   # process has exited
      $o = [ordered]@{
        name = $inst -replace ':\d+$', ''
        ws = $null; priv = $null; threads = $null; handles = $null
        cpuPct = $null; gpu3d = $null; vramDedicated = $null; vramShared = $null; start = $null; path = $null
      }
      $v = Read-Perf 'Process V2' 'Working Set' $inst;   if ($null -ne $v) { $o.ws = [int64]$v }
      $v = Read-Perf 'Process V2' 'Private Bytes' $inst; if ($null -ne $v) { $o.priv = [int64]$v }
      $v = Read-Perf 'Process V2' 'Thread Count' $inst;  if ($null -ne $v) { $o.threads = [int]$v }
      $v = Read-Perf 'Process V2' 'Handle Count' $inst;  if ($null -ne $v) { $o.handles = [int]$v }
      # % Processor Time is per core (can exceed 100); divide by cores for whole-PC %.
      $v = Read-Perf 'Process V2' '% Processor Time' $inst; if ($null -ne $v) { $o.cpuPct = [math]::Round($v / $cores, 1) }
      # Elapsed Time's NextValue() is unreliable; its raw sample holds the start
      # time on the sample clock, so elapsed = (TimeStamp - RawValue) / frequency.
      try {
        $ek = "Process V2|Elapsed Time|$inst"
        if (-not $counters.ContainsKey($ek)) { $counters[$ek] = New-Object System.Diagnostics.PerformanceCounter('Process V2', 'Elapsed Time', $inst, $true) }
        $es = $counters[$ek].NextSample()
        if ($es.CounterFrequency -gt 0 -and $es.TimeStamp -gt $es.RawValue) {
          $ticks = [int64](($es.TimeStamp - $es.RawValue) * (10000000.0 / $es.CounterFrequency))
          $o.start = [DateTime]::FromFileTimeUtc($es.TimeStamp100nSec - $ticks).ToString('o')
        }
      } catch {}

      if ($pathPids.ContainsKey([string]$id)) {
        if (-not $paths.ContainsKey([string]$id)) {
          $paths[[string]$id] = $null
          try { $paths[[string]$id] = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ExecutablePath } catch {}
        }
        $o.path = $paths[[string]$id]
      }

      $prefix = "pid_$($id)_"
      $g = 0.0; $anyG = $false
      foreach ($n in $engineNames) {
        if ($n.StartsWith($prefix) -and $n.EndsWith('engtype_3D')) { $g += [double](Read-Perf 'GPU Engine' 'Utilization Percentage' $n); $anyG = $true }
      }
      if ($anyG) { $o.gpu3d = [math]::Round([math]::Min($g, 100), 1) }
      $d = 0.0; $s = 0.0; $anyM = $false
      foreach ($n in $memNames) {
        if ($n.StartsWith($prefix)) {
          $d += [double](Read-Perf 'GPU Process Memory' 'Dedicated Usage' $n)
          $s += [double](Read-Perf 'GPU Process Memory' 'Shared Usage' $n)
          $anyM = $true
        }
      }
      if ($anyM) { $o.vramDedicated = [int64]$d; $o.vramShared = [int64]$s }
      $procs[[string]$id] = $o
    }

    $out = [ordered]@{
      system = [ordered]@{
        cores = $cores
        cpuPct = [math]::Round($cpuTotal.NextValue(), 1)
        memTotal = $memTotal
        memUsed = [int64]($memTotal - $memAvail.NextValue())
      }
      procs = $procs
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  }

  $left = $IntervalMs - $sw.ElapsedMilliseconds
  if ($left -gt 0) { Start-Sleep -Milliseconds $left }
}
