# ICMP helper started by pinger.js. One long-running process pings every
# target in parallel each interval using .NET's Ping class (no admin needed).
#   stdin : one JSON array of IPs per line, replacing the current set
#   stdout: one JSON object per round, {"ip": rttMs-or-null, ...}
# When the Node app exits, stdin closes and this script exits too.
param([int]$IntervalMs = 2000, [int]$TimeoutMs = 1000)

$ErrorActionPreference = 'Stop'
# [Console]::In.ReadLineAsync() secretly blocks in Windows PowerShell 5.1;
# a StreamReader over the raw stdin stream reads truly in the background.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$readTask = $reader.ReadLineAsync()
$targets = @()

while ($true) {
  $started = [Diagnostics.Stopwatch]::StartNew()

  while ($readTask.IsCompleted) {
    $line = $readTask.Result
    if ($null -eq $line) { exit 0 }  # parent closed stdin
    if ($line.Trim()) { $parsed = $line | ConvertFrom-Json; $targets = @(foreach ($x in $parsed) { [string]$x }) }
    $readTask = $reader.ReadLineAsync()
  }

  if ($targets.Count -gt 0) {
    $pending = @{}
    foreach ($ip in $targets) {
      try { $pending[$ip] = (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, $TimeoutMs) }
      catch { $pending[$ip] = $null }
    }
    $out = @{}
    foreach ($ip in $pending.Keys) {
      $task = $pending[$ip]
      $rtt = $null
      try {
        if ($task -and $task.Wait($TimeoutMs + 500) -and $task.Result.Status -eq 'Success') {
          $rtt = [double]$task.Result.RoundtripTime
          if ($rtt -lt 1) { $rtt = 0.5 }
        }
      } catch { $rtt = $null }
      $out[$ip] = $rtt
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }

  $left = $IntervalMs - $started.ElapsedMilliseconds
  if ($left -gt 0) { Start-Sleep -Milliseconds $left }
}
