# Counts network traffic per process for a few seconds using Windows' own
# kernel network events (provider Microsoft-Windows-Kernel-Network, the same
# data Resource Monitor shows). Unlike a packet capture at the network card,
# this sees every send/receive at the socket layer, in both directions, with
# the owning PID - so NIC offloads that merge packets don't hide anything.
# Needs an elevated (admin) process. Started by etw-capture.js.
#
# Output (stdout, one line of JSON):
#   { seconds, events, parsed, flows: [ { proto, pid, localIp, localPort,
#     remoteIp, remotePort, packetsIn, packetsOut, bytesIn, bytesOut } ] }
# "packets" are send/receive events: one per datagram for UDP, one per
# send/receive call for TCP (TCP may merge several segments into one).
#
# -Probe writes raw samples + parsing results to -ProbeOut for troubleshooting.
param(
  [double]$Seconds = 4,
  [string]$Session = 'GameLatencyMonitorNet',
  [switch]$Probe,
  [string]$ProbeOut
)

$ErrorActionPreference = 'Stop'
$etl = Join-Path $env:TEMP "$Session.etl"

# Clean up any session a previous run left behind (e.g. after a crash).
$null = logman stop $Session -ets 2>&1
Remove-Item $etl -ErrorAction SilentlyContinue

# All keywords, level 4 (informational), file capped at 64 MB.
$startOut = logman start $Session -p 'Microsoft-Windows-Kernel-Network' 0xffffffffffffffff 4 -o $etl -max 64 -ets 2>&1
if ($LASTEXITCODE -ne 0) { throw "logman start failed ($LASTEXITCODE): $startOut" }
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  Start-Sleep -Milliseconds ([int]($Seconds * 1000))
} finally {
  $null = logman stop $Session -ets 2>&1
}
$measured = $sw.Elapsed.TotalSeconds

# Field order for each event, from the provider's own manifest.
$meta = @{}
foreach ($e in (Get-WinEvent -ListProvider 'Microsoft-Windows-Kernel-Network').Events) {
  $d = [string]$e.Description
  # Events 10/11 (TCPv4), 26/27 (TCPv6), 42/43 (UDPv4), 58/59 (UDPv6).
  # Retransmits (14/30) are skipped: they're repeats, not new traffic.
  if ($d -notmatch 'retransmitted' -and $d -match '^(TCP|UDP)v(4|6):.*?bytes (transmitted|received|sent)') {
    $names = @()
    if ($e.Template) { $names = @(([xml]$e.Template).template.data | ForEach-Object { $_.name }) }
    $meta[[int]$e.Id] = @{ proto = $matches[1].ToLower(); dir = $(if ($matches[3] -eq 'received') { 'in' } else { 'out' }); names = $names; desc = $d }
  }
}

function Format-Addr($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [byte[]]) { return ([Net.IPAddress]::new($v)).ToString() }
  if ($v -is [uint32] -or $v -is [int32] -or $v -is [int64] -or $v -is [uint64]) { return ([Net.IPAddress]::new([int64][uint32]$v)).ToString() }
  return [string]$v
}
function Format-Port($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [uint16] -or $v -is [int32] -or $v -is [uint32]) { $n = [int]$v; return (($n -band 0xFF) -shl 8) -bor (($n -shr 8) -band 0xFF) }  # network byte order
  return [int]"$v"
}

# "UDPv4: 140 bytes transmitted from 192.168.1.20:49828 to 91.199.82.189:36701."
$msgRe = [regex]'^(TCP|UDP)v(4|6): (\d+) bytes (transmitted|received|sent) from \[?(.+?)\]?:(\d+) to \[?(.+?)\]?:(\d+)'

$events = @()
try { $events = @(Get-WinEvent -Path $etl -Oldest -ErrorAction Stop) } catch { if ($_.Exception.Message -notmatch 'No events were found') { throw } }
Remove-Item $etl -ErrorAction SilentlyContinue

$localAddrs = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  foreach ($u in $nic.GetIPProperties().UnicastAddresses) { $null = $localAddrs.Add(($u.Address.ToString() -replace '%.*$', '').ToLower()) }
}

$flows = @{}
$parsed = 0
$samples = New-Object System.Collections.ArrayList
foreach ($ev in $events) {
  $m = $meta[[int]$ev.Id]
  if (-not $m) { continue }
  $props = @($ev.Properties | ForEach-Object { $_.Value })
  $idx = @{}; for ($i = 0; $i -lt $m.names.Count; $i++) { $idx[$m.names[$i]] = $i }
  $procId = $(if ($idx.ContainsKey('PID')) { [int]$props[$idx['PID']] } else { [int]$ev.ProcessId })
  $size = $(if ($idx.ContainsKey('size')) { [int64]$props[$idx['size']] } else { 0 })

  # Prefer the rendered message (manifest formats the addresses for us);
  # fall back to raw properties if the message can't be read.
  $msg = $null
  try { $msg = $ev.Message } catch {}
  $a = $null
  if ($msg) {
    $r = $msgRe.Match($msg)
    if ($r.Success) {
      $size = [int64]$r.Groups[3].Value
      $a = @{ fromIp = $r.Groups[5].Value; fromPort = [int]$r.Groups[6].Value; toIp = $r.Groups[7].Value; toPort = [int]$r.Groups[8].Value }
    }
  }
  if (-not $a -and $idx.ContainsKey('daddr')) {
    $daddr = Format-Addr $props[$idx['daddr']]; $saddr = Format-Addr $props[$idx['saddr']]
    $dport = Format-Port $props[$idx['dport']]; $sport = Format-Port $props[$idx['sport']]
    # The manifest renders every event as "from %4:%6 to %3:%5", i.e. from
    # saddr:sport to daddr:dport, for sends and receives alike.
    $a = @{ fromIp = $saddr; fromPort = $sport; toIp = $daddr; toPort = $dport }
  }
  if (-not $a) { continue }
  $parsed++

  # Which side is this PC? Decided by our own addresses, not by the event's
  # wording: TCP receive events render "from <this PC> to <remote>" while UDP
  # receives render "from <remote> to <this PC>". Loopback: fall back to direction.
  $fromLocal = $localAddrs.Contains(([string]$a.fromIp).ToLower())
  $toLocal = $localAddrs.Contains(([string]$a.toIp).ToLower())
  $fromIsLocal = $(if ($fromLocal -ne $toLocal) { $fromLocal } else { $m.dir -eq 'out' })
  if ($fromIsLocal) { $local = $a.fromIp; $lport = $a.fromPort; $remote = $a.toIp; $rport = $a.toPort }
  else { $local = $a.toIp; $lport = $a.toPort; $remote = $a.fromIp; $rport = $a.fromPort }

  $key = "$($m.proto)|$procId|$lport|$remote|$rport"
  $f = $flows[$key]
  if (-not $f) {
    $f = [ordered]@{ proto = $m.proto; pid = $procId; localIp = $local; localPort = $lport; remoteIp = $remote; remotePort = $rport; packetsIn = 0; packetsOut = 0; bytesIn = 0; bytesOut = 0 }
    $flows[$key] = $f
  }
  if ($m.dir -eq 'in') { $f.packetsIn++; $f.bytesIn += $size } else { $f.packetsOut++; $f.bytesOut += $size }

  if ($Probe -and $samples.Count -lt 40) {
    $null = $samples.Add([ordered]@{ id = $ev.Id; dir = $m.dir; proto = $m.proto; recordPid = $ev.ProcessId; props = @($props | ForEach-Object { "$_" }); names = $m.names; message = $msg; parsed = $a })
  }
}

$result = [ordered]@{ seconds = $measured; events = $events.Count; parsed = $parsed; flows = @($flows.Values) }

if ($Probe) {
  $byId = @{}; foreach ($ev in $events) { $k = [string]$ev.Id; $byId[$k] = 1 + [int]$byId[$k] }
  $probeDoc = [ordered]@{
    seconds = $measured; events = $events.Count; parsed = $parsed; eventsById = $byId
    knownEvents = @($meta.Keys | Sort-Object | ForEach-Object { [ordered]@{ id = $_; proto = $meta[$_].proto; dir = $meta[$_].dir; names = $meta[$_].names; desc = $meta[$_].desc } })
    samples = $samples
    topFlows = @($flows.Values | Sort-Object { $_.packetsIn + $_.packetsOut } -Descending | Select-Object -First 25)
  }
  $probeDoc | ConvertTo-Json -Depth 6 | Set-Content -Path $ProbeOut -Encoding UTF8
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
