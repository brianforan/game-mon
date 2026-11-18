// Server locations from ip-api.com (free for non-commercial use, no key).
//   Batch: POST http://ip-api.com/batch, up to 100 IPs, 15 requests/minute.
//   Headers X-Rl (requests left) and X-Ttl (seconds until reset) are obeyed.
//   Free tier is HTTP only, so lookups are not encrypted.
// Each IP is looked up once and cached in data/geo-cache.json for 30 days.
// Your own approximate location (from your public IP) is looked up once so
// distances and the ping plausibility check can be shown.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isPublicIp } from './net-util.js';

const BATCH_URL = 'http://ip-api.com/batch';
const SELF_URL = 'http://ip-api.com/json/';
const FIELDS = 'status,message,country,countryCode,regionName,city,lat,lon,hosting,query';
const MAX_BATCH = 100;
const CACHE_DAYS = 30;
const FLUSH_MS = 3000;

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Can a server at distanceKm answer in minRttMs? Light in fibre covers about
 * 100 km of distance per ms of round trip; allow 20% + 150 km slack for
 * geolocation error. Returns null when there's nothing to compare.
 */
export function plausible(distanceKm, minRttMs) {
  if (distanceKm == null || minRttMs == null || minRttMs <= 0) return null;
  return distanceKm <= minRttMs * 100 * 1.2 + 150;
}

export class GeoLocator {
  constructor({ cacheFile, enabled = true, fetchImpl = globalThis.fetch } = {}) {
    this.cacheFile = cacheFile;
    this.enabled = enabled;
    this.fetch = fetchImpl;
    this.cache = new Map(); // ip -> { city, region, countryCode, country, lat, lon, hosting, at } | { failed, at }
    this.home = null;
    this.queue = new Set();
    this.blockedUntil = 0;
    this.lastError = null;
    this.timer = null;
    if (cacheFile && existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
        const fresh = Date.now() - CACHE_DAYS * 86_400_000;
        for (const [ip, v] of Object.entries(raw.ips ?? {})) if (v.at > fresh) this.cache.set(ip, v);
        if (raw.home && raw.home.at > fresh) this.home = raw.home;
      } catch (e) { console.warn(`Ignoring unreadable ${cacheFile}: ${e.message}`); }
    }
  }

  async start() {
    if (!this.enabled) return;
    if (!this.home) await this.lookupHome().catch((e) => { this.lastError = `home location: ${e.message}`; });
  }

  async lookupHome() {
    const r = await this.fetch(`${SELF_URL}?fields=status,message,city,regionName,countryCode,lat,lon`, { signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    if (j.status !== 'success') throw new Error(j.message ?? 'lookup failed');
    this.home = { city: j.city, region: j.regionName, countryCode: j.countryCode, lat: j.lat, lon: j.lon, at: Date.now() };
    await this.save();
  }

  /** Cached location for an IP, or null (queued for lookup). Never blocks. */
  get(ip) {
    if (!this.enabled || !isPublicIp(ip)) return null;
    const hit = this.cache.get(ip);
    if (hit) return hit.failed ? null : hit;
    this.queue.add(ip);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(FLUSH_MS, this.blockedUntil - Date.now()));
    return null;
  }

  async flush() {
    if (!this.queue.size) return;
    if (Date.now() < this.blockedUntil) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.blockedUntil - Date.now());
      return;
    }
    const batch = [...this.queue].slice(0, MAX_BATCH);
    try {
      const r = await this.fetch(`${BATCH_URL}?fields=${FIELDS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      });
      const left = Number(r.headers.get('x-rl'));
      const ttl = Number(r.headers.get('x-ttl'));
      if (r.status === 429) {
        this.blockedUntil = Date.now() + (Number.isFinite(ttl) ? ttl : 60) * 1000;
        throw new Error('rate limited by ip-api.com');
      }
      if (!r.ok) throw new Error(`ip-api.com HTTP ${r.status}`);
      if (left === 0 && Number.isFinite(ttl)) this.blockedUntil = Date.now() + ttl * 1000;
      const rows = await r.json();
      const now = Date.now();
      for (const row of rows) {
        this.queue.delete(row.query);
        this.cache.set(row.query, row.status === 'success'
          ? { city: row.city, region: row.regionName, countryCode: row.countryCode, country: row.country, lat: row.lat, lon: row.lon, hosting: row.hosting, at: now }
          : { failed: row.message ?? 'fail', at: now });
      }
      for (const ip of batch) this.queue.delete(ip); // anything the service skipped
      this.lastError = null;
      await this.save();
    } catch (e) {
      this.lastError = e.name === 'TimeoutError' ? 'ip-api.com did not answer' : e.message;
      if (!this.blockedUntil || this.blockedUntil < Date.now()) this.blockedUntil = Date.now() + 60_000;
    } finally {
      if (this.queue.size && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(FLUSH_MS, this.blockedUntil - Date.now()));
    }
  }

  /** Location + distance from home + whether it fits the measured ping. */
  describe(ip, minRttMs, method) {
    const g = this.get(ip);
    if (!g) return null;
    const distanceKm = this.home ? Math.round(haversineKm(this.home, g)) : null;
    return {
      city: g.city, region: g.region, countryCode: g.countryCode, country: g.country, lat: g.lat, lon: g.lon, hosting: g.hosting,
      distanceKm,
      // a hop-based reading is a lower bound, so it can't rule a location out
      plausible: method === 'hop' ? null : plausible(distanceKm, minRttMs),
    };
  }

  async save() {
    if (!this.cacheFile) return;
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify({ home: this.home, ips: Object.fromEntries(this.cache) }, null, 1));
  }

  status() {
    return {
      enabled: this.enabled,
      provider: 'ip-api.com',
      cached: [...this.cache.values()].filter((v) => !v.failed).length,
      pending: this.queue.size,
      home: this.home ? { city: this.home.city, region: this.home.region, countryCode: this.home.countryCode } : null,
      error: this.lastError,
    };
  }
}
