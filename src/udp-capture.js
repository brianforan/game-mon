// Takes short packet captures with pktmon, which ships with Windows 10/11 (no
// Npcap needed), and turns them into per-flow packet/byte counts. This is how
// the app (1) finds who games talk to over UDP and (2) measures how busy each
// connection is, which tells a live match server apart from web/API calls.
// pktmon needs an elevated (admin) terminal; without one the app falls back to
// TCP-only discovery and no traffic rates.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, mkdtemp, copyFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPacketsWithStats } from './pcapng.js';
import { localAddresses } from './net-util.js';

const run = promisify(execFile);
const opts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let captureRunning = false;

/** Called on Ctrl+C so a capture this app started is never left running. */
export function stopCaptureSync() {
  if (!captureRunning) return;
  try { execFileSync('pktmon', ['stop'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  captureRunning = false;
}

export async function isAdmin() {
  try {
    await run('net', ['session'], opts);
    return true;
  } catch {
    return false;
  }
}

/** Group packets into flows keyed by protocol + local port + remote address. */
export function summarizeFlows(packets, locals) {
  const flows = new Map();
  for (const p of packets) {
    let local, remote, out;
    if (locals.has(p.src.toLowerCase())) { local = [p.src, p.srcPort]; remote = [p.dst, p.dstPort]; out = true; }
    else if (locals.has(p.dst.toLowerCase())) { local = [p.dst, p.dstPort]; remote = [p.src, p.srcPort]; out = false; }
    else continue;
    const proto = p.proto ?? 'udp';
    const key = `${proto}|${local[1]}|${remote[0]}|${remote[1]}`;
    let f = flows.get(key);
    if (!f) {
      f = { proto, localIp: local[0], localPort: local[1], remoteIp: remote[0], remotePort: remote[1], packetsOut: 0, packetsIn: 0, bytesOut: 0, bytesIn: 0 };
      flows.set(key, f);
    }
    if (out) { f.packetsOut++; f.bytesOut += p.len; } else { f.packetsIn++; f.bytesIn += p.len; }
  }
  return [...flows.values()];
}

/**
 * Capture for about `seconds` and return { flows, seconds } where seconds is
 * the measured capture length (used to turn counts into per-second rates).
 * Only stops pktmon if this call started it, so it never interrupts a
 * capture you are running yourself.
 */
export async function captureFlows(seconds = 4, { keepDir } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'glm-'));
  const etl = path.join(dir, 'cap.etl');
  const pcap = path.join(dir, 'cap.pcapng');
  let started = false;
  try {
    await run('pktmon', ['start', '--capture', '--comp', 'nics', '--pkt-size', '96', '--file-size', '32', '--file-name', etl], opts);
    started = captureRunning = true;
    const t0 = Date.now();
    await sleep(seconds * 1000);
    await run('pktmon', ['stop'], opts);
    const measured = (Date.now() - t0) / 1000;
    started = captureRunning = false;
    await run('pktmon', ['etl2pcap', etl, '--out', pcap], opts);
    const { packets, stats } = readPacketsWithStats(await readFile(pcap));
    const locals = localAddresses();
    // Which side of each packet is this PC? Explains missing directions.
    const dir = { srcLocal: 0, dstLocal: 0, neither: 0, flagOutSrcLocal: 0, flagOutDstLocal: 0 };
    for (const p of packets) {
      const s = locals.has(p.src.toLowerCase()), d = locals.has(p.dst.toLowerCase());
      if (s) dir.srcLocal++; else if (d) dir.dstLocal++; else dir.neither++;
      if (p.flagDir === 'out') { if (s) dir.flagOutSrcLocal++; if (d) dir.flagOutDstLocal++; }
    }
    const diag = { ...stats, direction: dir, localAddresses: locals.size, seconds: measured };
    if (keepDir) {
      // Last capture's headers (first 96 bytes of each packet) for troubleshooting.
      await mkdir(keepDir, { recursive: true });
      await copyFile(pcap, path.join(keepDir, 'last-capture.pcapng')).catch(() => {});
      await writeFile(path.join(keepDir, 'last-capture-stats.json'), JSON.stringify(diag, null, 2)).catch(() => {});
    }
    return { flows: summarizeFlows(packets, locals), seconds: measured, diag };
  } finally {
    if (started) {
      await run('pktmon', ['stop'], opts).catch(() => {});
      captureRunning = false;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What a connection is doing, judged from one capture of its traffic.
 *   realtime: steady two-way stream of small packets (a match server, voice chat)
 *   bulk:     lots of data one way (download, video, patching)
 *   light:    some packets but not a steady stream (API calls, keep-alives)
 *   idle:     nothing seen during the capture
 * Roles are judged on incoming traffic only. On some network cards pktmon
 * logs just a fraction of outgoing packets, and which ones varies from capture
 * to capture (seen on this PC: a live match server 104 in / 0 out, Discord
 * voice 182 in / 17 out, in 5 s), so outgoing counts can't be relied on.
 * A match server's steady stream of incoming packets is enough. Packets must
 * average under 1200 bytes: game state updates are usually 50-900 bytes (ROB
 * RUN's instance server: ~690 B at ~24/s) while downloads fill packets to
 * ~1400 B.
 */
export function classifyTraffic(t) {
  if (!t) return 'unknown';
  const out = t.ppsOut ?? 0;
  // When outgoing counts are trustworthy (kernel events), a steady stream in
  // either direction counts, e.g. voice chat while only you are talking.
  // Bulk transfers are checked first: a download's stream of small outgoing
  // ACKs (or an upload's incoming ACKs) would otherwise look like a steady
  // real-time stream. Bulk = over 50 kB/s in big (~1000 B+) packets; a busy
  // game stream stays in smaller packets even at high rates.
  const steady = (pps, bps) => pps >= 8 && bps / pps < 1200;
  const heavy = (pps, bps) => pps > 0 && bps > 50_000 && bps / pps >= 1000;
  if (t.ppsIn === 0 && out === 0) return 'idle';
  if (heavy(t.ppsIn, t.bpsIn) || heavy(out, t.bpsOut ?? 0)) return 'bulk';
  if (steady(t.ppsIn, t.bpsIn)) return 'realtime';
  if (t.ppsOut != null && steady(out, t.bpsOut ?? 0)) return 'realtime';
  return 'light';
}

/**
 * Does this capture see outgoing packets properly? If packets from this PC
 * are under 20% of packets to it, it doesn't (a real conversation is never
 * that lopsided across all apps at once).
 */
export function outboundLooksCaptured(diag) {
  const d = diag?.direction;
  if (!d || d.dstLocal < 50) return true; // too little traffic to judge
  return d.srcLocal >= 0.2 * d.dstLocal;
}
