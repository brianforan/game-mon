// Backend-neutral history maths: per-minute buckets -> sessions, daily totals,
// summary numbers and per-session GPU figures. Every backend hands in the same
// bucket shapes, so none of this knows where the data came from.

/** Local calendar day (YYYY-MM-DD) of a timestamp. */
const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Minutes with data per local day, one entry per day of the window (zeros
 * included) so a bar chart shows the days you didn't play too.
 */
export function dailyMinutes(buckets, days, now = Date.now()) {
  const counts = new Map();
  for (const b of buckets) counts.set(localDay(b.t), (counts.get(localDay(b.t)) ?? 0) + 1);
  const out = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    out.push({ day: localDay(d.getTime()), t: d.getTime(), minutes: counts.get(localDay(d.getTime())) ?? 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Totals across sessions; averages are weighted by minutes played. */
export function summarize(sessions) {
  if (!sessions.length) return null;
  const minutes = sessions.reduce((a, s) => a + s.minutes, 0);
  const wavg = (k) => {
    const w = sessions.filter((s) => s[k] != null);
    const m = w.reduce((a, s) => a + s.minutes, 0);
    return m ? w.reduce((a, s) => a + s[k] * s.minutes, 0) / m : null;
  };
  const max = (k) => { const v = sessions.map((s) => s[k]).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
  const longest = sessions.reduce((a, s) => (s.end - s.start > a.end - a.start ? s : a));
  return {
    sessions: sessions.length, minutes,
    cpuAvg: wavg('cpuAvg'), cpuPeak: max('cpuPeak'),
    memAvg: wavg('memAvg'), memPeak: max('memPeak'),
    vramPeak: max('vramPeak'),
    longestMs: longest.end - longest.start,
    lastEnd: Math.max(...sessions.map((s) => s.end)),
  };
}

/** Split per-minute buckets into sessions wherever the gap exceeds gapMs. */
export function groupSessions(buckets, gapMs) {
  const sessions = [];
  let cur = null;
  for (const b of buckets) {
    if (!cur || b.t - cur.lastT > gapMs) {
      cur = { buckets: [], lastT: b.t };
      sessions.push(cur);
    }
    cur.buckets.push(b);
    cur.lastT = b.t;
  }
  return sessions.map(({ buckets: bs }) => {
    const vals = (k) => bs.map((b) => b[k]).filter((v) => v != null);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const max = (a) => (a.length ? Math.max(...a) : null);
    return {
      start: bs[0].t,
      end: bs.at(-1).t + 60_000,
      minutes: bs.length,
      cpuAvg: avg(vals('cpu')), cpuPeak: max(vals('cpu')),
      memAvg: avg(vals('mem')), memPeak: max(vals('mem')),
      pids: [...new Set(bs.flatMap((b) => b.pids ?? []))],
    };
  });
}

/**
 * Add gpuAvg / gpuPeak / vramPeak to each session from per-minute GPU buckets
 * ({ t, gpu, vram }), and return the VRAM series as [t, bytes] pairs.
 */
export function attachGpu(sessions, gpuBuckets) {
  for (const s of sessions) {
    const inS = gpuBuckets.filter((b) => b.t >= s.start && b.t < s.end);
    const g = inS.map((b) => b.gpu).filter((v) => v != null);
    const v = inS.map((b) => b.vram).filter((x) => x != null);
    s.gpuAvg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : null;
    s.gpuPeak = g.length ? Math.max(...g) : null;
    s.vramPeak = v.length ? Math.max(...v) : null;
  }
  return gpuBuckets.filter((b) => b.vram != null).map((b) => [b.t, b.vram]);
}
