// Finds which processes have which network connections, using the built-in
// `netstat -ano` and `tasklist` commands (no admin needed).
//
// Limitation: for UDP, Windows only reports the *local* port a process has
// open, never who it is talking to. Most games use UDP for gameplay, so the
// remote side of those comes from udp-capture.js (admin only).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { splitHostPort } from './net-util.js';

const run = promisify(execFile);
const opts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };

export function parseNetstat(text) {
  const tcp = [];
  const udp = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.trim().split(/\s+/);
    if (f[0] === 'TCP' && f.length >= 5) {
      const l = splitHostPort(f[1]);
      const r = splitHostPort(f[2]);
      tcp.push({ localIp: l.ip, localPort: l.port, remoteIp: r.ip, remotePort: r.port, state: f[3], pid: Number(f[4]) });
    } else if (f[0] === 'UDP' && f.length >= 4) {
      const l = splitHostPort(f[1]);
      udp.push({ localIp: l.ip, localPort: l.port, pid: Number(f[f.length - 1]) });
    }
  }
  return { tcp, udp };
}

export function parseTasklist(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cols.length >= 2) map.set(Number(cols[1]), cols[0]);
  }
  return map;
}

/** Snapshot of all TCP connections and UDP endpoints, labelled with process names,
 *  plus every running process (pid -> name). tasklist reads the system's process
 *  list; it doesn't open the processes. */
export async function snapshot() {
  const [ns, tl] = await Promise.all([
    run('netstat', ['-ano'], opts),
    run('tasklist', ['/fo', 'csv', '/nh'], opts),
  ]);
  const names = parseTasklist(tl.stdout);
  const { tcp, udp } = parseNetstat(ns.stdout);
  const label = (c) => ({ ...c, process: names.get(c.pid) ?? `pid ${c.pid}` });
  return { tcp: tcp.map(label), udp: udp.map(label), processes: names };
}
