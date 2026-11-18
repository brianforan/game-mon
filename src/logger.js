// Writes newline-delimited JSON with Elastic Common Schema (ECS) field names,
// one file per day, so an Elastic Agent "Custom Logs" integration (or
// Filebeat) can tail logs/*.ndjson without any extra parsing.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class NdjsonLogger {
  constructor(dir, enabled = true) {
    this.dir = dir;
    this.enabled = enabled;
    this.ready = enabled ? mkdir(dir, { recursive: true }) : Promise.resolve();
    this.queue = Promise.resolve();
  }

  file(date = new Date()) {
    return path.join(this.dir, `game-latency-${date.toISOString().slice(0, 10)}.ndjson`);
  }

  write(doc) {
    if (!this.enabled) return;
    const line = JSON.stringify({ '@timestamp': new Date().toISOString(), ...doc }) + '\n';
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.file(), line))
      .catch((e) => console.warn(`log write failed: ${e.message}`));
  }
}

/** ECS fields describing a monitored server, shared by every document. */
export function targetFields(t, d = {}) {
  const i = t.info ?? {};
  const doc = {
    destination: {
      ip: t.ip,
      ...(t.lastPort ? { port: t.lastPort } : {}),
      ...(i.rdns ? { domain: i.rdns } : {}),
      ...(i.asn ? { as: { number: i.asn, organization: { name: i.org } } } : {}),
      // actual server location (ip-api.com), when known
      ...(d.geo ? { geo: { city_name: d.geo.city, region_name: d.geo.region, country_iso_code: d.geo.countryCode, location: { lat: d.geo.lat, lon: d.geo.lon } } } : {}),
    },
    game_latency: {
      kind: t.kind,
      ...(d.geo?.distanceKm != null ? { distance_km: d.geo.distanceKm, location_fits_ping: d.geo.plausible } : {}),
      owner: i.owner ?? null,
      owner_type: i.tag ?? null,
      // where the network owner is registered, NOT where the server is
      ...(i.country ? { owner_country: i.country } : {}),
      ...(d.category ? { process_category: d.category } : {}),
      ...(d.label ? { process_label: d.label } : {}),
    },
  };
  if (t.name) doc.game_latency.name = t.name;
  if (t.processes.size) doc.process = { name: d.exe ?? [...t.processes][0], pid: [...t.pids][0] };
  if (t.transports.size) doc.network = { transport: [...t.transports].join(',') };
  return doc;
}
