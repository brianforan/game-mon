// "History" for a process: past play sessions from a metrics backend.
// The backend is picked by history.backend in config.json; its own settings
// live under a config key of the same name (e.g. "elastic").
//
// A backend is an object with:
//   name                      display name, e.g. "Elastic"
//   configured                true once its credentials/endpoint are set
//   target                    short, non-secret description for the startup log
//   source                    { name, intro, vars: [{ name, hint }], readme, notes: [] } for the UI
//   minutes(names, { days })  -> [{ t, cpu, mem, pids }] one per minute with data
//                                (cpu: % of whole PC, mem: bytes, pids: PIDs seen)
//   gpu(sessions)             optional -> [{ t, gpu, vram }] per minute, or null if nothing to look up
import { ElasticBackend } from './elastic.js';
import { attachGpu, dailyMinutes, groupSessions, summarize } from './sessions.js';

const BACKENDS = {
  elastic: (cfg) => new ElasticBackend(cfg),
};
const CACHE_MS = 60_000;

export function createHistory(config) {
  const cfg = config.history ?? {};
  const name = cfg.backend ?? 'elastic';
  if (name === 'none') return new HistoryService(null, cfg);
  const make = BACKENDS[name];
  if (!make) throw new Error(`Unknown history.backend "${name}" in config.json (known: ${[...Object.keys(BACKENDS), 'none'].join(', ')})`);
  return new HistoryService(make(config[name] ?? {}), cfg);
}

export class HistoryService {
  constructor(backend, cfg = {}) {
    this.backend = backend;
    this.days = cfg.days ?? 14;
    this.gapMinutes = cfg.sessionGapMinutes ?? 10;
    this.maxSessions = cfg.maxSessions ?? 20;
    this.cache = new Map();
  }

  get configured() {
    return !!this.backend?.configured;
  }

  /** One line for the startup log. */
  describe() {
    if (!this.backend) return 'off (history.backend is "none")';
    return this.backend.configured ? `${this.backend.name} (${this.backend.target})` : `${this.backend.name}, not set up (optional, see README)`;
  }

  get source() {
    return this.backend?.source ?? {
      name: null,
      intro: 'History is turned off: history.backend is "none" in config.json.',
      vars: [], readme: 'Logging and metrics backend', notes: [],
    };
  }

  /** Past sessions of one executable, newest first. */
  async sessions(exe) {
    if (!this.configured) return { configured: false, source: this.source };
    const hit = this.cache.get(exe);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    const { days, gapMinutes } = this;
    const names = [...new Set([exe, exe.replace(/\.exe$/i, '')])];
    let value;
    try {
      const buckets = await this.backend.minutes(names, { days });
      const sessions = groupSessions(buckets, gapMinutes * 60_000).reverse().slice(0, this.maxSessions);
      let gpuNote = null;
      let vramPoints = [];
      if (this.backend.gpu && sessions.length) {
        try {
          const gpu = await this.backend.gpu(sessions);
          if (gpu && !gpu.length) gpuNote = 'No GPU data found for these sessions.';
          else if (gpu) vramPoints = attachGpu(sessions, gpu);
        } catch (e) {
          gpuNote = `GPU history unavailable: ${e.message}`;
        }
      }
      const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
      value = {
        configured: true, source: this.source, days, gapMinutes, sessions, gpuNote,
        summary: summarize(sessions), daily: dailyMinutes(buckets, days),
        // Every recorded minute, for the day-by-day charts: [t, cpu %, memory bytes]
        points: buckets.map((b) => [b.t, r2(b.cpu), b.mem == null ? null : Math.round(b.mem)]),
        vramPoints, // [t, bytes] per minute where the backend had GPU data
      };
    } catch (e) {
      value = { configured: true, source: this.source, error: e.name === 'TimeoutError' ? `${this.backend.name} did not answer within 20 s` : e.message };
    }
    this.cache.set(exe, { at: Date.now(), value });
    return value;
  }
}
