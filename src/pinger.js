// Measures round-trip time to one server, falling back when ICMP is blocked:
//   1. icmp - ping the server itself (many game servers drop these)
//   2. tcp  - time a TCP handshake to a port we saw the game use
//   3. hop  - tracert once, then ping the last router that answers before the
//             server. Only a lower bound (the server is further away), and
//             shown as "≥ N ms" in the UI.
//
// ICMP goes through one long-running PowerShell helper (icmp-worker.ps1) that
// pings every target in parallel. Spawning ping.exe per sample stalled Node
// badly enough to skew the TCP timings, so don't go back to that.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { isPublicIp } from './net-util.js';

const SWITCH_AFTER_FAILURES = 3;
const RETRY_ICMP_MS = 60_000;
const KEEP_SAMPLES = 150;
const STATS_WINDOW = 30;
const WORKER = fileURLToPath(new URL('./icmp-worker.ps1', import.meta.url));

function exec(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve(stdout ?? ''));
  });
}

/** Parse one ping.exe reply. Works for English and most other Windows locales. */
export function parsePingOutput(text) {
  const m = text.match(/([=<])\s*(\d+)\s*ms\s+TTL=/i);
  if (!m) return null;
  return m[1] === '<' ? 0.5 : Number(m[2]);
}

/** One-off ping via ping.exe; only used for the occasional "does ICMP work yet?" retry. */
export async function icmpPing(ip, timeoutMs = 1000) {
  return parsePingOutput(await exec('ping', ['-n', '1', '-w', String(timeoutMs), ip], timeoutMs + 2000));
}

export function tcpPing(ip, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const sock = net.connect({ host: ip, port, timeout: timeoutMs });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(ms()));
    // A refused connection still proves a round trip happened.
    sock.once('error', (e) => done(e.code === 'ECONNREFUSED' ? ms() : null));
    sock.once('timeout', () => done(null));
  });
}

/** Parse tracert -d output into [{ hop, ip }] for hops that answered. */
export function parseTracert(text) {
  const hops = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+.*?(\S+)\s*$/);
    if (m && net.isIP(m[2])) hops.push({ hop: Number(m[1]), ip: m[2] });
  }
  return hops;
}

export async function findLastHop(ip) {
  const hops = parseTracert(await exec('tracert', ['-d', '-h', '25', '-w', '500', ip], 120_000))
    .filter((h) => h.ip !== ip);
  const pub = hops.filter((h) => isPublicIp(h.ip));
  return pub.at(-1) ?? hops.at(-1) ?? null;
}

export function computeStats(samples) {
  const win = samples.slice(-STATS_WINDOW);
  const ok = win.map((s) => s.rtt).filter((v) => v != null);
  if (!win.length) return null;
  const loss = ((win.length - ok.length) / win.length) * 100;
  if (!ok.length) return { last: null, avg: null, min: null, max: null, jitter: null, loss, count: win.length };
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  const round = (v) => Math.round(v * 10) / 10;
  return {
    last: win.at(-1).rtt == null ? null : round(win.at(-1).rtt),
    avg: round(ok.reduce((a, b) => a + b, 0) / ok.length),
    min: round(Math.min(...ok)),
    max: round(Math.max(...ok)),
    jitter: ok.length > 1 ? round(jitter / (ok.length - 1)) : 0,
    loss: round(loss),
    count: win.length,
  };
}

/** Owns the PowerShell ICMP helper and routes each round's results to subscribers. */
export class IcmpPool {
  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.subs = new Map(); // ip -> Set<callback>
    this.child = null;
    this.sentList = '';
  }

  ensureChild() {
    if (this.child) return;
    this.child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WORKER, '-IntervalMs', String(this.intervalMs)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.sentList = '';
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let results;
      try { results = JSON.parse(line); } catch { return; }
      for (const [ip, rtt] of Object.entries(results)) for (const cb of this.subs.get(ip) ?? []) cb(rtt);
    });
    this.child.stderr.on('data', (d) => console.warn(`icmp helper: ${d.toString().trim()}`));
    this.child.on('exit', () => {
      this.child = null;
      if (!this.closed && this.subs.size) setTimeout(() => this.sync(), 1000); // restart if it crashed
    });
  }

  sync() {
    if (this.closed) return;
    this.ensureChild();
    const list = JSON.stringify([...this.subs.keys()]);
    if (list !== this.sentList) {
      this.child.stdin.write(list + '\n');
      this.sentList = list;
    }
  }

  subscribe(ip, cb) {
    if (!this.subs.has(ip)) this.subs.set(ip, new Set());
    this.subs.get(ip).add(cb);
    this.sync();
    return () => {
      const s = this.subs.get(ip);
      s?.delete(cb);
      if (s && !s.size) this.subs.delete(ip);
      this.sync();
    };
  }

  close() {
    this.closed = true;
    this.child?.stdin.end();
    this.child?.kill();
  }
}

export class Probe {
  constructor(ip, { pool, intervalMs = 2000, tcpPort = null }) {
    this.ip = ip;
    this.pool = pool;
    this.intervalMs = intervalMs;
    this.tcpPort = tcpPort;
    this.method = 'icmp';
    this.probeIp = ip;      // differs from ip only in "hop" mode
    this.status = 'starting';
    this.samples = [];
    this.failures = 0;
    this.everWorked = false;
    this.lastIcmpRetry = 0;
    this.unsub = null;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.attach();
    return this;
  }

  stop() {
    this.stopped = true;
    this.detach();
  }

  attach() {
    if (this.method === 'tcp') {
      const loop = async () => {
        if (this.stopped || this.method !== 'tcp') return;
        await this.record(await tcpPing(this.ip, this.tcpPort));
        if (!this.stopped && this.method === 'tcp') this.timer = setTimeout(loop, this.intervalMs);
      };
      loop();
    } else {
      this.unsub = this.pool.subscribe(this.probeIp, (rtt) => this.record(rtt));
    }
  }

  detach() {
    clearTimeout(this.timer);
    this.unsub?.();
    this.unsub = null;
  }

  setMethod(method, probeIp = this.ip) {
    this.detach();
    this.method = method;
    this.probeIp = probeIp;
    this.samples = []; // don't mix measurements of different things in one chart
    this.failures = 0;
    this.everWorked = false;
    this.lastIcmpRetry = Date.now();
    if (!this.stopped) this.attach();
  }

  async record(rtt) {
    if (this.stopped || this.busy) return;
    this.samples.push({ t: Date.now(), rtt });
    if (this.samples.length > KEEP_SAMPLES) this.samples.shift();

    if (rtt != null) {
      this.everWorked = true;
      this.failures = 0;
      this.status = 'ok';
    } else {
      this.failures++;
      this.status = this.everWorked ? 'loss' : 'no reply';
    }

    this.busy = true;
    try {
      // This method has never worked for this server: try the next one.
      if (!this.everWorked && this.failures >= SWITCH_AFTER_FAILURES) {
        if (this.method === 'icmp' && this.tcpPort) this.setMethod('tcp');
        else if (this.method !== 'hop') {
          this.detach();
          this.status = 'tracing route';
          this.lastIcmpRetry = Date.now();
          const hop = await findLastHop(this.ip);
          if (this.stopped) return;
          if (hop) { this.hopNumber = hop.hop; this.setMethod('hop', hop.ip); }
          else this.status = 'unreachable';
        }
      } else if (this.method !== 'icmp' && Date.now() - this.lastIcmpRetry > RETRY_ICMP_MS) {
        // Now and then, check whether ICMP to the real server started working.
        this.lastIcmpRetry = Date.now();
        if ((await icmpPing(this.ip)) != null && !this.stopped) this.setMethod('icmp');
      }
    } finally {
      this.busy = false;
    }
  }

  get label() {
    if (this.method === 'tcp') return `tcp:${this.tcpPort}`;
    if (this.method === 'hop') return `router at hop ${this.hopNumber} (${this.probeIp}), server blocks ping: lower bound`;
    return 'icmp';
  }

  stats() {
    return computeStats(this.samples);
  }
}
