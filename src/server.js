// HTTP server for the dashboard. Listens on 127.0.0.1 only.
//   GET  /            dashboard page
//   GET  /events      Server-Sent Events stream of the monitor state (1/sec)
//   GET  /api/state   same state as one JSON response
//   POST /api/targets { host, name }   pin an extra server to ping
//   POST /api/targets/remove { ip }    stop pinging a server
//   POST /api/capture { whileGameRunning } allow traffic capture while a game runs (until restart)
//   GET  /api/process?exe=NAME          live detail for one executable
//   GET  /api/process/history?exe=NAME  past sessions from the history backend
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Monitor } from './monitor.js';
import { loadAsnDb } from './identify.js';
import { NdjsonLogger } from './logger.js';
import { isAdmin, stopCaptureSync } from './udp-capture.js';
import { stopEtwSync } from './etw-capture.js';
import { ProcessClassifier } from './classifier.js';
import { ProcSampler } from './procstats.js';
import { createHistory } from './history/index.js';
import { envOrUser } from './env.js';
import { GeoLocator } from './geo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keys can live in game-latency-monitor/.env (see .env.example). Variables
// already set in the environment win over the file.
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) { console.warn(`Couldn't read .env: ${e.message}`); }
}

// Pick up keys saved to the Windows user environment after this terminal (or
// the app that launched it) started.
if (!process.env.ANTHROPIC_API_KEY) {
  const k = envOrUser('ANTHROPIC_API_KEY');
  if (k) process.env.ANTHROPIC_API_KEY = k;
}
const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
const port = Number(process.env.PORT) || config.port;
if (config.udpCapture?.keepLastCaptureDir) config.udpCapture.keepLastCaptureDir = path.resolve(root, config.udpCapture.keepLastCaptureDir);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/process.js': ['process.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
};

const asnDb = loadAsnDb(path.join(root, 'data'));
const logger = new NdjsonLogger(path.resolve(root, config.log.dir), config.log.enabled);
const classifier = new ProcessClassifier({
  cacheFile: path.join(root, 'data', 'process-labels.json'),
  gameProcesses: config.gameProcesses,
  overrides: config.processOverrides,
});
const procSampler = new ProcSampler(2000);
const history = createHistory(config);
const geo = new GeoLocator({ cacheFile: path.join(root, 'data', 'geo-cache.json'), enabled: config.geo?.enabled !== false });
const monitor = new Monitor(config, { asnDb, logger, classifier, procSampler, history, geo });
const clients = new Set();

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  // Refuse requests addressed to any other hostname (blocks DNS-rebinding
  // tricks from web pages trying to reach this local server).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await readFile(path.join(root, 'public', file), 'utf8'), type);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(monitor.state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, monitor.state());
    if (req.method === 'GET' && url.pathname === '/api/process') {
      const exe = url.searchParams.get('exe');
      if (!exe) return send(res, 400, { error: 'exe required' });
      return send(res, 200, monitor.processDetail(exe));
    }
    if (req.method === 'GET' && url.pathname === '/api/process/history') {
      const exe = url.searchParams.get('exe');
      if (!exe) return send(res, 400, { error: 'exe required' });
      return send(res, 200, { ...(await history.sessions(exe)), category: classifier.get(exe).category });
    }

    if (req.method === 'POST') {
      // Requiring a JSON content type means other websites can't post here
      // without a CORS preflight, which this server never approves.
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'use application/json' });
      const body = await readJson(req);
      if (url.pathname === '/api/targets') {
        if (!body.host || typeof body.host !== 'string') return send(res, 400, { error: 'host required' });
        const t = await monitor.addPinned(body.host.trim(), (body.name || '').toString().slice(0, 60));
        return send(res, 200, { ok: true, ip: t.ip });
      }
      if (url.pathname === '/api/targets/remove') return send(res, 200, { ok: monitor.remove(String(body.ip)) });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

setInterval(() => {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify(monitor.state())}\n\n`;
  for (const c of clients) c.write(msg);
}, 1000);

server.listen(port, '127.0.0.1', async () => {
  await geo.start();
  await monitor.start();
  const admin = await isAdmin();
  console.log(`Game latency monitor: http://localhost:${port}`);
  console.log(`  UDP game-server discovery: ${admin ? 'on (running as admin)' : 'off - run from an admin terminal to enable'}`);
  console.log(`  ASN database: ${asnDb.loaded ? `${asnDb.rows} ranges` : 'not found (optional, see README)'}`);
  console.log(`  Process labels: ${classifier.enabled ? `Claude Haiku (${classifier.cache.size} cached)` : 'no Anthropic API key - only config.json games are labelled'}`);
  console.log(`  History: ${history.describe()}`);
  console.log(`  Server locations: ${geo.enabled ? `ip-api.com (${geo.status().cached} cached${geo.home ? `, you: ${geo.home.city}` : ''})` : 'off'}`);
  console.log(`  Logging: ${logger.enabled ? logger.file() : 'off'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { monitor.stop(); procSampler.close(); stopCaptureSync(); stopEtwSync(); process.exit(0); });
}
