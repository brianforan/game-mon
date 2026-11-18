// Ties everything together: polls connections, keeps one Probe per server,
// runs packet captures when elevated (UDP discovery + traffic rates), keeps a
// timeline of servers appearing/disappearing, and writes summaries to the log.
// Every process's connections are tracked; the dashboard filters by category.
import dns from 'node:dns/promises';
import net from 'node:net';
import { snapshot } from './discovery.js';
import { isAdmin, captureFlows, classifyTraffic, outboundLooksCaptured } from './udp-capture.js';
import { captureFlowsEtw } from './etw-capture.js';
import { identify } from './identify.js';
import { Probe, IcmpPool, computeStats } from './pinger.js';
import { isPublicIp } from './net-util.js';
import { targetFields } from './logger.js';

const MIN_UDP_PACKETS = 3;
const MAX_EVENTS = 500;
const TRAFFIC_HISTORY = 40;
// When a server is used by several processes, the most game-like one names it.
const CATEGORY_RANK = ['game', 'game-services', 'chat', 'browser', 'media', 'developer', 'productivity', 'cloud-sync', 'security', 'other', 'system', 'unlabelled'];
const rankOf = (c) => { const i = CATEGORY_RANK.indexOf(c); return i < 0 ? CATEGORY_RANK.length : i; };

export class Monitor {
  constructor(config, { asnDb, logger, classifier, procSampler, history, geo }) {
    this.cfg = config;
    this.asnDb = asnDb;
    this.logger = logger;
    this.classifier = classifier;
    this.procSampler = procSampler;
    this.history = history;
    this.geo = geo;
    this.logCategories = new Set(config.log.categories ?? ['game', 'pinned']);
    this.targets = new Map(); // ip -> target
    this.flows = [];          // latest capture's flows (UDP + TCP)
    this.flowsAt = 0;
    this.capture = { status: 'checking', lastCapture: null, error: null };
    this.lastPoll = { at: null, error: null, tcp: 0, udpEndpoints: 0 };
    this.lastSnap = { tcp: [], udp: [], processes: new Map() };
    this.events = [];
    this.stopped = false;
    this.pool = new IcmpPool(config.pingIntervalMs);
  }

  geoOf(t) {
    return this.geo?.describe(t.ip, t.probe.stats()?.min, t.probe.method) ?? null;
  }

  logInfo(t) {
    return { ...this.describe(t), geo: this.geoOf(t) };
  }

  /** Category + friendly label for a server, from its most game-like process. */
  describe(t) {
    if (t.kind === 'pinned') return { category: 'pinned', label: null, exe: null, source: null };
    let best = null;
    for (const exe of t.processes) {
      const c = this.classifier.get(exe);
      if (!best || rankOf(c.category) < rankOf(best.category)) best = { ...c, exe };
    }
    return best ?? { category: 'unlabelled', label: null, exe: null, source: null };
  }

  async start() {
    for (const p of this.cfg.pinnedTargets ?? []) await this.addPinned(p.host, p.name).catch((e) => console.warn(e.message));
    const every = (ms, fn) => {
      const loop = async () => {
        if (this.stopped) return;
        await fn().catch((e) => console.warn(e.message));
        if (!this.stopped) setTimeout(loop, ms);
      };
      loop();
    };
    every(this.cfg.pollIntervalMs, () => this.poll());
    if (this.logger.enabled) every(this.cfg.log.summaryIntervalMs, async () => this.logSummaries());

    if (!this.cfg.udpCapture?.enabled) this.capture.status = 'disabled in config';
    else if (!(await isAdmin())) this.capture.status = 'needs admin';
    else {
      this.capture.status = 'active';
      every(this.cfg.udpCapture.intervalMs, () => this.captureRound());
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.targets.values()) t.probe.stop();
    this.pool.close();
  }

  addEvent(type, t, extra = {}) {
    const info = t.info ?? {};
    this.events.push({
      t: Date.now(), type, ip: t.ip, port: t.lastPort, transports: [...t.transports],
      processes: [...t.processes], owner: info.owner ?? info.org ?? null, country: info.country ?? null,
      role: t.role ?? null, ...extra,
    });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  async addPinned(host, name) {
    const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
    const t = this.upsert(ip, { kind: 'pinned', name: name || host });
    t.kind = 'pinned';
    t.name = name || host;
    return t;
  }

  remove(ip, reason = 'removed') {
    const t = this.targets.get(ip);
    if (!t) return false;
    t.probe.stop();
    this.targets.delete(ip);
    if (t.kind !== 'pinned') this.addEvent('gone', t, { reason, durationMs: t.lastSeen - t.firstSeen });
    if (this.logCategories.has(this.describe(t).category)) this.logger.write({ event: { kind: 'event', action: 'target-end', reason, module: 'game_latency', dataset: 'game_latency.event' }, ...targetFields(t, this.logInfo(t)) });
    return true;
  }

  upsert(ip, { kind, name, process, pid, port, transport }) {
    let t = this.targets.get(ip);
    const isNew = !t;
    if (!t) {
      const nonPinned = [...this.targets.values()].filter((x) => x.kind !== 'pinned').length;
      if (kind !== 'pinned' && nonPinned >= this.cfg.maxTargets) return null;
      t = {
        ip, kind, name: name ?? null,
        processes: new Set(), pids: new Set(), ports: new Set(), transports: new Set(),
        lastPort: null, firstSeen: Date.now(), lastSeen: Date.now(), info: null,
        traffic: null, trafficAt: 0, trafficHistory: [], role: null,
        probe: new Probe(ip, { pool: this.pool, intervalMs: this.cfg.pingIntervalMs, tcpPort: transport === 'tcp' ? port : null }).start(),
      };
      this.targets.set(ip, t);
      this.geo?.get(ip); // queue the location lookup
      identify(ip, this.asnDb).then((info) => {
        t.info = info;
        for (const e of this.events) if (e.ip === ip && !e.owner) { e.owner = info.owner ?? info.org ?? null; e.country = info.country ?? null; }
        if (this.logCategories.has(this.describe(t).category)) this.logger.write({ event: { kind: 'event', action: 'target-start', module: 'game_latency', dataset: 'game_latency.event' }, ...targetFields(t, this.logInfo(t)) });
      });
    }
    t.lastSeen = Date.now();
    if (process) t.processes.add(process);
    if (pid) t.pids.add(pid);
    if (port) { t.ports.add(port); t.lastPort = port; }
    if (transport) t.transports.add(transport);
    if (transport === 'tcp' && port && !t.probe.tcpPort) t.probe.tcpPort = port;
    if (isNew && t.kind !== 'pinned') this.addEvent('appeared', t);
    return t;
  }

  async poll() {
    try {
      const snap = await snapshot();
      this.lastSnap = snap;
      // Most game-like processes first, so they win if we hit maxTargets.
      const rank = (name) => rankOf(this.classifier.get(name).category);
      const order = (list) => [...list].sort((a, b) => rank(a.process) - rank(b.process));

      let tcpCount = 0;
      for (const c of order(snap.tcp)) {
        if (c.state !== 'ESTABLISHED' || c.pid === process.pid || !isPublicIp(c.remoteIp)) continue;
        tcpCount++;
        this.upsert(c.remoteIp, { kind: 'connection', process: c.process, pid: c.pid, port: c.remotePort, transport: 'tcp' });
      }

      // Match captured UDP flows to their process: ETW flows carry the PID;
      // pktmon flows are matched on the local port the process has open.
      const udpOwners = new Map();
      for (const e of snap.udp) if (e.pid !== process.pid) udpOwners.set(e.localPort, e);
      const pidNames = new Map([...snap.tcp, ...snap.udp].map((c) => [c.pid, c.process]));
      for (const f of this.flows) {
        if (f.proto !== 'udp' || f.pid === process.pid) continue;
        const owner = f.pid != null
          ? { pid: f.pid, process: pidNames.get(f.pid) ?? udpOwners.get(f.localPort)?.process ?? `pid ${f.pid}` }
          : udpOwners.get(f.localPort);
        if (!owner || !isPublicIp(f.remoteIp) || f.packetsIn + f.packetsOut < MIN_UDP_PACKETS) continue;
        this.upsert(f.remoteIp, { kind: 'connection', process: owner.process, pid: owner.pid, port: f.remotePort, transport: 'udp' });
      }

      this.applyTraffic();

      const cutoff = Date.now() - this.cfg.staleAfterMs;
      for (const t of [...this.targets.values()]) if (t.kind !== 'pinned' && t.lastSeen < cutoff) this.remove(t.ip, 'stale');

      this.lastPoll = { at: Date.now(), error: null, tcp: tcpCount, udpEndpoints: udpOwners.size };
    } catch (e) {
      this.lastPoll = { ...this.lastPoll, at: Date.now(), error: e.message };
    }
  }

  async captureRound() {
    const secs = this.cfg.udpCapture.seconds;
    const method = this.cfg.udpCapture.method ?? 'etw';
    let result, etwError = null;
    try {
      if (method === 'etw') {
        try {
          result = await captureFlowsEtw(secs);
        } catch (e) {
          // Fall back to pktmon for this round so discovery keeps working.
          etwError = e.message;
          console.warn(`Kernel network events failed, using pktmon this round: ${etwError}`);
        }
      }
      if (!result) result = await captureFlows(secs, { keepDir: this.cfg.udpCapture.keepLastCaptureDir });
      const { flows, seconds, diag } = result;
      this.flows = flows;
      this.flowsSeconds = seconds;
      this.flowsAt = Date.now();
      // pktmon only: once a capture shows outgoing packets going missing, stop
      // trusting outgoing counts for the rest of the session.
      const usedEtw = diag?.method === 'etw';
      if (!usedEtw && !outboundLooksCaptured(diag)) this.outboundUnreliable = true;
      this.capture = {
        status: 'active', method: usedEtw ? 'etw' : 'pktmon', lastCapture: this.flowsAt, flows: flows.length,
        error: etwError ? `kernel events failed, used pktmon: ${etwError.slice(0, 200)}` : null,
        diag, outboundCaptured: usedEtw || !this.outboundUnreliable,
      };
      this.applyTraffic();
    } catch (e) {
      this.capture = { ...this.capture, status: 'error', error: (e.stderr || e.message || '').toString().trim().slice(0, 300) };
    }
  }

  /** Turn the latest capture into per-server rates and a role (realtime, bulk...). */
  applyTraffic() {
    if (!this.flowsAt) return;
    const secs = this.flowsSeconds || this.cfg.udpCapture.seconds;
    const outOk = this.capture.method === 'etw' || this.capture.outboundCaptured !== false;
    const byIp = new Map();
    for (const f of this.flows) {
      const a = byIp.get(f.remoteIp) ?? { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
      a.packetsIn += f.packetsIn; a.packetsOut += f.packetsOut; a.bytesIn += f.bytesIn; a.bytesOut += f.bytesOut;
      byIp.set(f.remoteIp, a);
    }
    for (const t of this.targets.values()) {
      if (t.trafficAt >= this.flowsAt) continue;
      const a = byIp.get(t.ip) ?? { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };
      const r1 = (v) => Math.round(v * 10) / 10;
      t.traffic = {
        ppsIn: r1(a.packetsIn / secs), bpsIn: Math.round(a.bytesIn / secs),
        // null = this PC's capture doesn't see outgoing packets reliably
        ppsOut: outOk ? r1(a.packetsOut / secs) : null, bpsOut: outOk ? Math.round(a.bytesOut / secs) : null,
      };
      t.trafficAt = this.flowsAt;
      t.trafficHistory.push({ t: this.flowsAt, ...t.traffic });
      if (t.trafficHistory.length > TRAFFIC_HISTORY) t.trafficHistory.shift();
      const role = classifyTraffic(t.traffic);
      if (role !== t.role) {
        const prev = t.role;
        t.role = role;
        if (prev && t.kind !== 'pinned' && (role === 'realtime' || prev === 'realtime')) this.addEvent('role', t, { prevRole: prev });
      }
    }
  }

  logSummaries() {
    const since = Date.now() - this.cfg.log.summaryIntervalMs;
    for (const t of this.targets.values()) {
      const recent = t.probe.samples.filter((s) => s.t >= since);
      const s = computeStats(recent);
      const d = this.describe(t);
      if (!s || !this.logCategories.has(d.category)) continue;
      const doc = { event: { kind: 'metric', module: 'game_latency', dataset: 'game_latency.summary' }, ...targetFields(t, { ...d, geo: this.geoOf(t) }) };
      Object.assign(doc.game_latency, {
        method: t.probe.method,
        probe_ip: t.probe.probeIp,
        rtt_ms: { last: s.last, avg: s.avg, min: s.min, max: s.max },
        jitter_ms: s.jitter,
        loss_pct: s.loss,
        samples: s.count,
        ...(t.traffic ? { traffic: { role: t.role, pps_in: t.traffic.ppsIn, pps_out: t.traffic.ppsOut, bytes_in_per_s: t.traffic.bpsIn, bytes_out_per_s: t.traffic.bpsOut } } : {}),
      });
      this.logger.write(doc);
    }
  }

  targetView(t) {
    return {
      ip: t.ip,
      kind: t.kind,
      ...(({ category, label, exe, source }) => ({ category, processLabel: label, processExe: exe, labelSource: source }))(this.describe(t)),
      name: t.name,
      processes: [...t.processes],
      ports: [...t.ports].slice(-5),
      transports: [...t.transports],
      info: t.info,
      method: t.probe.method,
      methodLabel: t.probe.label,
      status: t.probe.status,
      stats: t.probe.stats(),
      samples: t.probe.samples.slice(-90).map((s) => [s.t, s.rtt]),
      firstSeen: t.firstSeen,
      traffic: t.traffic,
      trafficAt: t.trafficAt || null,
      role: t.role,
      geo: this.geoOf(t),
    };
  }

  state() {
    const targets = [...this.targets.values()].map((t) => this.targetView(t));
    const rank = (t) => (t.category === 'pinned' ? 99 : rankOf(t.category));
    targets.sort((a, b) => rank(a) - rank(b) || (a.stats?.avg ?? 1e9) - (b.stats?.avg ?? 1e9));
    return {
      now: Date.now(),
      labels: this.classifier.status(),
      udp: this.capture,
      asnDb: { loaded: this.asnDb.loaded, rows: this.asnDb.rows },
      poll: this.lastPoll,
      logging: this.logger.enabled ? { file: this.logger.file() } : null,
      history: { configured: !!this.history?.configured },
      geo: this.geo?.status() ?? null,
      targets,
    };
  }

  /** Everything known about one executable, for the process detail view. */
  processDetail(exe) {
    const key = exe.toLowerCase();
    const mine = (c) => String(c.process).toLowerCase() === key;
    const tcp = this.lastSnap.tcp.filter(mine);
    const udp = this.lastSnap.udp.filter(mine);
    const pids = [...new Set([...tcp, ...udp].map((c) => c.pid))];
    if (pids.length) this.procSampler.watch(pids);
    const servers = [...this.targets.values()]
      .filter((t) => [...t.processes].some((p) => p.toLowerCase() === key))
      .map((t) => ({ ...this.targetView(t), trafficHistory: t.trafficHistory }));
    const rolesRank = { realtime: 0, bulk: 1, light: 2, idle: 3, unknown: 4 };
    servers.sort((a, b) => (rolesRank[a.role] ?? 5) - (rolesRank[b.role] ?? 5) || (a.stats?.avg ?? 1e9) - (b.stats?.avg ?? 1e9));
    return {
      now: Date.now(),
      exe,
      ...this.classifier.get(exe),
      pids,
      running: pids.length > 0,
      resources: this.procSampler.get(pids),
      capture: this.capture,
      servers,
      sockets: {
        tcp: tcp.map(({ localIp, localPort, remoteIp, remotePort, state, pid }) => ({ localIp, localPort, remoteIp, remotePort, state, pid })),
        udp: udp.map(({ localIp, localPort, pid }) => ({ localIp, localPort, pid })),
      },
      timeline: this.events.filter((e) => e.processes.some((p) => p.toLowerCase() === key)).slice(-150).reverse(),
      historyConfigured: !!this.history?.configured,
    };
  }
}
