// Traffic counting from Windows kernel network events (see etw-worker.ps1).
// Same result shape as the pktmon capture in udp-capture.js, plus the owning
// PID on every flow. Preferred over pktmon: it sees both directions reliably.
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./etw-worker.ps1', import.meta.url));
export const ETW_SESSION = 'GameLatencyMonitorNet';
let running = false;

/** Called on exit so an ETW session this app started never keeps running. */
export function stopEtwSync() {
  if (!running) return;
  try { execFileSync('logman', ['stop', ETW_SESSION, '-ets'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  running = false;
}

export function captureFlowsEtw(seconds = 4) {
  return new Promise((resolve, reject) => {
    running = true;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
      '-Seconds', String(seconds), '-Session', ETW_SESSION],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: (seconds + 60) * 1000 },
    (err, stdout, stderr) => {
      running = false;
      if (err) return reject(new Error((stderr || err.message).toString().trim().split(/\r?\n/).slice(0, 3).join(' ')));
      const line = stdout.trim().split(/\r?\n/).pop();
      let data;
      try { data = JSON.parse(line); } catch { return reject(new Error(`unreadable ETW output: ${line?.slice(0, 120)}`)); }
      const flows = (data.flows ?? []).map((f) => ({
        proto: f.proto, pid: f.pid,
        localIp: f.localIp, localPort: f.localPort, remoteIp: f.remoteIp, remotePort: f.remotePort,
        packetsIn: f.packetsIn, packetsOut: f.packetsOut, bytesIn: f.bytesIn, bytesOut: f.bytesOut,
      }));
      resolve({ flows, seconds: data.seconds, diag: { method: 'etw', events: data.events, parsed: data.parsed, seconds: data.seconds } });
    });
  });
}
