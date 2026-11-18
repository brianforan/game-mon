# One-off check of the kernel network event capture. Run from an ADMIN
# PowerShell while a game is running:
#   powershell -ExecutionPolicy Bypass -File .\scripts\etw-probe.ps1   (from the game-latency-monitor folder)
# Captures 5 seconds and writes data\debug\etw-probe.json (sample events,
# how they were parsed, and the busiest flows). Nothing leaves this PC.
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'data\debug'
New-Item -ItemType Directory -Force $out | Out-Null
$probe = Join-Path $out 'etw-probe.json'
$sw = [Diagnostics.Stopwatch]::StartNew()
$json = & (Join-Path $root 'src\etw-worker.ps1') -Seconds 5 -Session 'GameLatencyMonitorProbe' -Probe -ProbeOut $probe
$r = $json | ConvertFrom-Json
"Captured $($r.events) events in $([math]::Round($r.seconds,1)) s, parsed $($r.parsed), $(@($r.flows).Count) flows; took $([math]::Round($sw.Elapsed.TotalSeconds,1)) s in total."
"Wrote $probe"
