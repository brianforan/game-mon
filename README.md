# Game Latency Monitor

A latency monitor for my own Windows 11 gaming PC, started as a hands-on project for learning Elastic Agent and Fleet.

- **Live:** finds the servers my games talk to and shows latency, jitter and packet loss to each.
- **Logs:** writes plain NDJSON files with ECS field names; any log shipper can pick them up.
- **History:** reads per-process CPU, memory and GPU back from a metrics backend to show past play sessions.
- **Backend:** Elastic today; see [Logging and metrics backend](#logging-and-metrics-backend).
- **Stack:** Node.js, no drivers; npm packages are only the Anthropic SDK and zod.

## Run it

```powershell
cd game-latency-monitor
npm install   # first time only
node src/server.js
```

- Open http://localhost:7788; stop with Ctrl+C.
- Run from an **admin** terminal to see UDP game servers (see below).

### Admin mode

- Games send gameplay over **UDP**; Windows doesn't record UDP peers per process.
- Without admin: only **TCP** connections (login, chat, matchmaking), not the match server.
- With admin: a 4-second capture every 15 s finds UDP servers; headers only, files deleted right away.
- Header chip shows "UDP discovery: needs admin" or "on".

### Anti-cheat

- Capture and pings keep running during games; a kick seen in testing was a game bug, not this app.
- If a game ever kicks you: set `udpCapture.enabled` to `false` or run without admin.
- Pings don't touch the game on the PC, but the game's servers do see them.

## What you see

Each row is one server:

- **Who:** owner (reverse DNS / ASN), IP and port, TCP or UDP, and the process.
- **Latency:** last reading, plus average, jitter and loss over 30 samples.
- **Rating:** Good (<60 ms, <2% loss), Fair (<120 ms, <10% loss), else Poor.
- **Chart:** last 3 minutes; red ticks are lost pings.
- **"via …"** — how it was measured:
  - `icmp`: normal ping.
  - `tcp:443`: server blocks ping, so this times a TCP handshake.
  - `router at hop N … lower bound`: pings the last answering router; real latency is "≥ N ms".

Above the list:

- **Filter pills:** one per kind of app (Games, Chat & voice, Browsers…); only Games at first; remembered per browser.
- **Add a server:** pins any IP or hostname until restart; use `pinnedTargets` in `config.json` to keep it.

## Traffic roles (admin mode)

Every 15 s the app counts 4 s of traffic per server:

- **Default method (`etw`):** Windows kernel network events: per-socket, both directions, with process ID.
- **Fallback (`pktmon`):** captures at the network card; offloads can hide packets.
- **Check by hand:** `scripts\etw-probe.ps1` from admin PowerShell writes `data\debug\etw-probe.json`.

| Role | Meaning | Typical example |
|---|---|---|
| **Real-time** | Steady stream (≥ 8 packets/s averaging under 1,200 bytes) in either direction; outgoing only counts when kernel events are used | The match server, voice chat (even when only you are talking) |
| **Bulk** | Over 50 kB/s in big packets (averaging 1,000+ bytes) either way; checked first, so a download's stream of small acknowledgements isn't mistaken for real-time | Downloads, uploads, patching, video |
| **Light** | Some packets, no steady stream | API calls, keep-alives |
| **Idle** | Nothing in the last capture | |

- With `pktmon`, roles use incoming packets only; on my network card it misses most outgoing packets ("n/a").
- A game's Real-time server is marked "likely match server" in its detail view.

## Process detail view

Click a process name on any row (e.g. "ROB RUN"):

- **Resources, live:** CPU (% of whole PC, same scale as Elastic), memory, GPU 3D %, video memory; sampled only while open.
- **Servers:** every server it uses, with role, latency and traffic each way.
- **Timeline:** servers appearing, going live and disappearing (joining and leaving matches); since app start.
- **History:** past play sessions from the metrics backend (below).
- **Sockets:** every TCP connection and UDP port it has open.

On some AMD cards Windows reports 0% for the 3D engine even under load.

## Logging and metrics backend

- **Logs** are backend-agnostic: plain NDJSON files on disk.
- **History** is pluggable: `history.backend` in `config.json` picks the backend (`elastic` or `none`).
- **Today:** an Elastic Cloud trial, with Elastic Agent managed by Fleet on the same PC.
- **Plan:** when the trial ends, add a backend for an open-source, hosted logging/metrics stack.

### Logs

The app writes `logs/game-latency-YYYY-MM-DD.ndjson` with ECS field names:

- `game_latency.summary`: every 10 s per server: RTT, jitter, loss, method, destination, process, transport.
- `game_latency.event`: `target-start` / `target-end` when a server appears or goes away.
- Any shipper that tails NDJSON files works (Elastic Agent, Vector, Fluent Bit, Grafana Alloy…).

Current setup (Elastic Agent):

- In Fleet, add **Custom Logs (Filestream)** to the agent's policy.
- Path: `C:\path\to\game-latency-monitor\logs\*.ndjson`.
- Enable JSON parsing with an `ndjson` parser (labels vary by version; check the Fleet docs).

### History (past sessions)

Shows the last 14 days for a process (`history.days`):

- **Day tiles:** playtime per day; click, Ctrl-click, Shift-click or **All days** to choose.
- **Headline numbers:** playtime, sessions, longest session, average/peak CPU and memory, peak video memory.
- **Charts:** CPU, memory and video memory per minute; gaps show as breaks.
- **Sessions:** click one to zoom the charts to it.
- A new session starts after a gap of 10+ minutes (`history.sessionGapMinutes`).

What any backend needs to hold:

- CPU and memory per process, roughly per minute.
- GPU and video memory per process (optional).
- Today these come from Elastic Agent: the System integration (process metrics) and the Windows integration (perfmon GPU counters).

### Adding a backend

- Write `src/history/<name>.js` and register it in `BACKENDS` in `src/history/index.js`.
- Its settings go under a `config.json` key of the same name; select it with `history.backend`.
- Sessions, daily totals, summaries, caching and the UI are shared (`src/history/sessions.js`, `index.js`).

The backend object provides:

| Member | Returns |
|---|---|
| `name` | Display name, e.g. `"Elastic"` |
| `configured` | `true` once its endpoint and credentials are set |
| `target` | Short, non-secret label for the startup log |
| `source` | `{ name, intro, vars: [{ name, hint }], readme, notes }`: setup text and caveats for the UI |
| `minutes(names, { days })` | `[{ t, cpu, mem, pids }]`, one per minute with data; `cpu` = % of whole PC, `mem` = bytes; `names` = the exe name with and without `.exe` |
| `gpu(sessions)` *(optional)* | `[{ t, gpu, vram }]` per minute for those sessions' PIDs, or `null` if there's nothing to look up |

### Elastic setup (current backend)

- Copy `.env.example` to `.env`, fill in the two values, restart the app.
- `ELASTIC_URL`: the **Elasticsearch** endpoint, not Kibana's (Cloud console → deployment → *Copy endpoint*).
- `ELASTIC_API_KEY`: an **Encoded** API key that can read `metrics-*` (Kibana → Stack Management → API keys).
- `.env` is gitignored; variables already in your environment win over it.

Or set them for your Windows user instead:

```powershell
[Environment]::SetEnvironmentVariable('ELASTIC_URL', 'https://<your-deployment>.es.<region>.aws.found.io', 'User')
$s = Read-Host -AsSecureString 'Paste the encoded Elastic API key'; [Environment]::SetEnvironmentVariable('ELASTIC_API_KEY', [Net.NetworkCredential]::new('', $s).Password, 'User')
```

### What it queries (Elastic)

- `metrics-system.process-*`: CPU `system.process.cpu.total.norm.pct`, memory `system.process.memory.rss.bytes`.
- `metrics-windows.perfmon-*`: matched on the PID in the instance name (`pid_<pid>_…`).
- Different field names: override in `config.json` under `elastic.fields`.
- Gaps: the System integration only records the top N processes.
- Per-game video memory needs perfmon's wildcard refresh turned on.

## Server locations (ip-api.com)

- City per server from [ip-api.com](https://ip-api.com)'s free batch API, cached 30 days in `data/geo-cache.json`.
- **Sent:** server IPs, plus my own public IP (it makes the request); HTTP only, non-commercial use.
- **Turn off:** `"geo": { "enabled": false }` in `config.json`.
- **Plausibility check:** ~100 km per ms of round trip; a city too far for the ping gets a ⚠.
- **Anycast** (Cloudflare, Google, CloudFront…) is labelled as such instead of showing a wrong city.
- **Logs:** `destination.geo.*`, `game_latency.distance_km`, `game_latency.location_fits_ping`.

## Process labels (Claude Haiku)

- Each process gets a friendly name and category from Claude Haiku 5.5 (`claude-haiku-5-5`).
- Only `.exe` names are sent (no IPs, paths or traffic), once each, cached in `data/process-labels.json`.
- Without a key everything still works; unknown processes show "Not labelled yet".
- The "Process labels" header chip shows status; hover for errors.

To turn it on, set the key in your own terminal, then start the app from a new one:

```powershell
setx ANTHROPIC_API_KEY "<your key>"
```

Category is decided in this order:

1. `processOverrides` in `config.json`, e.g. `{ "ROB RUN.exe": "game" }`.
2. `gameProcesses` in `config.json`: always "game".
3. Haiku's cached label (delete the entry to re-ask).

Categories: `game`, `game-services`, `chat`, `browser`, `media`, `cloud-sync`, `security`, `developer`, `productivity`, `system`, `other`.

## Optional: owner database

- Gives every row an owner (e.g. "AS6507 RIOT-GAMES"); lookups are offline.
- Download `ip2asn-v4.tsv.gz` (~7 MB) from https://iptoasn.com into `data\`, then restart.

## Config (`config.json`)

| Key | Meaning |
|---|---|
| `gameProcesses` | Process names treated as games (find them in Task Manager → Details) |
| `pinnedTargets` | Servers always pinged, e.g. 1.1.1.1 as a baseline |
| `pingIntervalMs` | Ping interval per server (default 2 s) |
| `maxTargets` | Max servers tracked at once |
| `udpCapture` | Admin capture: on/off, interval, duration, method |
| `processOverrides` | Force a category for a process name |
| `log` | Log folder, summary interval, and which `categories` get logged (default `["game", "pinned"]`) |
| `history` | `backend` (`elastic` or `none`), `days`, `sessionGapMinutes` |
| `elastic` | Elastic backend: env var names, index patterns, `fields` overrides |

## Tests

```powershell
npm test
```

- Covers the parsers (netstat, tasklist, ping, tracert, pcapng), stats, ASN lookup and classifier.
- Classifier tests use a stand-in client: no API calls.
- Live capture needs an admin terminal and a running game, so it isn't tested.

## Files

- `src/server.js`: HTTP server and live updates (SSE), bound to 127.0.0.1
- `src/monitor.js`: polls connections, one probe per server, writes logs
- `src/discovery.js`: `netstat` + `tasklist` → connections with process names
- `src/udp-capture.js`, `src/etw-capture.js`, `src/pcapng.js`: admin-only capture → flows
- `src/pinger.js`, `src/icmp-worker.ps1`: ICMP, TCP and traceroute measurement
- `src/identify.js`: reverse DNS and offline ASN lookup
- `src/geo.js`: server locations and the plausibility check
- `src/classifier.js`: Haiku process labels with on-disk cache
- `src/procstats.js`, `src/proc-worker.ps1`: live CPU, memory and GPU per process
- `src/history/index.js`: picks the history backend, caching, the shared response
- `src/history/sessions.js`: backend-neutral sessions, daily totals and summaries
- `src/history/elastic.js`: Elasticsearch backend
- `src/env.js`: reads keys saved to the Windows user environment
- `public/`: the dashboard; `process.js` and `charts.js` are the detail view

## License

MIT, see [LICENSE](LICENSE).
