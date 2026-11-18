// Small single-series line chart with a hover crosshair + tooltip.
// One series per chart, so no legend: the chart's title names it.
const SVG_NS = 'http://www.w3.org/2000/svg';
const tip = document.getElementById('tip');

function el(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function niceMax(v, floor = 1) {
  const m = Math.max(v, floor);
  const p = 10 ** Math.floor(Math.log10(m));
  for (const s of [1, 2, 2.5, 5, 10]) if (m <= s * p) return s * p;
  return 10 * p;
}

/**
 * Draw points [[t, value|null], ...] into an <svg>. Options:
 *   xFrom/xTo  time range (defaults to the data's range)
 *   yMax       fixed top of the scale (else a nice value above the data)
 *   format     value -> text for axis and tooltip
 *   height     pixel height (default 56)
 *   axis       show 0 / max labels (default true)
 *   xTicks     [[t, label], ...] time labels under the chart
 *   separators [t, ...] dashed vertical lines (e.g. where two non-adjacent days meet)
 */
export function lineChart(svg, points, opts = {}) {
  const H = opts.height ?? 56;
  const AX = opts.axis === false ? 0 : 34;
  const W = Math.max(svg.clientWidth, 80);
  const top = 5, bottom = H - 3 - (opts.xTicks ? 16 : 0);
  const fmt = opts.format ?? ((v) => String(Math.round(v)));
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  const yMax = opts.yMax ?? niceMax(Math.max(0, ...vals) * 1.1, opts.yFloor ?? 1);
  const x0 = opts.xFrom ?? points[0]?.[0] ?? 0;
  const x1 = opts.xTo ?? points.at(-1)?.[0] ?? 1;
  const span = Math.max(1, x1 - x0);
  const x = (t) => AX + ((t - x0) / span) * (W - AX);
  const y = (v) => bottom - (Math.min(v, yMax) / yMax) * (bottom - top);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.replaceChildren();
  for (const v of [0, yMax]) svg.append(el('line', { class: 'grid', x1: AX, x2: W, y1: y(v), y2: y(v) }));
  if (AX) {
    for (const [v, txt] of [[yMax, fmt(yMax)], [0, fmt(0)]]) {
      const tx = el('text', { class: 'axis', x: AX - 5, y: y(v) + 3, 'text-anchor': 'end' });
      tx.textContent = txt;
      svg.append(tx);
    }
  }
  for (const t of opts.separators ?? []) {
    svg.append(el('line', { class: 'sep', x1: x(t), x2: x(t), y1: top, y2: bottom }));
  }
  for (const [t, label] of opts.xTicks ?? []) {
    const tx = el('text', { class: 'axis', x: Math.min(Math.max(x(t), AX + 14), W - 14), y: H - 3, 'text-anchor': 'middle' });
    tx.textContent = label;
    svg.append(tx);
  }
  let d = '', area = '', start = null, prev = null;
  const close = () => { if (start != null && prev) area += `L${prev[0]},${bottom}L${start},${bottom}Z`; start = null; };
  for (const [t, v] of points) {
    if (v == null) { close(); prev = null; continue; }
    const p = [x(t).toFixed(1), y(v).toFixed(1)];
    if (!prev) { d += `M${p[0]},${p[1]}`; area += `M${p[0]},${bottom}L${p[0]},${p[1]}`; start = p[0]; }
    else { d += `L${p[0]},${p[1]}`; area += `L${p[0]},${p[1]}`; }
    prev = p;
  }
  close();
  svg.append(el('path', { class: 'area', d: area }), el('path', { class: 'line', d }));

  // hover layer
  const hover = el('rect', { x: AX, y: 0, width: W - AX, height: H, fill: 'transparent' });
  svg.append(hover);
  const cross = el('line', { class: 'cross', y1: top, y2: bottom, visibility: 'hidden' });
  const dot = el('circle', { class: 'marker', r: 4, visibility: 'hidden' });
  svg.append(cross, dot);
  hover.addEventListener('mousemove', (e) => {
    if (!points.length) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p[0]) - mx) < Math.abs(x(best[0]) - mx)) best = p;
    const bx = x(best[0]);
    cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.setAttribute('visibility', 'visible');
    if (best[1] != null) { dot.setAttribute('cx', bx); dot.setAttribute('cy', y(best[1])); dot.setAttribute('visibility', 'visible'); }
    else dot.setAttribute('visibility', 'hidden');
    tip.replaceChildren();
    const v = document.createElement('div');
    v.textContent = best[1] == null ? 'no data' : fmt(best[1]);
    const tt = document.createElement('div');
    tt.className = 't';
    tt.textContent = (opts.timeFormat ?? ((t) => new Date(t).toLocaleTimeString()))(best[0]);
    tip.append(v, tt);
    tip.hidden = false;
    tip.style.left = `${Math.min(rect.left + (bx / W) * rect.width + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${rect.top - 8}px`;
  });
  hover.addEventListener('mouseleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  });
}

export const fmtBytes = (b) => {
  if (b == null) return '–';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} kB`;
  return `${Math.round(b)} B`;
};

export const fmtDuration = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

// The ASN country is where the network owner is registered (G-Core = LU),
// not where the server is. Ping time gives a hard physical limit instead:
// light in fibre covers ~200 km per ms one way, so ~100 km per ms of RTT.
export function distanceText(t) {
  const min = t.stats?.min;
  if (min == null || t.method === 'hop' || min < 1) return null;
  const km = Math.round((min * 100) / 50) * 50;
  return `within ~${km.toLocaleString()} km (from ping)`;
}

/**
 * Where a server is, for display. Uses the looked-up city when there is one
 * (with distance from you), warns when that city is impossible for the
 * measured ping, and falls back to the registration country + ping bound.
 */
export function locationText(t) {
  const g = t.geo;
  const min = t.stats?.min;
  const bound = min != null && t.method !== 'hop' && min >= 1 ? Math.round((min * 100) / 50) * 50 : null;
  if (g && (g.city || g.countryCode)) {
    const place = [...new Set([g.city, g.region, g.countryCode].filter(Boolean))].join(', ');
    if (g.plausible === false) {
      // CDNs and big clouds use anycast: one IP served from many sites, and
      // you reach the nearest one, so a single database city can't be right.
      const anycast = ['cdn', 'cloud'].includes(t.info?.tag);
      return {
        text: anycast
          ? `anycast: answered from a site within ~${bound?.toLocaleString()} km (database says ${place})`
          : `⚠ ${place}? not possible at ${Math.round(min)} ms ping (≤ ~${bound?.toLocaleString()} km)`,
        warn: !anycast,
      };
    }
    return { text: `${place}${g.distanceKm != null ? ` · ~${g.distanceKm.toLocaleString()} km away` : ''}`, warn: false };
  }
  const i = t.info ?? {};
  return { text: [i.country ? `registered ${i.country}` : null, distanceText(t)].filter(Boolean).join(' · '), warn: false };
}

const HOUR = 3_600_000;
/** Evenly spaced, local-time-aligned ticks for a time range at a given pixel width. */
export function timeTicks(x0, x1, width) {
  const max = Math.max(2, Math.floor(width / 80));
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 96 * HOUR, 168 * HOUR];
  const step = steps.find((st) => (x1 - x0) / st <= max) ?? steps.at(-1);
  const d = new Date(x0);
  if (step >= 24 * HOUR) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  const ticks = [];
  for (let t = d.getTime(); t <= x1; t += step) {
    if (t < x0) continue;
    const dt = new Date(t);
    const label = step >= 24 * HOUR
      ? dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : dt.getHours() === 0 ? dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : dt.toLocaleTimeString([], { hour: 'numeric' });
    ticks.push([t, label]);
  }
  return ticks;
}
