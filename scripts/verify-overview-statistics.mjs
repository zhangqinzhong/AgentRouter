// Read-only audit of the same collector aggregations consumed by Overview.
// The private queue is copied once for a consistent view and deleted on exit.
// Only aggregate counts/costs are printed; no session content or credentials.
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { queryOffline } = require('../packages/core/src/vendor/tokentracker/lib/offline-api.js');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  if (!arg.startsWith('--') || index < 3) throw new Error('Use --queue=PATH, --now=ISO, --tz=ZONE, or --fixture=PATH');
  const key = arg.slice(2, index);
  if (!['queue', 'now', 'tz', 'fixture'].includes(key)) throw new Error(`Unknown option: ${key}`);
  return [key, arg.slice(index + 1)];
}));
const queuePath = args.queue || path.join(homedir(), '.agentrouter', 'collector', 'queue.jsonl');
const now = args.now ? new Date(args.now) : new Date();
assert.ok(Number.isFinite(now.getTime()), 'Invalid --now');
const tz = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const day = value => dateFormat.format(value);
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const fields = ['total_tokens', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'reasoning_output_tokens', 'conversation_count'];
const temp = mkdtempSync(path.join(tmpdir(), 'ar-overview-verify-'));
chmodSync(temp, 0o700);

try {
  const snapshot = path.join(temp, 'queue.jsonl');
  copyFileSync(queuePath, snapshot);
  chmodSync(snapshot, 0o600);
  const request = (endpoint, query) => queryOffline(snapshot, `/functions/tokentracker-usage-${endpoint}`, query);

  async function audit(name, query, hourly = false) {
    const [summary, breakdown, daily] = await Promise.all([
      request('summary', query), request('model-breakdown', query), request('daily', query),
    ]);
    const models = breakdown.sources.flatMap(source => source.models.map(model => model.totals));
    const clients = breakdown.sources.map(source => source.totals);
    const series = hourly
      ? (await Promise.all(daily.data.map(row => request('hourly', { ...query, day: row.day })))).flatMap(result => result.data)
      : daily.data;
    for (const [view, rows] of [['models', models], ['clients', clients], ['series', series]]) {
      for (const field of fields) {
        assert.equal(sum(rows, field), Number(summary.totals[field] || 0), `${name}/${view}/${field}`);
      }
      // API cost fields are rounded to six decimals per model/source; allow
      // only that rounding error, never a different pricing calculation.
      const tolerance = (models.length + clients.length + 2) * 0.0000005 + 1e-8;
      assert.ok(Math.abs(sum(rows, 'total_cost_usd') - Number(summary.totals.total_cost_usd)) <= tolerance, `${name}/${view}/cost`);
    }
    const peak = daily.data.reduce((max, row) => !max || row.total_tokens > max.total_tokens ? row : max, null);
    return {
      range: name, buckets: series.length,
      tokens: Number(summary.totals.total_tokens),
      recordedTurns: Number(summary.totals.conversation_count),
      costUsd: Number(summary.totals.total_cost_usd),
      cacheRatio: (() => {
        const cache = Number(summary.totals.cached_input_tokens) + Number(summary.totals.cache_creation_input_tokens);
        const input = Number(summary.totals.input_tokens);
        return input + cache > 0 ? cache / (input + cache) : 0;
      })(),
      modelGroups: models.length, clients: clients.length,
      peak: peak ? { day: peak.day, tokens: peak.total_tokens } : null,
      checked: ['summary', 'models', 'clients', hourly ? 'hourly series' : 'daily series'],
    };
  }

  const base = { from: '', to: day(now), tz };
  const results = [await audit('all', base)];
  for (const [name, hours] of [['24h', 24], ['7d', 7 * 24], ['30d', 30 * 24]]) {
    const since = new Date(now.getTime() - hours * 3_600_000);
    results.push(await audit(name, { ...base, from: day(since), since: since.toISOString() }, name === '24h'));
  }
  const from = new Date(now.getTime() - 14 * 86_400_000);
  const to = new Date(now.getTime() - 7 * 86_400_000);
  results.push(await audit('custom', { ...base, from: day(from), to: day(to) }));
  const breakdown = await request('model-breakdown', base);
  const topModel = breakdown.sources.flatMap(source => source.models)
    .sort((a, b) => Number(b.totals.total_tokens) - Number(a.totals.total_tokens))[0]?.model;
  if (topModel) results.push(await audit('model-filter', { ...base, model: topModel }));
  const topSource = [...breakdown.sources].sort((a, b) => Number(b.totals.total_tokens) - Number(a.totals.total_tokens))[0]?.source;
  if (topSource) results.push(await audit('client-filter', { ...base, source: topSource }));
  if (args.fixture) {
    const daily = await request('daily', base);
    const fixture = {
      generatedAt: now.toISOString(), language: 'en',
      series: daily.data.map(row => ({
        bucket: row.day, totalTokens: Number(row.total_tokens) || 0,
        costUsd: Number(row.total_cost_usd) || 0, requestCount: Number(row.conversation_count) || 0,
      })),
    };
    writeFileSync(args.fixture, JSON.stringify(fixture), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ now: now.toISOString(), timeZone: tz, snapshotBytes: statSync(snapshot).size, passed: true, results }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
