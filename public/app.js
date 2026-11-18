// Dashboard: listens to /events (Server-Sent Events) and keeps one row per
// server, updating rows in place so hover and typing aren't interrupted.
// #/process/<exe> opens the process detail view (process.js) instead.
import { openProcess, closeProcess } from './process.js';
import { locationText } from './charts.js';

const WINDOW_MS = 180_000;
const CHART_H = 72;
const AXIS_W = 30;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (sel, el = document) => el.querySelector(sel);
const list = $('#list');
const tip = $('#tip');
const rows = new Map(); // ip -> { el, data }
let hover = null;       // { ip, clientX }
let latest = null;

// Category names shown on pills and rows (keys match src/classifier.js).
const CATEGORY_NAMES = {
  game: 'Games', 'game-services': 'Launchers & anti-cheat', chat: 'Chat & voice', browser: 'Browsers',
  media: 'Music & video', 'cloud-sync': 'Cloud sync', security: 'Security & VPN', developer: 'Developer tools',
  productivity: 'Productivity', system: 'Windows & system', other: 'Other', unlabelled: 'Not labelled yet',
};
const SINGULAR = {
  game: 'Game', 'game-services': 'Game service', chat: 'Chat', browser: 'Browser', media: 'Media',
  'cloud-sync': 'Cloud sync', security: 'Security', developer: 'Dev tool', productivity: 'Productivity',
  system: 'System', other: 'Other', unlabelled: 'Unlabelled', pinned: 'Pinned',
};
const PILL_ORDER = Object.keys(CATEGORY_NAMES);
const LABEL_SOURCE = {
  haiku: 'labelled by Claude Haiku',
  config: 'listed in config.json gameProcesses',
  override: 'set in config.json processOverrides',
  pending: 'waiting for Claude Haiku',
  none: 'not labelled: no API key',
};

// Which categories are shown. Empty set = show everything. Pinned rows always show.
// Remembered per browser; storage can be unavailable, so every access is guarded.
let selected = new Set(['game']);
try {
  const saved = JSON.parse(localStorage.getItem('glm-filter'));
  if (Array.isArray(saved)) selected = new Set(saved);
} catch {}
function saveFilter() {
  try { localStorage.setItem('glm-filter', JSON.stringify([...selected])); } catch {}
}
const visible = (t) => t.category === 'pinned' || selected.size === 0 || selected.has(t.category);

const ROLE_TEXT ={ realtime: 'Real-time', bulk: 'Bulk', light: 'Light', idle: 'Idle' };
const processHref = (exe) => `#/process/${encodeURIComponent(exe)}`;

// ---- quality rating: colour always paired with an icon + word ----
function rate(stats, method) {
  if (method === 'hop' && stats?.avg != null) return { cls: 'idle', icon: '◇', text: 'Lower bound only' };
  if (stats && stats.count < 5 && stats.avg != null) return { cls: 'idle', icon: '○', text: 'Measuring…' };
  if (!stats || stats.avg == null) return { cls: 'idle', icon: '○', text: 'No data' };
  if (stats.avg < 60 && stats.loss < 2) return { cls: 'good', icon: '●', text: 'Good' };
  if (stats.avg < 120 && stats.loss < 10) return { cls: 'warning', icon: '▲', text: 'Fair' };
  return { cls: 'critical', icon: '■', text: 'Poor' };
}

const fmt = (v, unit = 'ms') => (v == null ? '–' : `${v < 1 ? '<1' : Math.round(v)} ${unit}`);

function displayName(t) {
  if (t.kind === 'pinned' && t.name) return t.name;
  return t.info?.owner || t.info?.org || t.info?.rdns || t.ip;
}

// ---- row creation / update ----
function createRow(ip) {
  const el = document.createElement('div');
  el.className = 'row';
  el.setAttribute('role', 'listitem');
  el.innerHTML = `
    <div class="who">
      <div class="name"><span class="n"></span><span class="kind"></span>
        <button class="x" title="Stop pinging this server (a live game connection will add it back)" aria-label="Remove">×</button></div>
      <div class="sub num"></div>
      <div class="meta"></div>
    </div>
    <div class="lat">
      <div class="status"><span class="icon" aria-hidden="true"></span><span class="st"></span></div>
      <div class="big num"></div>
      <div class="stats num"></div>
      <div class="method"></div>
    </div>
    <div class="chart"><svg aria-label="Latency over the last 3 minutes"></svg></div>`;
  $('.x', el).addEventListener('click', () => post('/api/targets/remove', { ip }));
  const chart = $('.chart', el);
  chart.addEventListener('mousemove', (e) => { hover = { ip, clientX: e.clientX }; drawChart(ip); });
  chart.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; drawChart(ip); });
  return el;
}

function updateRow(el, t) {
  el.classList.toggle('pinned', t.kind === 'pinned');
  $('.n', el).textContent = displayName(t);
  const kind = $('.kind', el);
  kind.textContent = SINGULAR[t.category] ?? t.category;
  kind.classList.toggle('is-game', t.category === 'game');

  const port = t.ports.length ? `:${t.ports.at(-1)}` : '';
  const transport = t.transports.length ? ` · ${t.transports.join('+').toUpperCase()}` : '';
  const extra = t.processes.length > 1 ? ` +${t.processes.length - 1} more` : '';
  const sub = $('.sub', el);
  // Rebuild only when something changed: replacing the link every second
  // would swallow clicks that land mid-update.
  const subKey = `${t.ip}${port}${transport}|${t.processExe}|${t.processLabel}|${extra}|${t.labelSource}`;
  if (sub.dataset.key !== subKey) {
  sub.dataset.key = subKey;
  sub.replaceChildren(`${t.ip}${port}${transport}`);
  if (t.processLabel && t.processExe) {
    const a = document.createElement('a');
    a.href = processHref(t.processExe);
    a.className = 'proc-link';
    a.textContent = t.processLabel;
    const how = LABEL_SOURCE[t.labelSource];
    a.title = `Open details for ${t.processes.join(', ')}${how ? ` (${how})` : ''}`;
    sub.append(' · ', a, extra);
  }
  }

  const i = t.info ?? {};
  const loc = locationText(t);
  const meta = [i.rdns, i.asn ? `AS${i.asn} ${i.org ?? ''}`.trim() : null, loc.text || null].filter(Boolean);
  $('.meta', el).classList.toggle('warnloc', loc.warn);
  $('.meta', el).textContent = meta.join(' · ') || (t.info ? (latest?.asnDb.loaded ? 'owner unknown' : 'owner unknown · install the owner database for more') : 'looking up…');

  const s = t.stats;
  const r = rate(s, t.method);
  const st = $('.status', el);
  st.className = `status ${r.cls}`;
  $('.icon', el).textContent = r.icon;
  $('.st', el).textContent = t.status === 'ok' || t.status === 'loss' ? r.text : t.status;

  const big = $('.big', el);
  big.innerHTML = '';
  const val = s?.last ?? s?.avg;
  const prefix = t.method === 'hop' ? '≥ ' : '';
  big.append(val == null ? '–' : prefix + (val < 1 ? '<1' : String(Math.round(val))));
  if (val != null) { const sm = document.createElement('small'); sm.textContent = 'ms'; big.append(sm); }

  $('.stats', el).textContent = s
    ? `avg ${fmt(s.avg)} · jitter ${fmt(s.jitter)} · loss ${s.loss}%`
    : 'waiting for first reply';
  const method = $('.method', el);
  method.replaceChildren(`via ${t.methodLabel}`);
  if (t.role && ROLE_TEXT[t.role] && t.traffic) {
    const r = document.createElement('span');
    r.className = `role role-${t.role}`;
    r.textContent = ROLE_TEXT[t.role];
    const outKnown = t.traffic.ppsOut != null;
    r.title = outKnown
      ? `${t.traffic.ppsIn} in / ${t.traffic.ppsOut} out packets per second in the last capture`
      : `${t.traffic.ppsIn} incoming packets per second in the last capture (this PC's capture doesn't see outgoing packets reliably)`;
    method.append(' ', r, outKnown ? ` ${Math.round(t.traffic.ppsIn)}/${Math.round(t.traffic.ppsOut)} pkt/s` : ` ${Math.round(t.traffic.ppsIn)} pkt/s in`);
  }
}

// ---- chart ----
function niceMax(v) {
  for (const step of [20, 50, 100, 150, 200, 300, 500, 1000, 2000]) if (v <= step) return step;
  return Math.ceil(v / 1000) * 1000;
}

function svgEl(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function drawChart(ip) {
  const row = rows.get(ip);
  if (!row || !latest) return;
  const svg = $('svg', row.el);
  const W = Math.max(svg.clientWidth, 120);
  const H = CHART_H;
  const top = 6, bottom = H - 4;
  const now = latest.now;
  const pts = row.data.samples.filter(([t]) => t >= now - WINDOW_MS);
  const ok = pts.filter(([, r]) => r != null).map(([, r]) => r);
  const yMax = niceMax(Math.max(20, ...ok) * 1.15);
  const x = (t) => AXIS_W + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (W - AXIS_W);
  const y = (r) => bottom - (r / yMax) * (bottom - top);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  for (const v of [0, yMax / 2, yMax]) {
    svg.append(svgEl('line', { class: 'grid', x1: AXIS_W, x2: W, y1: y(v), y2: y(v) }));
  }
  const lbl = (v, txt) => { const e = svgEl('text', { class: 'axis', x: AXIS_W - 6, y: y(v) + 3, 'text-anchor': 'end' }); e.textContent = txt; svg.append(e); };
  lbl(yMax, `${yMax}`);
  lbl(0, '0 ms');

  // Line segments break where a ping was lost; lost pings get a red tick on the baseline.
  let d = '', area = '', segStart = null, prev = null;
  const closeArea = () => { if (segStart != null && prev) area += `L${prev[0]},${bottom}L${segStart},${bottom}Z`; segStart = null; };
  for (const [t, r] of pts) {
    if (r == null) {
      closeArea(); prev = null;
      svg.append(svgEl('line', { class: 'lost', x1: x(t), x2: x(t), y1: bottom, y2: bottom - 6 }));
      continue;
    }
    const p = [x(t).toFixed(1), y(r).toFixed(1)];
    if (!prev) { d += `M${p[0]},${p[1]}`; area += `M${p[0]},${bottom}L${p[0]},${p[1]}`; segStart = p[0]; }
    else { d += `L${p[0]},${p[1]}`; area += `L${p[0]},${p[1]}`; }
    prev = p;
  }
  closeArea();
  svg.append(svgEl('path', { class: 'area', d: area }));
  svg.append(svgEl('path', { class: 'line', d }));

  // Crosshair + tooltip for the sample nearest the mouse.
  if (hover?.ip === ip && pts.length) {
    const rect = svg.getBoundingClientRect();
    const mx = hover.clientX - rect.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p[0]) - mx) < Math.abs(x(best[0]) - mx)) best = p;
    const bx = x(best[0]);
    svg.append(svgEl('line', { class: 'cross', x1: bx, x2: bx, y1: top, y2: bottom }));
    if (best[1] != null) svg.append(svgEl('circle', { class: 'marker', cx: bx, cy: y(best[1]), r: 4 }));
    const ago = Math.round((now - best[0]) / 1000);
    tip.innerHTML = '';
    const v = document.createElement('div');
    v.textContent = best[1] == null ? 'No reply (lost)' : `${fmt(best[1])}`;
    const tt = document.createElement('div');
    tt.className = 't';
    tt.textContent = `${new Date(best[0]).toLocaleTimeString()} · ${ago}s ago`;
    tip.append(v, tt);
    tip.hidden = false;
    const tx = Math.min(rect.left + bx + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${tx}px`;
    tip.style.top = `${rect.top - 8}px`;
  }
}

// ---- header chips ----
function chip(label, value, title = '') {
  const c = document.createElement('span');
  c.className = 'chip';
  c.title = title;
  c.append(`${label}: `);
  const b = document.createElement('b');
  b.textContent = value;
  c.append(b);
  return c;
}

function renderChips(s) {
  const chips = $('#chips');
  const udp = s.udp.status === 'active'
    ? `on${s.udp.lastCapture ? ` · ${s.udp.flows ?? 0} flows` : ''}`
    : s.udp.status;
  chips.replaceChildren(
    chip('UDP discovery', udp, s.udp.error || 'Finds game servers that use UDP. Requires running as admin.'),
    chip('Owner database', s.asnDb.loaded ? `${s.asnDb.rows.toLocaleString()} ranges` : 'not installed', 'Optional offline IP-to-ASN database. See README.'),
    chip('Log', s.logging ? s.logging.file.split(/[\\/]/).pop() : 'off', s.logging?.file ?? ''),
    ...(s.poll.error ? [chip('Poll error', s.poll.error)] : []),
  );
  const l = s.labels;
  const labelValue = !l.enabled && l.error ? 'key rejected'
    : !l.enabled ? 'no API key'
    : l.error ? 'error'
    : l.pending ? `Haiku · labelling ${l.pending}…`
    : `Haiku · ${l.labelled} known`;
  const labelTip = !l.enabled && l.error ? l.error
    : !l.enabled
    ? 'Set ANTHROPIC_API_KEY and restart to have Claude Haiku label each process. Until then only games listed in config.json are recognised.'
    : l.error ? `Last error: ${l.error}` : `Process names are labelled by ${l.model} and cached in data/process-labels.json.`;
  chips.append(chip('Process labels', labelValue, labelTip));
  const g = s.geo;
  if (g?.enabled) {
    const v = g.error ? 'error' : g.pending ? `looking up ${g.pending}…` : `${g.cached} known`;
    const tipText = `Server cities from ip-api.com (free, HTTP only, non-commercial use). ${g.home ? `Your approximate location: ${[g.home.city, g.home.region, g.home.countryCode].filter(Boolean).join(', ')}.` : ''}${g.error ? ` Last error: ${g.error}` : ''}`;
    chips.append(chip('Locations', v, tipText));
  }
}

// ---- category filter pills ----
function renderPills(state) {
  const counts = new Map();
  for (const t of state.targets) if (t.category !== 'pinned') counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const cats = PILL_ORDER.filter((c) => c === 'game' || counts.has(c) || selected.has(c));
  // Update buttons in place: replacing them every second would eat clicks
  // that land between mousedown and mouseup.
  const pills = $('#pills');
  cats.forEach((c, i) => {
    let b = pills.querySelector(`.pill[data-cat="${c}"]`);
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.dataset.cat = c;
      b.append(CATEGORY_NAMES[c]);
      const n = document.createElement('span');
      n.className = 'count';
      b.append(n);
    }
    if (pills.children[i] !== b) pills.insertBefore(b, pills.children[i] ?? null);
    b.setAttribute('aria-pressed', String(selected.has(c)));
    $('.count', b).textContent = counts.get(c) ?? 0;
  });
  for (const b of [...pills.children]) if (!cats.includes(b.dataset.cat)) b.remove();
  const clear = $('#clearFilter');
  clear.disabled = selected.size === 0;
  $('#filterNote').textContent = selected.size === 0 ? 'Showing everything' : '';
}

$('#pills').addEventListener('click', (e) => {
  const b = e.target.closest('.pill');
  if (!b) return;
  const c = b.dataset.cat;
  if (selected.has(c)) selected.delete(c); else selected.add(c);
  saveFilter();
  if (latest) render(latest);
});
$('#clearFilter').addEventListener('click', () => {
  selected.clear();
  saveFilter();
  if (latest) render(latest);
});

// ---- main render ----
function render(state) {
  latest = state;
  renderChips(state);
  if ($('#mainView').hidden) return; // detail view is open; skip list work
  renderPills(state);

  const seen = new Set();
  let idx = 0;
  for (const t of state.targets) {
    seen.add(t.ip);
    let row = rows.get(t.ip);
    if (!row) { row = { el: createRow(t.ip) }; rows.set(t.ip, row); }
    row.data = t;
    const show = visible(t);
    row.el.hidden = !show;
    if (list.children[idx] !== row.el) list.insertBefore(row.el, list.children[idx] ?? null);
    idx++;
    if (!show) continue;
    updateRow(row.el, t);
    drawChart(t.ip);
  }
  for (const [ip, row] of rows) if (!seen.has(ip)) { row.el.remove(); rows.delete(ip); }

  const shown = state.targets.filter((t) => t.category !== 'pinned' && visible(t)).length;
  const hidden = state.targets.filter((t) => t.category !== 'pinned' && !visible(t)).length;
  const empty = $('#empty');
  empty.hidden = shown > 0;
  empty.textContent = selected.size === 1 && selected.has('game')
    ? `No game connections right now. Start a match and its servers will show up here.${hidden ? ` ${hidden} connection${hidden === 1 ? '' : 's'} from other apps ${hidden === 1 ? 'is' : 'are'} hidden. Click Clear to see everything.` : ''} A game's UDP gameplay server only appears when this app runs from an admin terminal.`
    : `Nothing matches the selected filters.${hidden ? ` ${hidden} hidden. Click Clear to see everything.` : ''}`;
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) alert(j.error || `Request failed (${r.status})`);
  return j;
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await post('/api/targets', { host: $('#addHost').value, name: $('#addName').value });
  if (res.ok) { $('#addHost').value = ''; $('#addName').value = ''; }
});
window.addEventListener('resize', () => rows.forEach((_, ip) => drawChart(ip)));

// ---- routing: #/process/<exe> shows the process detail view ----
function route() {
  const m = location.hash.match(/^#\/process\/(.+)$/);
  tip.hidden = true;
  if (m) {
    $('#mainView').hidden = true;
    openProcess(decodeURIComponent(m[1]));
    window.scrollTo(0, 0);
  } else {
    closeProcess();
    $('#mainView').hidden = false;
    if (latest) render(latest);
  }
}
window.addEventListener('hashchange', route);
route();

const conn = $('#conn');
const es = new EventSource('/events');
es.onopen = () => { conn.textContent = 'live'; };
es.onerror = () => { conn.textContent = 'disconnected – is the server running?'; };
es.onmessage = (e) => render(JSON.parse(e.data));
