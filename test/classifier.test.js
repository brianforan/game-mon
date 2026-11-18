import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessClassifier } from '../src/classifier.js';

// Stand-in for the Anthropic client: records requests, returns canned labels.
function fakeClient(labels) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(req) {
        calls.push(req);
        const names = JSON.parse(req.messages[0].content);
        return {
          stop_reason: 'end_turn',
          parsed_output: { processes: names.filter((n) => labels[n]).map((n) => ({ exe: n, ...labels[n] })) },
        };
      },
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('config games and overrides win without any API call', () => {
  const c = new ProcessClassifier({ gameProcesses: ['cs2.exe'], overrides: { 'ROB RUN.exe': 'game' }, useEnvCredentials: false });
  assert.equal(c.get('CS2.exe').category, 'game');
  assert.equal(c.get('ROB RUN.exe').category, 'game');
  assert.equal(c.get('ROB RUN.exe').source, 'override');
  // no key in tests: unknown names stay unlabelled and nothing is queued
  assert.equal(c.get('Discord.exe').category, 'unlabelled');
  assert.equal(c.queue.size, 0);
});

test('unknown names are batched into one Haiku call and cached to disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'glm-test-'));
  const cacheFile = path.join(dir, 'labels.json');
  const client = fakeClient({
    'Discord.exe': { label: 'Discord', category: 'chat' },
    'Spotify.exe': { label: 'Spotify', category: 'media' },
  });
  const c = new ProcessClassifier({ cacheFile, client });
  c.get('Discord.exe');
  c.get('Spotify.exe');
  c.get('mystery.exe'); // model returns nothing for this one
  assert.equal(c.get('Discord.exe').source, 'pending');
  await wait(1700); // debounce
  await wait(50);

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(JSON.parse(client.calls[0].messages[0].content), ['Discord.exe', 'Spotify.exe', 'mystery.exe']);
  assert.deepEqual(c.get('discord.exe'), { label: 'Discord', category: 'chat', source: 'haiku' });
  assert.equal(c.get('mystery.exe').category, 'other');

  const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(saved['spotify.exe'].category, 'media');

  // a fresh instance reads the cache instead of calling again
  const again = new ProcessClassifier({ cacheFile, client });
  assert.equal(again.get('Spotify.exe').label, 'Spotify');
  assert.equal(client.calls.length, 1);
});

test('a rejected API key disables labelling instead of retrying', async () => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  let calls = 0;
  const client = { messages: { parse: async () => { calls++; throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()); } } };
  const c = new ProcessClassifier({ client });
  c.get('Discord.exe');
  await wait(1750);
  assert.equal(calls, 1);
  assert.equal(c.status().enabled, false);
  assert.match(c.status().error, /API key rejected \(401\)/);
  assert.equal(c.status().pending, 0);
  c.get('Spotify.exe'); // no new work queued once disabled
  assert.equal(c.queue.size, 0);
});

test('API errors are reported and retried later, not cached', async () => {
  const client = { messages: { parse: async () => { throw new Error('boom'); } } };
  const c = new ProcessClassifier({ client });
  c.get('Discord.exe');
  await wait(1750);
  assert.equal(c.status().error, 'boom');
  assert.equal(c.status().pending, 1);
  assert.equal(c.get('Discord.exe').category, 'unlabelled');
  clearTimeout(c.timer);
});
