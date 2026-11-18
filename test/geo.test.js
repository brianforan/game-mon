import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GeoLocator, haversineKm, plausible } from '../src/geo.js';

const NYC = { lat: 40.71, lon: -74.01 };
const ASHBURN = { lat: 39.04, lon: -77.49 };
const LUXEMBOURG = { lat: 49.61, lon: 6.13 };

test('distances and the ping plausibility check', () => {
  const d = haversineKm(NYC, ASHBURN);
  assert.ok(d > 330 && d < 370, `New York-Ashburn ${d} km`);
  assert.ok(haversineKm(NYC, LUXEMBOURG) > 6000);
  assert.equal(plausible(350, 7), true);        // Ashburn at 7 ms: fine
  assert.equal(plausible(6200, 7), false);      // Luxembourg at 7 ms: impossible
  assert.equal(plausible(6200, 85), true);      // Luxembourg at 85 ms: possible
  assert.equal(plausible(null, 7), null);
});

// Fake ip-api.com: answers from a table and records requests.
function fakeApi(table, { status = 200, rl = '14', ttl = '60' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body });
    if (url.includes('/json/')) return { ok: true, status: 200, headers: new Map(), json: async () => ({ status: 'success', city: 'New York', regionName: 'New York', countryCode: 'US', ...NYC }) };
    const ips = JSON.parse(init.body);
    return {
      ok: status === 200, status,
      headers: new Map([['x-rl', rl], ['x-ttl', ttl]]),
      json: async () => ips.map((ip) => (table[ip] ? { status: 'success', query: ip, ...table[ip] } : { status: 'fail', message: 'reserved range', query: ip })),
    };
  };
  return { calls, fetchImpl };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('batches lookups, caches to disk, flags impossible locations', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'glm-geo-'));
  const cacheFile = path.join(dir, 'geo.json');
  const api = fakeApi({
    '45.67.211.39': { city: 'Ashburn', regionName: 'Virginia', countryCode: 'US', ...ASHBURN, hosting: true },
    '91.199.82.189': { city: 'Luxembourg', regionName: 'Luxembourg', countryCode: 'LU', ...LUXEMBOURG, hosting: true },
  });
  const g = new GeoLocator({ cacheFile, fetchImpl: api.fetchImpl });
  await g.start();
  assert.equal(g.home.city, 'New York');
  assert.equal(g.get('45.67.211.39'), null); // queued
  g.get('91.199.82.189');
  g.get('192.168.1.1'); // private: never sent
  await wait(3200);
  const batches = api.calls.filter((c) => c.url.includes('/batch'));
  assert.equal(batches.length, 1);
  assert.deepEqual(JSON.parse(batches[0].body).sort(), ['45.67.211.39', '91.199.82.189']);

  const ash = g.describe('45.67.211.39', 7, 'icmp');
  assert.equal(ash.city, 'Ashburn');
  assert.ok(ash.distanceKm > 330 && ash.distanceKm < 370);
  assert.equal(ash.plausible, true);
  assert.equal(g.describe('91.199.82.189', 7, 'icmp').plausible, false);
  assert.equal(g.describe('91.199.82.189', 7, 'hop').plausible, null); // lower bound can't rule out

  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.ips['45.67.211.39'].city, 'Ashburn');
  const again = new GeoLocator({ cacheFile, fetchImpl: api.fetchImpl });
  assert.equal(again.get('45.67.211.39').city, 'Ashburn');
  assert.equal(api.calls.length, 2); // home + one batch, nothing more
});

test('backs off when rate limited', async () => {
  const api = fakeApi({}, { status: 429, ttl: '30' });
  const g = new GeoLocator({ fetchImpl: api.fetchImpl });
  g.get('1.1.1.1');
  await wait(3200);
  assert.match(g.status().error, /rate limited/);
  assert.ok(g.blockedUntil - Date.now() > 25_000);
  assert.equal(g.status().pending, 1);
  clearTimeout(g.timer);
});
