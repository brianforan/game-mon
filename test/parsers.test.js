import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstat, parseTasklist } from '../src/discovery.js';
import { parsePingOutput, parseTracert, computeStats } from '../src/pinger.js';
import { readPackets } from '../src/pcapng.js';
import { summarizeFlows, classifyTraffic } from '../src/udp-capture.js';
import { groupSessions } from '../src/history/sessions.js';
import { AsnDb } from '../src/identify.js';
import { isPublicIp, splitHostPort } from '../src/net-util.js';

test('netstat: TCP and UDP rows, IPv4 and IPv6', () => {
  const { tcp, udp } = parseNetstat(`
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    192.168.1.20:51234    162.249.72.1:443       ESTABLISHED     4120
  TCP    [2600:1::5]:50000      [2606:4700::1111]:443  ESTABLISHED     88
  UDP    0.0.0.0:7000           *:*                                    4120
  UDP    [::]:5353              *:*                                    300
`);
  assert.deepEqual(tcp[0], { localIp: '192.168.1.20', localPort: 51234, remoteIp: '162.249.72.1', remotePort: 443, state: 'ESTABLISHED', pid: 4120 });
  assert.equal(tcp[1].remoteIp, '2606:4700::1111');
  assert.deepEqual(udp.map((u) => [u.localPort, u.pid]), [[7000, 4120], [5353, 300]]);
});

test('tasklist CSV, including names with spaces', () => {
  const m = parseTasklist('"League of Legends.exe","4120","Console","1","1,234 K"\r\n"cs2.exe","88","Console","1","9 K"');
  assert.equal(m.get(4120), 'League of Legends.exe');
  assert.equal(m.get(88), 'cs2.exe');
});

test('ping output parsing', () => {
  assert.equal(parsePingOutput('Reply from 1.1.1.1: bytes=32 time=14ms TTL=59'), 14);
  assert.equal(parsePingOutput('Reply from 127.0.0.1: bytes=32 time<1ms TTL=128'), 0.5);
  assert.equal(parsePingOutput('Antwort von 1.1.1.1: Bytes=32 Zeit=9ms TTL=59'), 9);
  assert.equal(parsePingOutput('Request timed out.'), null);
  assert.equal(parsePingOutput('Reply from 192.168.1.1: Destination host unreachable.'), null);
});

test('tracert parsing keeps answering hops only', () => {
  const hops = parseTracert(`
Tracing route to 1.1.1.1 over a maximum of 4 hops

  1    <1 ms    <1 ms    <1 ms  192.168.1.1
  2     7 ms     5 ms     2 ms  198.51.100.1
  3     *        *        *     Request timed out.
  4     3 ms     3 ms     3 ms  203.0.113.92

Trace complete.`);
  assert.deepEqual(hops.map((h) => h.ip), ['192.168.1.1', '198.51.100.1', '203.0.113.92']);
});

test('stats: average, jitter and loss', () => {
  const s = computeStats([10, 20, null, 30].map((rtt, i) => ({ t: i, rtt })));
  assert.equal(s.avg, 20);
  assert.equal(s.jitter, 10);
  assert.equal(s.loss, 25);
  assert.equal(s.last, 30);
});

test('public IP classification', () => {
  for (const ip of ['1.1.1.1', '162.249.72.1', '2606:4700::1111']) assert.ok(isPublicIp(ip), ip);
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.20.1.1', '127.0.0.1', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '239.1.1.1']) assert.ok(!isPublicIp(ip), ip);
  assert.deepEqual(splitHostPort('[fe80::1%12]:443'), { ip: 'fe80::1', port: 443 });
});

// Build a tiny little-endian pcapng: SHB, one Ethernet IDB, two UDP packets.
function block(type, body) {
  const pad = (4 - (body.length % 4)) % 4;
  const len = 12 + body.length + pad;
  const b = Buffer.alloc(len);
  b.writeUInt32LE(type, 0); b.writeUInt32LE(len, 4);
  body.copy(b, 8);
  b.writeUInt32LE(len, len - 4);
  return b;
}
function udpFrame(src, dst, sport, dport) {
  const eth = Buffer.alloc(14); eth.writeUInt16BE(0x0800, 12);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45; ip.writeUInt16BE(48, 2); ip[9] = 17;
  src.split('.').forEach((v, i) => (ip[12 + i] = +v));
  dst.split('.').forEach((v, i) => (ip[16 + i] = +v));
  const udp = Buffer.alloc(8); udp.writeUInt16BE(sport, 0); udp.writeUInt16BE(dport, 2);
  return Buffer.concat([eth, ip, udp, Buffer.alloc(20)]);
}
function epb(frame) {
  const h = Buffer.alloc(20);
  h.writeUInt32LE(0, 0); h.writeUInt32LE(frame.length, 12); h.writeUInt32LE(frame.length, 16);
  return block(6, Buffer.concat([h, frame]));
}

test('pcapng: UDP packets decoded and grouped into flows', () => {
  const shb = Buffer.alloc(16); shb.writeUInt32LE(0x1a2b3c4d, 0); shb.writeUInt16LE(1, 4); shb.writeBigInt64LE(-1n, 8);
  const idb = Buffer.alloc(8); idb.writeUInt16LE(1, 0); idb.writeUInt32LE(96, 4);
  const file = Buffer.concat([
    block(0x0a0d0d0a, shb), block(1, idb),
    epb(udpFrame('192.168.1.20', '162.249.72.1', 7000, 7100)),
    epb(udpFrame('162.249.72.1', '192.168.1.20', 7100, 7000)),
  ]);
  const pkts = readPackets(file);
  assert.equal(pkts.length, 2);
  assert.deepEqual(pkts[0], { proto: 'udp', src: '192.168.1.20', dst: '162.249.72.1', srcPort: 7000, dstPort: 7100, len: 48, flagDir: 'none' });

  const flows = summarizeFlows(pkts, new Set(['192.168.1.20']));
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0], { proto: 'udp', localIp: '192.168.1.20', localPort: 7000, remoteIp: '162.249.72.1', remotePort: 7100, packetsOut: 1, packetsIn: 1, bytesOut: 48, bytesIn: 48 });
});

test('ASN lookup by binary search', () => {
  const db = new AsnDb().loadText([
    '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
    '1.0.1.0\t1.0.3.255\t0\tNone\tNot routed',
    '162.249.72.0\t162.249.79.255\t6507\tUS\tRIOT-GAMES',
  ].join('\n'));
  assert.equal(db.lookup('1.0.0.9').asn, 13335);
  assert.equal(db.lookup('162.249.72.1').org, 'RIOT-GAMES');
  assert.equal(db.lookup('1.0.2.1'), null);
  assert.equal(db.lookup('9.9.9.9'), null);
});

test('traffic roles: match server vs download vs API', () => {
  assert.equal(classifyTraffic({ ppsIn: 30, ppsOut: 30, bpsIn: 30 * 120, bpsOut: 30 * 90 }), 'realtime');
  assert.equal(classifyTraffic({ ppsIn: 800, ppsOut: 400, bpsIn: 800 * 1400, bpsOut: 400 * 60 }), 'bulk');
  assert.equal(classifyTraffic({ ppsIn: 1, ppsOut: 1, bpsIn: 900, bpsOut: 300 }), 'light');
  assert.equal(classifyTraffic({ ppsIn: 0, ppsOut: 1.1, bpsIn: 0, bpsOut: 50 }), 'light');
  assert.equal(classifyTraffic({ ppsIn: 0, ppsOut: 0, bpsIn: 0, bpsOut: 0 }), 'idle');
  assert.equal(classifyTraffic(null), 'unknown');
});

test('Elastic minutes are grouped into sessions at gaps', () => {
  const m = 60_000;
  const b = (min, cpu, mem, pid = 1) => ({ t: min * m, cpu, mem, pids: [pid] });
  const sessions = groupSessions([b(0, 10, 100), b(1, 20, 300), b(2, 30, 200), b(30, 5, 50, 2), b(31, 15, 70, 2)], 10 * m);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].minutes, 3);
  assert.equal(sessions[0].cpuAvg, 20);
  assert.equal(sessions[0].cpuPeak, 30);
  assert.equal(sessions[0].memPeak, 300);
  assert.equal(sessions[0].end - sessions[0].start, 3 * m);
  assert.deepEqual(sessions[1].pids, [2]);
});

test('roles ignore missing outgoing packets (real captures from this PC)', async () => {
  const { classifyTraffic, outboundLooksCaptured } = await import('../src/udp-capture.js');
  // live match server: 104 in / 0 out in 5 s, 62-byte packets
  assert.equal(classifyTraffic({ ppsIn: 20.8, ppsOut: 0, bpsIn: 20.8 * 62, bpsOut: 0 }), 'realtime');
  // Discord voice in a capture where outgoing was partly seen: 182 in / 17 out in 5.5 s
  assert.equal(classifyTraffic({ ppsIn: 33, ppsOut: 3.1, bpsIn: 33 * 223, bpsOut: 300 }), 'realtime');
  // ROB RUN instance server via kernel events: 127 in / 143 out in 5.28 s, ~693-byte updates
  assert.equal(classifyTraffic({ ppsIn: 24.1, ppsOut: 27.1, bpsIn: 88063 / 5.28, bpsOut: 143 * 33 / 5.28 }), 'realtime');
  // QUIC/HTTP download: full-size packets
  assert.equal(classifyTraffic({ ppsIn: 400, ppsOut: 40, bpsIn: 400 * 1350, bpsOut: 40 * 60 }), 'bulk');
  // Discord voice while only you talk (kernel events, outgoing trustworthy)
  assert.equal(classifyTraffic({ ppsIn: 2.3, ppsOut: 14.4, bpsIn: 250, bpsOut: 14.4 * 120 }), 'realtime');
  // an upload fills outgoing packets: not real-time
  assert.equal(classifyTraffic({ ppsIn: 30, ppsOut: 300, bpsIn: 30 * 60, bpsOut: 300 * 1400 }).startsWith('real'), false);
  // hub server
  assert.equal(classifyTraffic({ ppsIn: 0.6, ppsOut: 0, bpsIn: 25, bpsOut: 0 }), 'light');
  assert.equal(outboundLooksCaptured({ direction: { srcLocal: 19, dstLocal: 365 } }), false);
  assert.equal(outboundLooksCaptured({ direction: { srcLocal: 300, dstLocal: 365 } }), true);
  assert.equal(outboundLooksCaptured({ direction: { srcLocal: 0, dstLocal: 10 } }), true);
});

test('history: daily playtime covers every day of the window and summary weights by minutes', async () => {
  const { dailyMinutes, summarize } = await import('../src/history/sessions.js');
  const now = new Date(2026, 10, 16, 12, 0).getTime();
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const buckets = [at(14, 20), at(14, 20, 1), at(16, 9), at(16, 9, 1), at(16, 9, 2)].map((t) => ({ t }));
  const daily = dailyMinutes(buckets, 3, now);
  assert.deepEqual(daily.map((d) => [d.day, d.minutes]), [['2026-11-14', 2], ['2026-11-15', 0], ['2026-11-16', 3]]);

  const s = summarize([
    { start: 0, end: 600_000, minutes: 10, cpuAvg: 10, cpuPeak: 20, memAvg: 100, memPeak: 150, vramPeak: null },
    { start: 0, end: 1_800_000, minutes: 30, cpuAvg: 30, cpuPeak: 40, memAvg: 200, memPeak: 300, vramPeak: 5 },
  ]);
  assert.equal(s.minutes, 40);
  assert.equal(s.cpuAvg, 25);
  assert.equal(s.memPeak, 300);
  assert.equal(s.vramPeak, 5);
  assert.equal(s.longestMs, 1_800_000);
  assert.equal(summarize([]), null);
});
