// History backend: Elasticsearch, fed by a Fleet-managed Elastic Agent.
//   CPU + memory: System integration, process metrics (metrics-system.process-*)
//   GPU + VRAM:   Windows integration perfmon (metrics-windows.perfmon-*),
//                 instances named "pid_<pid>_...", joined to the process by PID
// Needs ELASTIC_URL (the Elasticsearch endpoint, not Kibana) and ELASTIC_API_KEY
// (an encoded API key with read access to metrics-*). Settings live under
// "elastic" in config.json; field names under elastic.fields.
import { envOrUser } from '../env.js';

const DEFAULT_FIELDS = {
  processName: 'process.name',
  pid: 'process.pid',
  cpu: 'system.process.cpu.total.norm.pct',
  mem: 'system.process.memory.rss.bytes',
  perfmonInstance: 'windows.perfmon.instance',
  gpu: 'windows.perfmon.metrics.gpu_3d_util',
  vram: 'windows.perfmon.metrics.vram_process_bytes',
};

export class ElasticBackend {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.name = 'Elastic';
    this.fields = { ...DEFAULT_FIELDS, ...(cfg.fields ?? {}) };
    this.url = (envOrUser(cfg.urlEnv ?? 'ELASTIC_URL') ?? '').replace(/\/+$/, '');
    this.apiKey = envOrUser(cfg.apiKeyEnv ?? 'ELASTIC_API_KEY');
  }

  get configured() {
    return !!this.url && !!this.apiKey;
  }

  /** Short, non-secret description for the startup log: the deployment's first host label. */
  get target() {
    try { return `${new URL(this.url).hostname.split('.')[0]}…`; } catch { return 'invalid ELASTIC_URL'; }
  }

  /** What the UI shows about this source: setup steps and caveats. */
  get source() {
    return {
      name: this.name,
      intro: 'Your Elastic Agent already records process CPU and memory (System integration) and GPU per process (perfmon). To show them here, put two values in game-latency-monitor/.env (copy .env.example) and restart this app:',
      vars: [
        { name: this.cfg.urlEnv ?? 'ELASTIC_URL', hint: 'Kibana → ? (Help) → Connection details → Endpoints → Elasticsearch' },
        { name: this.cfg.apiKeyEnv ?? 'ELASTIC_API_KEY', hint: 'Kibana → ? (Help) → Connection details → API key (copy the Encoded value)' },
      ],
      readme: 'Elastic setup (current backend)',
      notes: [
        `CPU and memory from ${this.fields.cpu} and ${this.fields.mem}, one point per minute.`,
        'The System integration only records the top processes by CPU and memory, so minutes where this process was not among them are missing.',
      ],
    };
  }

  async search(index, body) {
    const r = await fetch(`${this.url}/${encodeURIComponent(index).replace(/%2C/g, ',').replace(/%2A/g, '*')}/_search`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = j.error?.root_cause?.[0]?.reason ?? j.error?.reason ?? r.statusText;
      throw new Error(r.status === 401 || r.status === 403 ? `Elastic rejected the API key (${r.status}): ${reason}` : `Elastic ${r.status}: ${reason}`);
    }
    return j;
  }

  /** Per-minute CPU (% of whole PC), memory (bytes) and PIDs for these process names. */
  async minutes(names, { days }) {
    const f = this.fields;
    const res = await this.search(this.cfg.processIndex ?? 'metrics-system.process-*', {
      size: 0,
      query: { bool: { filter: [
        { terms: { [f.processName]: names } },
        { range: { '@timestamp': { gte: `now-${days}d` } } },
      ] } },
      aggs: { t: {
        date_histogram: { field: '@timestamp', fixed_interval: '1m', min_doc_count: 1 },
        aggs: {
          cpu: { avg: { field: f.cpu } },
          mem: { avg: { field: f.mem } },
          pids: { terms: { field: f.pid, size: 5 } },
        },
      } },
    });
    return (res.aggregations?.t?.buckets ?? []).map((b) => ({
      t: b.key,
      cpu: b.cpu?.value == null ? null : b.cpu.value * 100,
      mem: b.mem?.value ?? null,
      pids: (b.pids?.buckets ?? []).map((p) => p.key),
    }));
  }

  /** Per-minute GPU 3D % and VRAM bytes for the sessions' PIDs, or null if there are no PIDs. */
  async gpu(sessions) {
    const f = this.fields;
    if (!sessions.some((s) => s.pids.length)) return null;
    // Match each session's PIDs only within that session: Windows reuses PIDs,
    // so the same number can belong to another program at another time.
    const res = await this.search(this.cfg.perfmonIndex ?? 'metrics-windows.perfmon-*', {
      size: 0,
      query: { bool: {
        should: sessions.flatMap((s) => s.pids.map((p) => ({ bool: { filter: [
          { prefix: { [f.perfmonInstance]: `pid_${p}_` } },
          { range: { '@timestamp': { gte: s.start, lt: s.end } } },
        ] } }))),
        minimum_should_match: 1,
      } },
      aggs: { t: {
        date_histogram: { field: '@timestamp', fixed_interval: '1m', min_doc_count: 1 },
        aggs: { gpu: { max: { field: f.gpu } }, vram: { max: { field: f.vram } } },
      } },
    });
    return (res.aggregations?.t?.buckets ?? []).map((b) => ({ t: b.key, gpu: b.gpu?.value ?? null, vram: b.vram?.value ?? null }));
  }
}
