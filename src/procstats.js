// Live CPU / memory / GPU for processes the user is looking at. Only runs
// while a process detail view is open: the page polls, which keeps its PIDs
// "watched"; once nothing is watched for a while the helper is shut down.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./proc-worker.ps1', import.meta.url));
const WATCH_TTL_MS = 15_000;
const KEEP_SAMPLES = 90; // 3 minutes at 2 s

export class ProcSampler {
  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.watched = new Map(); // pid -> expiry time
    this.latest = { system: null, procs: {} };
    this.history = new Map(); // pid -> [{ t, cpuPct, ws, gpu3d, vramDedicated }]
    this.child = null;
    this.sent = '';
    this.timer = setInterval(() => this.expire(), 5000);
    this.timer.unref();
  }

  /**
   * Keep these PIDs sampled for the next WATCH_TTL_MS. The helper only reads
   * Windows performance counters, plus a one-off WMI lookup of the exe path.
   */
  watch(pids) {
    const until = Date.now() + WATCH_TTL_MS;
    for (const p of pids) this.watched.set(Number(p), until);
    this.sync();
  }

  expire() {
    const now = Date.now();
    for (const [pid, until] of this.watched) if (until < now) { this.watched.delete(pid); this.history.delete(pid); }
    this.sync();
  }

  sync() {
    if (this.closed) return;
    if (!this.watched.size) {
      if (this.child) { this.child.stdin.end(); this.child = null; }
      return;
    }
    if (!this.child) this.startChild();
    const pids = [...this.watched.keys()].sort((a, b) => a - b);
    const list = JSON.stringify({ pids, pathPids: pids });
    if (list !== this.sent) { this.child.stdin.write(list + '\n'); this.sent = list; }
  }

  startChild() {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WORKER, '-IntervalMs', String(this.intervalMs)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.sent = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      let data;
      try { data = JSON.parse(line); } catch { return; }
      this.latest = { system: data.system, procs: data.procs ?? {}, at: Date.now() };
      for (const [pid, p] of Object.entries(this.latest.procs)) {
        const h = this.history.get(Number(pid)) ?? [];
        h.push({ t: Date.now(), cpuPct: p.cpuPct, ws: p.ws, gpu3d: p.gpu3d, vramDedicated: p.vramDedicated });
        if (h.length > KEEP_SAMPLES) h.shift();
        this.history.set(Number(pid), h);
      }
    });
    child.stderr.on('data', (d) => console.warn(`process stats helper: ${d.toString().trim().slice(0, 300)}`));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (!this.closed && this.watched.size) setTimeout(() => this.sync(), 1000);
    });
  }

  /** Combined live stats + history for a set of PIDs (e.g. all of one exe's processes). */
  get(pids) {
    const procs = pids.map((p) => this.latest.procs[String(p)]).filter(Boolean);
    const sum = (k) => (procs.some((p) => p[k] != null) ? procs.reduce((a, p) => a + (p[k] ?? 0), 0) : null);
    const starts = procs.map((p) => p.start).filter(Boolean).sort();
    const live = procs.length ? {
      cpuPct: sum('cpuPct') == null ? null : Math.round(sum('cpuPct') * 10) / 10,
      ws: sum('ws'), priv: sum('priv'), threads: sum('threads'), handles: sum('handles'),
      gpu3d: sum('gpu3d') == null ? null : Math.min(100, Math.round(sum('gpu3d') * 10) / 10),
      vramDedicated: sum('vramDedicated'), vramShared: sum('vramShared'),
      start: starts[0] ?? null,
      path: procs.find((p) => p.path)?.path ?? null,
    } : null;

    // Merge per-PID histories by sample round (they share the helper's clock).
    const merged = new Map();
    for (const pid of pids) {
      for (const s of this.history.get(Number(pid)) ?? []) {
        const key = Math.round(s.t / 1000);
        const m = merged.get(key) ?? { t: s.t, cpuPct: null, ws: null, gpu3d: null, vramDedicated: null };
        for (const k of ['cpuPct', 'ws', 'gpu3d', 'vramDedicated']) if (s[k] != null) m[k] = (m[k] ?? 0) + s[k];
        merged.set(key, m);
      }
    }
    return {
      live,
      system: this.latest.system,
      history: [...merged.values()].sort((a, b) => a.t - b.t),
      warmingUp: !this.latest.at || procs.length === 0,
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.child?.stdin.end();
    this.child?.kill();
  }
}
