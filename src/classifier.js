// Labels each process (e.g. "ROB RUN.exe") with a friendly name and a
// category by asking Claude Haiku. Each name is asked about once and cached
// in data/process-labels.json. Only the .exe *names* of processes that have
// internet connections are sent, never IPs, paths or anything else.
//
// Precedence: config.processOverrides > config.gameProcesses > cache/Haiku.
// Without an API key the app still works: config games are "game", the rest
// are "unlabelled".
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const CATEGORIES = {
  game: 'Games',
  'game-services': 'Launchers & anti-cheat',
  chat: 'Chat & voice',
  browser: 'Browsers',
  media: 'Music & video',
  'cloud-sync': 'Cloud sync',
  security: 'Security & VPN',
  developer: 'Developer tools',
  productivity: 'Productivity',
  system: 'Windows & system',
  other: 'Other',
};

const MODEL = 'claude-haiku-5-5';
const BATCH = 40;
const DEBOUNCE_MS = 1500;
const RETRY_AFTER_ERROR_MS = 60_000;

const Result = z.object({
  processes: z.array(z.object({
    exe: z.string(),
    label: z.string(),
    category: z.enum(Object.keys(CATEGORIES)),
  })),
});

const SYSTEM = `You label Windows process names for a network latency monitor used by a gamer.
For each executable name, give:
- label: the product's common name, short (e.g. "Discord", "League of Legends", "Windows Search"). If you don't recognise it, make a sensible title from the file name.
- category, exactly one of:
  game: a game client itself, the process that plays the game (including games you can tell are games from the name)
  game-services: game launchers, stores, anti-cheat, game overlays and companion apps (Steam, Riot Client, Battle.net, Vanguard, EasyAntiCheat, OP.GG)
  chat: messaging and voice chat (Discord, Slack, Teams, TeamSpeak, WhatsApp)
  browser: web browsers and their helper processes
  media: music and video streaming and players (Spotify, VLC, Netflix)
  cloud-sync: file sync and backup (OneDrive, Dropbox, Google Drive)
  security: antivirus, firewalls, VPNs, password managers, blockers
  developer: programming tools, runtimes, terminals, AI coding tools, monitoring agents
  productivity: office, notes, email and other work apps
  system: Windows components and drivers (svchost, explorer, SearchHost, LockApp)
  other: anything that fits none of the above
Return one entry per input name, with exe copied exactly as given.`;

export class ProcessClassifier {
  constructor({ cacheFile, gameProcesses = [], overrides = {}, client, useEnvCredentials = true } = {}) {
    this.cacheFile = cacheFile;
    this.games = new Set(gameProcesses.map((n) => n.toLowerCase()));
    this.overrides = new Map(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]));
    this.cache = new Map();
    this.queue = new Set();
    this.inFlight = false;
    this.timer = null;
    this.lastError = null;
    this.retryAt = 0;
    this.calls = 0;

    if (cacheFile && existsSync(cacheFile)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8')))) this.cache.set(k, v);
      } catch (e) { console.warn(`Ignoring unreadable ${cacheFile}: ${e.message}`); }
    }

    // The SDK finds credentials itself (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
    // or an `ant auth login` profile). Only enable when one is plausibly there.
    if (client) this.client = client;
    else if (useEnvCredentials && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE)) {
      try { this.client = new Anthropic(); } catch (e) { this.lastError = e.message; }
    }
    this.enabled = !!this.client;
  }

  /** Label for one process name. Never blocks; unknown names are queued for Haiku. */
  get(exe) {
    const key = String(exe).toLowerCase();
    const cached = this.cache.get(key);
    const ov = this.overrides.get(key);
    if (ov) return { label: cached?.label ?? exe.replace(/\.exe$/i, ''), category: ov, source: 'override' };
    if (this.games.has(key)) return { label: cached?.label ?? exe.replace(/\.exe$/i, ''), category: 'game', source: 'config' };
    if (cached) return { ...cached, source: 'haiku' };
    if (/^pid \d+$/.test(exe)) return { label: exe, category: 'other', source: 'unknown' };
    this.enqueue(exe);
    return { label: exe.replace(/\.exe$/i, ''), category: 'unlabelled', source: this.enabled ? 'pending' : 'none' };
  }

  enqueue(exe) {
    if (!this.enabled || this.queue.has(exe)) return;
    this.queue.add(exe);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(DEBOUNCE_MS, this.retryAt - Date.now()));
  }

  async flush() {
    if (this.inFlight || !this.queue.size) return;
    if (Date.now() < this.retryAt) { this.timer = setTimeout(() => this.flush(), this.retryAt - Date.now()); return; }
    const batch = [...this.queue].slice(0, BATCH);
    this.inFlight = true;
    try {
      const labels = await this.classify(batch);
      for (const exe of batch) {
        this.queue.delete(exe);
        const hit = labels.find((l) => l.exe.toLowerCase() === exe.toLowerCase());
        this.cache.set(exe.toLowerCase(), hit ? { label: hit.label, category: hit.category } : { label: exe.replace(/\.exe$/i, ''), category: 'other' });
      }
      this.lastError = null;
      await this.save();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        // Retrying can't fix a bad key: stop until the app is restarted with a new one.
        this.lastError = `API key rejected (${e.status}). Use a key from console.anthropic.com (starts with sk-ant-api) and restart.`;
        this.enabled = false;
        this.queue.clear();
        console.warn(`Process labelling disabled: ${this.lastError}`);
        return;
      }
      const detail = e instanceof Anthropic.APIError ? (e.error?.error?.message ?? e.message) : e.message;
      this.lastError = e instanceof Anthropic.APIError && e.status ? `${e.status}: ${detail}` : detail;
      this.retryAt = Date.now() + RETRY_AFTER_ERROR_MS;
      console.warn(`Process labelling failed (retrying in 60s): ${this.lastError}`);
    } finally {
      this.inFlight = false;
      if (this.queue.size) this.timer = setTimeout(() => this.flush(), Math.max(DEBOUNCE_MS, this.retryAt - Date.now()));
    }
  }

  async classify(names) {
    this.calls++;
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(Result) },
      messages: [{ role: 'user', content: JSON.stringify(names) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Haiku declined to label these processes');
    if (!response.parsed_output) throw new Error(`no structured output (stop_reason: ${response.stop_reason})`);
    return response.parsed_output.processes;
  }

  async save() {
    if (!this.cacheFile) return;
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    const sorted = Object.fromEntries([...this.cache.entries()].sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(this.cacheFile, JSON.stringify(sorted, null, 2) + '\n');
  }

  status() {
    return {
      enabled: this.enabled,
      model: MODEL,
      labelled: this.cache.size,
      pending: this.queue.size,
      error: this.lastError,
    };
  }
}
