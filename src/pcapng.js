// Minimal pcapng reader: pulls UDP and TCP packet headers (IPs + ports) out of the
// file that `pktmon etl2pcap` writes. Only what this app needs.

const LINK_ETHERNET = 1;
const LINK_RAW = new Set([101, 228, 229]); // raw IP / raw IPv4 / raw IPv6

function ipv4(buf, o) {
  return `${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}`;
}

function ipv6(buf, o) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(o + i).toString(16));
  // compress the longest run of zero groups, like the standard text form
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (parts[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && parts[j] === '0') j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  if (best[1] < 2) return parts.join(':');
  const head = parts.slice(0, best[0]).join(':');
  const tail = parts.slice(best[0] + best[1]).join(':');
  return `${head}::${tail}`;
}

/** Decode one packet starting at the IP header. Returns a UDP/TCP record or null. */
export function decodeIp(buf, o) {
  if (o >= buf.length) return null;
  const version = buf[o] >> 4;
  if (version === 4 && o + 20 <= buf.length) {
    const ihl = (buf[o] & 0x0f) * 4;
    const proto = buf[o + 9];
    if (proto !== 17 && proto !== 6) return null; // only UDP and TCP
    const u = o + ihl;
    if (u + 8 > buf.length) return null;
    return {
      proto: proto === 17 ? 'udp' : 'tcp',
      src: ipv4(buf, o + 12), dst: ipv4(buf, o + 16),
      srcPort: buf.readUInt16BE(u), dstPort: buf.readUInt16BE(u + 2),
      len: buf.readUInt16BE(o + 2),
    };
  }
  if (version === 6 && o + 48 <= buf.length) {
    const proto = buf[o + 6];
    if (proto !== 17 && proto !== 6) return null; // only UDP and TCP (extension headers ignored)
    const u = o + 40;
    return {
      proto: proto === 17 ? 'udp' : 'tcp',
      src: ipv6(buf, o + 8), dst: ipv6(buf, o + 24),
      srcPort: buf.readUInt16BE(u), dstPort: buf.readUInt16BE(u + 2),
      len: buf.readUInt16BE(o + 4) + 40,
    };
  }
  return null;
}

export function decodeFrame(buf, linkType) {
  if (LINK_RAW.has(linkType)) return decodeIp(buf, 0);
  if (linkType !== LINK_ETHERNET || buf.length < 14) return null;
  let o = 12;
  let type = buf.readUInt16BE(o);
  while ((type === 0x8100 || type === 0x88a8) && o + 6 <= buf.length) { // VLAN tags
    o += 4;
    type = buf.readUInt16BE(o);
  }
  if (type !== 0x0800 && type !== 0x86dd) return null;
  return decodeIp(buf, o + 2);
}

/** Parse a whole pcapng buffer and return every UDP and TCP packet found. */
export function readPackets(buf) {
  return readPacketsWithStats(buf).packets;
}

/**
 * Same, plus counts that explain what was in the file: packets per link
 * type, how many decoded, and the EPB direction flags (1 = in, 2 = out)
 * when the writer sets them.
 */
export function readPacketsWithStats(buf) {
  const out = [];
  const stats = { blocks: 0, packets: 0, decoded: 0, linkTypes: {}, undecodedByLink: {}, flagDir: { none: 0, in: 0, out: 0 }, interfaces: 0 };
  let le = true;
  let links = [];
  let o = 0;
  const u32 = (at) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const u16 = (at) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));

  while (o + 12 <= buf.length) {
    if (buf.readUInt32LE(o) === 0x0a0d0d0a) { // Section Header Block
      le = buf.readUInt32LE(o + 8) === 0x1a2b3c4d;
      links = [];
    }
    const type = u32(o);
    const len = u32(o + 4);
    if (len < 12 || o + len > buf.length) break;
    const body = o + 8;

    stats.blocks++;
    const count = (link, p) => {
      stats.packets++;
      stats.linkTypes[link] = (stats.linkTypes[link] ?? 0) + 1;
      if (p) { stats.decoded++; out.push(p); } else stats.undecodedByLink[link] = (stats.undecodedByLink[link] ?? 0) + 1;
    };
    if (type === 1) {                    // Interface Description Block
      links.push(u16(body));
      stats.interfaces++;
    } else if (type === 6) {             // Enhanced Packet Block
      const ifId = u32(body);
      const capLen = u32(body + 12);
      const dataEnd = body + 20 + capLen;
      const data = buf.subarray(body + 20, dataEnd);
      const link = links[ifId] ?? LINK_ETHERNET;
      const p = decodeFrame(data, link);
      // options start after the 32-bit-padded packet data; epb_flags is option code 2
      let dir = 'none';
      for (let q = dataEnd + ((4 - (capLen % 4)) % 4); q + 4 <= o + len - 4;) {
        const code = u16(q), olen = u16(q + 2);
        if (code === 0) break;
        if (code === 2 && olen === 4) { const f = u32(q + 4) & 3; dir = f === 1 ? 'in' : f === 2 ? 'out' : 'none'; }
        q += 4 + olen + ((4 - (olen % 4)) % 4);
      }
      stats.flagDir[dir]++;
      if (p) p.flagDir = dir;
      count(link, p);
    } else if (type === 3) {             // Simple Packet Block
      const data = buf.subarray(body + 4, o + len - 4);
      const link = links[0] ?? LINK_ETHERNET;
      count(link, decodeFrame(data, link));
    }
    o += len;
  }
  return { packets: out, stats };
}
