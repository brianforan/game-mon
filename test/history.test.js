import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HistoryService } from '../src/history/index.js';

const m = 60_000;
const T0 = Date.now() - 2 * 60 * m;

// Stand-in backend: two sessions (3 min, then 2 min after a 30-min gap).
function fakeBackend({ gpu = true, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    name: 'Fake', configured: true, target: 'fake…',
    source: { name: 'Fake', intro: 'set FAKE', vars: [{ name: 'FAKE_URL', hint: 'anywhere' }], readme: 'x', notes: ['from fake'] },
    async minutes(names, opts) {
      calls.push(['minutes', names, opts]);
      if (fail) throw fail;
      return [0, 1, 2, 32, 33].map((i) => ({ t: T0 + i * m, cpu: 10 + i, mem: 1000 + i, pids: [i < 30 ? 1 : 2] }));
    },
    gpu: gpu ? async (sessions) => { calls.push(['gpu', sessions.length]); return [{ t: T0 + m, gpu: 50, vram: 4096 }]; } : undefined,
  };
}

test('history: sessions, GPU and caching through any backend', async () => {
  const be = fakeBackend();
  const h = new HistoryService(be, { days: 3, sessionGapMinutes: 10 });
  const r = await h.sessions('Game.exe');
  assert.equal(r.configured, true);
  assert.equal(r.source.name, 'Fake');
  assert.equal(r.gapMinutes, 10);
  assert.deepEqual(be.calls[0], ['minutes', ['Game.exe', 'Game'], { days: 3 }]);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[1].minutes, 3);          // newest first, so the older one is second
  assert.equal(r.sessions[1].vramPeak, 4096);
  assert.equal(r.sessions[0].vramPeak, null);
  assert.deepEqual(r.vramPoints, [[T0 + m, 4096]]);
  assert.equal(r.summary.minutes, 5);
  assert.equal(r.points.length, 5);
  await h.sessions('Game.exe');
  assert.equal(be.calls.length, 2);                // second call served from cache
});

test('history: backend without GPU, backend errors, not configured', async () => {
  const noGpu = await new HistoryService(fakeBackend({ gpu: false })).sessions('a.exe');
  assert.equal(noGpu.gpuNote, null);
  assert.deepEqual(noGpu.vramPoints, []);

  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const err = await new HistoryService(fakeBackend({ fail: timeout })).sessions('a.exe');
  assert.equal(err.error, 'Fake did not answer within 20 s');

  const unset = new HistoryService({ ...fakeBackend(), configured: false });
  assert.deepEqual(await unset.sessions('a.exe'), { configured: false, source: unset.backend.source });
  assert.match(unset.describe(), /Fake, not set up/);
});

test('history: backend selection from config', () => {
  const off = createHistory({ history: { backend: 'none' } });
  assert.equal(off.configured, false);
  assert.equal(off.source.name, null);
  assert.match(off.describe(), /off/);
  assert.throws(() => createHistory({ history: { backend: 'nope' } }), /Unknown history.backend "nope"/);
  assert.equal(createHistory({ history: { backend: 'elastic' }, elastic: { urlEnv: 'GLM_TEST_UNSET_URL', apiKeyEnv: 'GLM_TEST_UNSET_KEY' } }).backend.name, 'Elastic');
});
