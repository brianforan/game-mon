// Small IP helpers shared by the other modules.
import net from 'node:net';
import os from 'node:os';

export function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inV4(ip, cidrBase, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(cidrBase) & mask) >>> 0);
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** True for addresses that could be a real internet server (not LAN, loopback, multicast...). */
export function isPublicIp(ip) {
  if (!ip) return false;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const v = net.isIP(ip);
  if (v === 4) return !PRIVATE_V4.some(([b, n]) => inV4(ip, b, n));
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return false;
    if (/^fe[89ab]/.test(l)) return false; // link-local fe80::/10
    if (/^f[cd]/.test(l)) return false;    // unique-local fc00::/7
    if (l.startsWith('ff')) return false;  // multicast
    return true;
  }
  return false;
}

/** Split "1.2.3.4:443" or "[2001:db8::1%12]:443" into { ip, port }. */
export function splitHostPort(s) {
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    const ip = s.slice(1, end).replace(/%.*$/, '');
    const port = Number(s.slice(end + 2));
    return { ip, port: Number.isFinite(port) ? port : 0 };
  }
  const i = s.lastIndexOf(':');
  const port = Number(s.slice(i + 1));
  return { ip: s.slice(0, i), port: Number.isFinite(port) ? port : 0 };
}

/** Every IP address assigned to this machine. */
export function localAddresses() {
  const set = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) set.add(a.address.replace(/%.*$/, '').toLowerCase());
  }
  return set;
}
