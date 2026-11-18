// Process detail view: everything known about one executable.
// Opened via #/process/<exe>. Polls /api/process every 2 s while open, and
// loads past sessions from the history backend once (with a Refresh button).
import { lineChart, timeTicks, fmtBytes, fmtDuration, locationText } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#detailView');
let exe = null;
let timer = null;
let history = null;
let histZoom = null; // index of the session the history charts are zoomed to, or null for all

const ROLE = {
  realtime: { text: 'Real-time', tip: 'Steady two-way stream of small packets: a live match server or voice chat.' },
  bulk: { text: 'Bulk', tip: 'Lots of data in one direction: downloads, patching, video.' },
  light: { text: 'Light', tip: 'Occasional packets: API calls, keep-alives.' },
  idle: { text: 'Idle', tip: 'No packets seen in the last capture.' },
  unknown: { text: '–', tip: 'Traffic rates need admin mode.' },
};

function h(tag, props = {}, ...kids) {
  const e = tag === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.setAttribute('class', v);
    else if (k === 'text') e.textContent = v;
    else if (v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

const pct = (v) => (v == null ? '–' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);
const rate = (pps) => (pps == null ? '–' : pps < 10 ? pps.toFixed(1) : String(Math.round(pps)));
const kbs = (bps) => (bps == null ? '–' : bps < 1024 ? `${bps} B/s` : `${(bps / 1024).toFixed(bps < 10240 ? 1 : 0)} kB/s`);
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function skeleton() {
  view.replaceChildren(
    h('a', { class: 'back', href: '#' }, '← All servers'),
    h('header', { class: 'd-head' },
      h('div', {}, h('h2', { id: 'dTitle' }), h('div', { id: 'dSub', class: 'muted' })),
      h('div', { id: 'dSystem', class: 'muted' })),
    h('section', { class: 'tiles', id: 'dTiles' }),
    h('p', { id: 'dResNote', class: 'muted note' }),
    h('section', { class: 'd-sec' },
      h('h3', {}, 'Servers ', h('span', { class: 'muted', id: 'dSrvNote' })),
      h('div', { class: 'tablewrap' }, h('table', { class: 'tbl', id: 'dServers' }))),
    h('section', { class: 'd-sec' },
      h('h3', {}, 'Timeline ', h('span', { class: 'muted', text: 'servers appearing, going live and disappearing (since this app started)' })),
      h('ol', { class: 'timeline', id: 'dTimeline' })),
    h('section', { class: 'd-sec hist' },
      h('div', { class: 'hist-head' },
        h('h3', { id: 'dHistTitle' }, 'Historical metrics'),
        h('span', { class: 'src', id: 'dHistSrc', text: '' }),
        h('button', { class: 'clear', id: 'dHistRefresh', type: 'button' }, 'Refresh')),
      h('div', { id: 'dHistory' }, h('p', { class: 'muted', text: 'Loading…' }))),
    h('details', { class: 'd-sec' },
      h('summary', {}, h('h3', { id: 'dSockTitle' }, 'Sockets')),
      h('div', { id: 'dSockets', class: 'sockets' })),
  );
  $('#dHistRefresh').addEventListener('click', () => loadHistory(true));
}

function tile(id, label) {
  return h('div', { class: 'tile', id },
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value num' }),
    h('div', { class: 'tile-sub muted num' }),
    h('svg', { class: 'spark', 'aria-label': `${label}, last 3 minutes` }));
}

function renderResources(d) {
  const tiles = $('#dTiles');
  if (!tiles.children.length) {
    tiles.append(tile('tCpu', 'CPU (% of whole PC)'), tile('tMem', 'Memory (working set)'), tile('tGpu', 'GPU 3D engine'), tile('tVram', 'Video memory (dedicated)'));
  }
  const r = d.resources;
  const live = r?.live;
  const hist = r?.history ?? [];
  const now = d.now;
  const from = now - 180_000;
  const set = (id, value, sub, key, opts) => {
    const t = $(`#${id}`);
    $('.tile-value', t).textContent = value;
    $('.tile-sub', t).textContent = sub;
    lineChart($('svg', t), hist.filter((s) => s.t >= from).map((s) => [s.t, s[key]]), { xFrom: from, xTo: now, ...opts });
  };
  set('tCpu', pct(live?.cpuPct), live ? `${live.threads ?? '–'} threads · ${live.handles ?? '–'} handles` : '', 'cpuPct', { yFloor: 10, format: (v) => `${Math.round(v)}%` });
  set('tMem', fmtBytes(live?.ws), live ? `private ${fmtBytes(live.priv)}` : '', 'ws', { yFloor: 1024 ** 3, format: fmtBytes });
  set('tGpu', pct(live?.gpu3d), live?.gpu3d == null && live ? 'no GPU counters for this process' : '', 'gpu3d', { yMax: 100, format: (v) => `${Math.round(v)}%` });
  set('tVram', fmtBytes(live?.vramDedicated), live?.vramShared != null ? `shared ${fmtBytes(live.vramShared)}` : '', 'vramDedicated', { yFloor: 1024 ** 3, format: fmtBytes });

  const s = r?.system;
  $('#dSystem').textContent = s ? `Whole PC: CPU ${pct(s.cpuPct)} of ${s.cores} threads · RAM ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}` : '';
  $('#dResNote').textContent = !d.running ? 'This process has no network sockets open right now, so it is not being sampled. It may have closed.'
    : r?.warmingUp ? 'Starting the sampler… first readings take a few seconds.' : '';
}

function renderHeader(d) {
  $('#dTitle').replaceChildren(d.label ?? exe, ' ', h('span', { class: `kind${d.category === 'game' ? ' is-game' : ''}`, text: d.category }));
  const live = d.resources?.live;
  const bits = [exe, d.pids.length ? `PID ${d.pids.join(', ')}` : 'not running'];
  if (live?.start) bits.push(`running ${fmtDuration(d.now - Date.parse(live.start))} (since ${new Date(live.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`);
  if (live?.path) bits.push(live.path);
  $('#dSub').textContent = bits.join(' · ');
}

function renderServers(d) {
  const tbl = $('#dServers');
  const capOn = d.capture?.status === 'active';
  $('#dSrvNote').textContent = !capOn
    ? 'traffic rates and UDP servers need admin mode'
    : d.capture.method === 'etw'
      ? 'traffic counted from Windows kernel network events, 4 seconds every 15 s'
    : d.capture.outboundCaptured === false
      ? 'traffic from a 4-second packet capture every 15 s. Your network card only reports incoming packets to the capture, so outgoing shows n/a and roles are judged on incoming traffic'
      : 'traffic from a 4-second packet capture every 15 s';
  const head = h('tr', {}, ...['What', 'Server', 'Latency', 'Traffic in / out', 'Seen for'].map((t) => h('th', { text: t })));
  const rows = d.servers.map((s) => {
    const role = ROLE[s.role ?? 'unknown'] ?? ROLE.unknown;
    const likelyMatch = d.category === 'game' && s.role === 'realtime';
    const what = h('td', {},
      h('span', { class: `role role-${s.role ?? 'unknown'}`, title: role.tip, text: role.text }),
      likelyMatch ? h('div', { class: 'hint', text: 'likely match server' }) : null);
    const i = s.info ?? {};
    const server = h('td', {},
      h('div', { class: 'strong', text: i.owner || i.org || s.ip }),
      h('div', { class: 'muted num', text: [`${s.ip}:${s.ports.at(-1) ?? ''}`, s.transports.join('+').toUpperCase(), locationText(s).text || null].filter(Boolean).join(' · ') }),
      locationText(s).warn ? h('div', { class: 'hint warnloc', text: 'The location database is likely wrong for this server.' }) : null);
    const st = s.stats;
    const lat = h('td', { class: 'num' },
      h('div', { class: 'strong', text: st?.avg == null ? '–' : `${s.method === 'hop' ? '≥ ' : ''}${Math.round(st.avg)} ms` }),
      h('div', { class: 'muted', text: st ? `jitter ${st.jitter ?? '–'} · loss ${st.loss}%` : '' }));
    const tr = s.traffic;
    const outKnown = tr?.ppsOut != null;
    const traffic = h('td', { class: 'num' },
      h('div', { text: !tr ? '–' : outKnown ? `${rate(tr.ppsIn)} / ${rate(tr.ppsOut)} pkt/s` : `${rate(tr.ppsIn)} / n/a pkt/s` }),
      h('div', { class: 'muted', text: !tr ? '' : outKnown ? `${kbs(tr.bpsIn)} / ${kbs(tr.bpsOut)}` : `${kbs(tr.bpsIn)} in` }));
    const seen = h('td', { class: 'num muted', text: fmtDuration(d.now - s.firstSeen) });
    return h('tr', { class: likelyMatch ? 'hl' : '' }, what, server, lat, traffic, seen);
  });
  tbl.replaceChildren(h('thead', {}, head), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 5, class: 'muted', text: 'No internet servers right now.' }))));
}

function renderTimeline(d) {
  const ol = $('#dTimeline');
  if (!d.timeline.length) { ol.replaceChildren(h('li', { class: 'muted', text: 'Nothing yet. Join or leave a match and changes show up here.' })); return; }
  ol.replaceChildren(...d.timeline.map((e) => {
    const where = `${e.ip}${e.port ? `:${e.port}` : ''} ${e.transports.join('+').toUpperCase()}${e.owner ? ` · ${e.owner}` : ''}`;
    let icon, text;
    if (e.type === 'appeared') { icon = '+'; text = `New server ${where}`; }
    else if (e.type === 'gone') { icon = '−'; text = `Gone after ${fmtDuration(e.durationMs ?? 0)}: ${where}`; }
    else { icon = e.role === 'realtime' ? '●' : '○'; text = e.role === 'realtime' ? `Live traffic started: ${where}` : `Live traffic stopped (${ROLE[e.role]?.text ?? e.role}): ${where}`; }
    return h('li', { class: `ev ev-${e.type}${e.role === 'realtime' ? ' ev-live' : ''}` },
      h('span', { class: 'ev-time num muted', text: time(e.t) }),
      h('span', { class: 'ev-icon', 'aria-hidden': 'true', text: icon }),
      h('span', { text }));
  }));
}

function renderSockets(d) {
  const { tcp, udp } = d.sockets;
  $('#dSockTitle').textContent = `Sockets (${tcp.length} TCP, ${udp.length} UDP)`;
  const lines = [
    ...tcp.map((c) => `TCP  ${c.localIp}:${c.localPort} → ${c.remoteIp}:${c.remotePort}  ${c.state}  pid ${c.pid}`),
    ...udp.map((c) => `UDP  ${c.localIp}:${c.localPort}  (listening)  pid ${c.pid}`),
  ];
  $('#dSockets').replaceChildren(h('pre', { text: lines.join('\n') || 'none' }));
}

async function loadHistory(force = false) {
  const box = $('#dHistory');
  if (history && !force) return;
  box.replaceChildren(h('p', { class: 'muted', text: 'Loading history…' }));
  try {
    const r = await fetch(`/api/process/history?exe=${encodeURIComponent(exe)}${force ? `&t=${Date.now()}` : ''}`);
    history = await r.json();
  } catch (e) {
    history = { configured: true, error: e.message };
  }
  renderHistory();
}

const DAY = 86_400_000;
const PAD = 15 * 60_000; // margin around the played hours of a day
const dayLabel = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function whenText(t) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / DAY);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
}
/** "9:12 PM–1:40 AM (next day)", or with the end date when the session ran longer. */
function spanText(x) {
  const days = Math.round((new Date(x.end).setHours(0, 0, 0, 0) - new Date(x.start).setHours(0, 0, 0, 0)) / DAY);
  const end = days > 1 ? `${shortDay(x.end)}, ${hm(x.end)}` : hm(x.end);
  return `${hm(x.start)}–${end}${days === 1 ? ' (next day)' : ''}`;
}

function kpi(label, value, sub) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'kpi-label', text: label }),
    h('div', { class: 'kpi-value num', text: value }),
    h('div', { class: 'kpi-sub muted', text: sub }));
}

function card(title, sub, body) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: title }), sub ? h('span', { class: 'muted', text: sub }) : null),
    body);
}

// ---- selection: which days (or which one session) the dashboard shows ----
// histSel: Set of day start times (local midnight). histZoom: a session index, or null.
let histSel = new Set();
let histAnchor = null;

function selectDay(t, e) {
  const playable = history.daily.filter((d) => d.minutes > 0).map((d) => d.t);
  if (e.shiftKey && histAnchor != null) {
    const [a, b] = [Math.min(histAnchor, t), Math.max(histAnchor, t)];
    histSel = new Set(playable.filter((d) => d >= a && d <= b));
  } else if (e.ctrlKey || e.metaKey) {
    if (histSel.has(t) && histSel.size > 1) histSel.delete(t); else histSel.add(t);
    histAnchor = t;
  } else {
    histSel = new Set([t]);
    histAnchor = t;
  }
  histZoom = null;
  drawHistory();
}

/**
 * The time ranges to show. Each selected day becomes one segment trimmed to the
 * hours with data; segments sit side by side, so unselected days take no space.
 */
function segments() {
  const pts = history.points;
  if (histZoom != null) {
    const s = history.sessions[histZoom];
    return [{ a: s.start - 5 * 60_000, b: s.end + 5 * 60_000, from: s.start, to: s.end }];
  }
  const out = [];
  for (const d of [...histSel].sort((x, y) => x - y)) {
    const inDay = pts.filter(([t]) => t >= d && t < d + DAY);
    if (!inDay.length) continue;
    out.push({
      a: Math.max(d, inDay[0][0] - PAD), b: Math.min(d + DAY, inDay.at(-1)[0] + 60_000 + PAD),
      from: d, to: d + DAY,
    });
  }
  return out;
}

function renderHistory() {
  const box = $('#dHistory');
  const H = history;
  $('#dHistTitle').textContent = `Historical metrics for ${(exe ?? '').replace(/\.exe$/i, '')}`;
  const src = H.source ?? {};
  const srcName = src.name ? `Source: ${src.name}` : 'History off';
  $('#dHistSrc').textContent = H.configured && H.days ? `${srcName} · last ${H.days} days` : srcName;
  if (!H.configured) {
    box.replaceChildren(
      h('p', {}, src.name ? `Not set up. ${src.intro ?? ''}` : (src.intro ?? 'History is turned off.')),
      (src.vars ?? []).length ? h('ul', {}, ...src.vars.map((v) => h('li', {}, h('code', { text: v.name }), `: ${v.hint}`))) : null,
      src.readme ? h('p', { class: 'muted', text: `See README → "${src.readme}".` }) : null);
    return;
  }
  if (H.error) { box.replaceChildren(h('p', { class: 'err', text: H.error })); return; }
  if (!H.sessions.length) { box.replaceChildren(h('p', { class: 'muted', text: `No ${exe} process metrics in the last ${H.days} days.` })); return; }

  const game = H.category === 'game';
  // Start on the most recent day with data. Days before the first recorded
  // minute are left out: there was no data yet.
  const firstDay = H.daily.findIndex((d) => d.minutes > 0);
  const days = H.daily.slice(Math.max(0, firstDay));
  const latest = [...days].reverse().find((d) => d.minutes > 0);
  if (!histSel.size || ![...histSel].every((t) => days.some((d) => d.t === t && d.minutes > 0))) {
    histSel = new Set([latest.t]);
    histAnchor = latest.t;
  }
  const maxMin = Math.max(...days.map((d) => d.minutes));
  const dayButtons = days.map((d) => {
    const b = h('button', {
      type: 'button', class: 'day', 'data-t': String(d.t), 'aria-pressed': 'false',
      'aria-label': `${dayLabel(d.t)}: ${d.minutes ? fmtDuration(d.minutes * 60_000) : 'no data'}`,
    },
      h('span', { class: 'day-wd', text: new Date(d.t).toLocaleDateString([], { weekday: 'short' }) }),
      h('span', { class: 'day-date', text: shortDay(d.t) }),
      h('span', { class: 'day-val num', text: d.minutes ? fmtDuration(d.minutes * 60_000) : '–' }),
      h('span', { class: 'day-bar' }, h('span', { style: `width:${Math.round((d.minutes / maxMin) * 100)}%` })));
    if (!d.minutes) b.disabled = true;
    else b.addEventListener('click', (e) => selectDay(d.t, e));
    return b;
  });
  const allBtn = h('button', { type: 'button', class: 'clear', id: 'hAll' }, 'All days');
  allBtn.addEventListener('click', () => {
    histSel = new Set(days.filter((d) => d.minutes > 0).map((d) => d.t));
    histZoom = null;
    drawHistory();
  });

  box.replaceChildren(
    h('div', { class: 'days-head' },
      h('span', { class: 'card-title', text: game ? 'Playtime by day' : 'Time running by day' }),
      h('span', { class: 'muted', text: 'Click a day · Ctrl-click to add or remove days · Shift-click for a range' }),
      allBtn),
    h('div', { class: 'days', role: 'group', 'aria-label': 'Days to show' }, dayButtons),
    h('div', { class: 'sel-label', id: 'hSelLabel' }),
    h('div', { class: 'kpis', id: 'hKpis' }),
    h('div', { class: 'hist-grid' },
      card('CPU', '% of whole PC, per minute', h('svg', { class: 'bigchart', id: 'hCpu', 'aria-label': 'CPU for the selected days' })),
      card('Memory', 'working set, per minute', h('svg', { class: 'bigchart', id: 'hMem', 'aria-label': 'Memory for the selected days' })),
      H.vramPoints?.length ? card('Video memory', 'dedicated, per minute', h('div', { id: 'hVramWrap' }, h('svg', { class: 'bigchart', id: 'hVram', 'aria-label': 'Video memory for the selected days' }))) : null),
    h('div', { class: 'hist-sessions' },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title', text: 'Sessions' }),
        h('span', { class: 'muted', id: 'hZoomNote' }),
        h('button', { class: 'clear', id: 'hZoomReset', type: 'button', hidden: '' }, 'Back to selected days')),
      h('div', { class: 'tablewrap' }, h('table', { class: 'tbl', id: 'dHistTable' },
        h('thead', {}, h('tr', {}, ...['Session', 'Length', 'CPU avg / peak', 'Memory avg / peak', 'Video memory peak'].map((t) => h('th', { text: t })))),
        h('tbody', {})))),
    ...[
      ...(src.notes ?? []),
      `A new session starts after a ${H.gapMinutes ?? 10}+ minute gap. Days are your local calendar days.`,
      H.gpuNote,
    ].filter(Boolean).map((n) => h('p', { class: 'muted note', text: n })));
  $('#hZoomReset').addEventListener('click', () => { histZoom = null; drawHistory(); });
  drawHistory();
}

/** Redraws everything that depends on the selection: tiles, numbers, charts, sessions. */
function drawHistory() {
  const H = history;
  if (!H?.sessions?.length || !$('#hCpu')) return;
  const game = H.category === 'game';
  for (const b of view.querySelectorAll('.day')) b.setAttribute('aria-pressed', String(histZoom == null && histSel.has(Number(b.dataset.t))));

  const segs = segments();
  const inRange = (t) => segs.some((s) => t >= s.from && t < s.to);
  const pts = H.points.filter(([t]) => inRange(t));
  const vram = (H.vramPoints ?? []).filter(([t]) => inRange(t));
  const overlaps = (s) => segs.some((g) => s.start < g.to && s.end > g.from);
  const zoomed = histZoom != null ? H.sessions[histZoom] : null;

  // selection label
  const sel = [...histSel].sort((a, b) => a - b);
  const contiguous = sel.every((t, i) => i === 0 || t - sel[i - 1] <= DAY + 3_600_000); // DST-safe
  $('#hSelLabel').textContent = zoomed ? `Showing one session: ${dayLabel(zoomed.start)}, ${spanText(zoomed)}`
    : sel.length === 1 ? `Showing ${dayLabel(sel[0])}`
    : contiguous ? `Showing ${sel.length} days: ${shortDay(sel[0])} – ${shortDay(sel.at(-1))}`
    : `Showing ${sel.length} days: ${sel.map(shortDay).join(', ')}`;

  // headline numbers for the selection
  const vals = (i) => pts.map((p) => p[i]).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const max = (a) => (a.length ? Math.max(...a) : null);
  const cpu = vals(1), mem = vals(2), vr = vram.map((p) => p[1]);
  const sessions = H.sessions.filter(overlaps);
  const longest = sessions.reduce((a, s) => Math.max(a, s.end - s.start), 0);
  const vramSince = H.vramPoints?.length ? shortDay(H.vramPoints[0][0]) : null;
  $('#hKpis').replaceChildren(
    kpi(game ? 'Playtime' : 'Time running', fmtDuration(pts.length * 60_000), 'minutes with data'),
    kpi('Sessions', String(sessions.length), sessions.length ? `longest ${fmtDuration(longest)} · last ${whenText(H.summary.lastEnd).toLowerCase()} ${hm(H.summary.lastEnd)}` : ''),
    kpi('CPU (% of whole PC)', pct(avg(cpu)), cpu.length ? `average · peak ${pct(max(cpu))}` : ''),
    kpi('Memory', fmtBytes(avg(mem)), mem.length ? `average · peak ${fmtBytes(max(mem))}` : ''),
    kpi('Video memory', fmtBytes(max(vr)), vr.length ? 'peak' : vramSince ? `no data for this selection (recorded since ${vramSince})` : 'no per-game GPU data'));

  // sessions overlapping the selection; click one to zoom the charts to it
  $('#dHistTable tbody').replaceChildren(...H.sessions.map((x, i) => {
    if (!overlaps(x) && i !== histZoom) return null;
    const tr = h('tr', { class: `click${i === histZoom ? ' hl' : ''}`, tabindex: '0', 'aria-label': `Zoom charts to the session on ${dayLabel(x.start)}` },
      h('td', {}, h('div', { class: 'strong', text: dayLabel(x.start) }), h('div', { class: 'muted', text: spanText(x) })),
      h('td', { class: 'num', text: fmtDuration(x.end - x.start) }),
      h('td', { class: 'num', text: `${pct(x.cpuAvg)} / ${pct(x.cpuPeak)}` }),
      h('td', { class: 'num', text: `${fmtBytes(x.memAvg)} / ${fmtBytes(x.memPeak)}` }),
      h('td', { class: 'num', text: fmtBytes(x.vramPeak) }));
    const pick = () => { histZoom = histZoom === i ? null : i; drawHistory(); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    return tr;
  }).filter(Boolean));
  $('#hZoomReset').hidden = !zoomed;
  $('#hZoomNote').textContent = zoomed ? 'charts zoomed to this session' : 'click a session to zoom the charts to it';

  // Segmented time axis: each segment's real time maps onto one shared axis.
  let off = 0;
  const axis = segs.map((s) => { const r = { ...s, off }; off += s.b - s.a; return r; });
  const total = Math.max(1, off);
  const toV = (t) => { const s = axis.find((g) => t >= g.a && t < g.b); return s ? s.off + (t - s.a) : null; };
  const toReal = (v) => { const s = axis.find((g) => v >= g.off && v <= g.off + (g.b - g.a)) ?? axis.at(-1); return s.a + (v - s.off); };
  const separators = axis.slice(1).filter((s, i) => s.a !== axis[i].b).map((s) => s.off);
  const line = (list) => {
    const out = [];
    let prevT = null;
    for (const [t, v] of list) {
      const vt = toV(t);
      if (vt == null) continue;
      if (prevT != null && t - prevT > 3 * 60_000) out.push([toV(prevT) + 60_000, null]); // gap: break the line
      out.push([vt, v]);
      prevT = t;
    }
    return out;
  };
  const ticksFor = (svg) => {
    const px = Math.max(svg.clientWidth - 34, 120);
    const ticks = [];
    for (const s of axis) {
      const w = (px * (s.b - s.a)) / total;
      const d = new Date(s.a);
      const startLabel = axis.length > 1 || zoomed ? [[s.off, `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`]] : [];
      // Keep hour labels clear of the day labels at both ends of the segment.
      const edge = (v) => Math.min(v - s.off, s.off + (s.b - s.a) - v) / total * px;
      const inner = timeTicks(s.a, s.b, w).map(([t, l]) => [s.off + (t - s.a), l]).filter(([v]) => !startLabel.length || edge(v) > 50);
      ticks.push(...startLabel, ...(w > 90 ? inner : []));
    }
    return ticks;
  };
  const when = (v) => new Date(toReal(v)).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const opts = (svg, extra) => ({ height: 170, xFrom: 0, xTo: total, timeFormat: when, xTicks: ticksFor(svg), separators, ...extra });
  const cpuSvg = $('#hCpu'), memSvg = $('#hMem'), vramSvg = $('#hVram');
  lineChart(cpuSvg, line(pts.map(([t, c]) => [t, c])), opts(cpuSvg, { yFloor: 10, format: (v) => `${Math.round(v)}%` }));
  lineChart(memSvg, line(pts.map(([t, , m]) => [t, m])), opts(memSvg, { yFloor: 1024 ** 3, format: fmtBytes }));
  if (vramSvg) lineChart(vramSvg, line(vram), opts(vramSvg, { yFloor: 1024 ** 3, format: fmtBytes }));
}

window.addEventListener('resize', () => { if (exe && history) drawHistory(); });

async function tick() {
  if (!exe) return;
  try {
    const r = await fetch(`/api/process?exe=${encodeURIComponent(exe)}`);
    const d = await r.json();
    if (!exe) return;
    renderHeader(d);
    renderResources(d);
    renderServers(d);
    renderTimeline(d);
    renderSockets(d);
  } catch (e) {
    $('#dResNote').textContent = `Could not reach the app: ${e.message}`;
  }
}

export function openProcess(name) {
  if (exe === name) return;
  exe = name;
  history = null;
  histZoom = null;
  histSel = new Set();
  skeleton();
  view.hidden = false;
  document.title = `${name} · Game Latency Monitor`;
  tick();
  loadHistory();
  clearInterval(timer);
  timer = setInterval(tick, 2000);
}

export function closeProcess() {
  exe = null;
  clearInterval(timer);
  view.hidden = true;
  document.title = 'Game Latency Monitor';
}
