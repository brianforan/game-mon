// Works out who owns a server IP: an optional offline IP-to-ASN database
// (data/ip2asn-v4.tsv[.gz] from iptoasn.com) plus reverse DNS.
// Nothing here sends your IPs to a third-party lookup service.
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ipv4ToInt } from './net-util.js';

// ASNs worth calling out. Everything else just shows the DB's org name.
const KNOWN_ASNS = {
  32590: ['Valve (Steam)', 'game'],
  6507: ['Riot Games', 'game'],
  57976: ['Blizzard', 'game'],
  16509: ['Amazon AWS', 'cloud'],
  14618: ['Amazon AWS', 'cloud'],
  15169: ['Google', 'cloud'],
  396982: ['Google Cloud', 'cloud'],
  8075: ['Microsoft', 'cloud'],
  13335: ['Cloudflare', 'cdn'],
  20940: ['Akamai', 'cdn'],
  16625: ['Akamai', 'cdn'],
  54113: ['Fastly', 'cdn'],
};

// Hostname fragments from reverse DNS that identify an operator.
const RDNS_HINTS = [
  [/valve\.net|steamserver|steamcontent|steampowered/i, 'Valve (Steam)', 'game'],
  [/riotgames|riotcdn|pvp\.net/i, 'Riot Games', 'game'],
  [/blizzard|battle\.net/i, 'Blizzard', 'game'],
  [/epicgames|unrealengine/i, 'Epic Games', 'game'],
  [/\.ea\.com$|eaplay|origin\.com/i, 'Electronic Arts', 'game'],
  [/ubi\.com|ubisoft/i, 'Ubisoft', 'game'],
  [/activision|demonware/i, 'Activision', 'game'],
  [/xboxlive|playfab/i, 'Microsoft gaming', 'game'],
  [/cloudfront\.net/i, 'Amazon CloudFront', 'cdn'],
  [/amazonaws\.com/i, 'Amazon AWS', 'cloud'],
  [/1e100\.net|googleusercontent/i, 'Google', 'cloud'],
  [/akamai/i, 'Akamai', 'cdn'],
  [/cloudflare/i, 'Cloudflare', 'cdn'],
];

export class AsnDb {
  constructor() {
    this.starts = null;
    this.loaded = false;
    this.rows = 0;
  }

  /** Parse iptoasn TSV text: start, end, asn, country, description. */
  loadText(text) {
    const starts = [], ends = [], asns = [], countries = [], orgs = [];
    for (const line of text.split('\n')) {
      const f = line.split('\t');
      if (f.length < 5 || !net.isIPv4(f[0])) continue;
      const asn = Number(f[2]);
      if (!asn) continue; // "Not routed"
      starts.push(ipv4ToInt(f[0]));
      ends.push(ipv4ToInt(f[1]));
      asns.push(asn);
      countries.push(f[3]);
      orgs.push(f[4].trim());
    }
    Object.assign(this, { starts, ends, asns, countries, orgs, loaded: true, rows: starts.length });
    return this;
  }

  loadFile(file) {
    const raw = readFileSync(file);
    return this.loadText((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  }

  lookup(ip) {
    if (!this.loaded || !net.isIPv4(ip)) return null;
    const n = ipv4ToInt(ip);
    let lo = 0, hi = this.starts.length - 1;
    while (lo <= hi) { // rows are sorted by start address
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= n) lo = mid + 1; else hi = mid - 1;
    }
    if (hi < 0 || n > this.ends[hi]) return null;
    return { asn: this.asns[hi], country: this.countries[hi], org: this.orgs[hi] };
  }
}

export function loadAsnDb(dataDir) {
  const db = new AsnDb();
  for (const name of ['ip2asn-v4.tsv', 'ip2asn-v4.tsv.gz']) {
    const file = `${dataDir}/${name}`;
    if (existsSync(file)) {
      try { return db.loadFile(file); } catch (e) { console.warn(`Could not read ${file}: ${e.message}`); }
    }
  }
  return db;
}

async function reverse(ip) {
  const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
  const lookup = dns.reverse(ip).then((names) => names[0] ?? null).catch(() => null);
  return Promise.race([lookup, timeout]);
}

/** Combine the ASN database and reverse DNS into one description of the IP. */
export async function identify(ip, db) {
  const asn = db.lookup(ip);
  const rdns = await reverse(ip);
  let owner = asn?.org ?? null;
  let tag = null;
  const known = asn && KNOWN_ASNS[asn.asn];
  if (known) [owner, tag] = known;
  if (rdns) {
    const hint = RDNS_HINTS.find(([re]) => re.test(rdns));
    if (hint && (!tag || tag !== 'game')) { owner = hint[1]; tag = hint[2]; }
  }
  return { asn: asn?.asn ?? null, org: asn?.org ?? null, country: asn?.country ?? null, rdns, owner, tag };
}
