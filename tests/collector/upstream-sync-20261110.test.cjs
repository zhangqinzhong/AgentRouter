const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseWorkbuddyIncremental, readZcodeDbMessages, parseRolloutIncremental } = require('../../packages/core/src/vendor/tokentracker/lib/rollout');
const { withAccountLimitsCache } = require('../../packages/core/src/vendor/tokentracker/lib/account-limits-cache');
const { buildSessionAnalytics, resolveSessionSidecarPath } = require('../../packages/core/src/vendor/tokentracker/lib/session-analytics');
const temp = async t => { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-upstream-')); t.after(() => fs.rm(p, { recursive: true, force: true })); return p; };
const hour = '2026-11-10T10:00:00.000Z';

test('WorkBuddy retries an incomplete UTF-8 tail after a cursor restart', async t => {
  const home = await temp(t), file = path.join(home, 'session.jsonl'), queuePath = path.join(home, 'queue.jsonl');
  const record = id => JSON.stringify({ id, sessionId: 'work', timestamp: Date.parse(hour), text: '中文', providerData: { model: 'test', rawUsage: { prompt_tokens: 50, completion_tokens: 10 } } }) + '\n';
  const first = record('one'), second = Buffer.from(record('two'));
  const split = second.indexOf(Buffer.from('中文')) + 1;
  await fs.writeFile(file, Buffer.concat([Buffer.from(first), second.subarray(0, split)]));
  let cursors = {};
  const sync = () => parseWorkbuddyIncremental({ projectFiles: [file], cursors, queuePath, env: { HOME: home } });
  await sync(); assert.equal(cursors.workbuddy.fileOffsets[file].size, Buffer.byteLength(first));
  cursors = JSON.parse(JSON.stringify(cursors));
  await fs.appendFile(file, second.subarray(split)); await sync();
  const rows = (await fs.readFile(queuePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).total_tokens, 120);
  const saved = await fs.readFile(queuePath, 'utf8'); await sync();
  assert.equal(await fs.readFile(queuePath, 'utf8'), saved);
});

test('ZCode renamed providerId is included, bundled provider subagents stay excluded', async t => {
  const home = await temp(t), db = path.join(home, 'zcode.db');
  const row = providerId => ({ role: 'assistant', sessionID: 's', modelId: 'GLM-5.3', providerId,
    time: { created: Date.parse(hour), completed: Date.parse(hour) + 100 }, tokens: { input: 50, output: 8, cache: { read: 12, write: 0 } } });
  const quote = x => JSON.stringify(x).replaceAll("'", "''");
  execFileSync('sqlite3', [db, `CREATE TABLE session(id TEXT, directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); INSERT INTO session VALUES('s','/fixture'); INSERT INTO message VALUES('native','s',1,2,'${quote(row('account:bigmodel-coding-plan'))}'),('subagent','s',2,3,'${quote(row('openai'))}');`]);
  assert.deepEqual(readZcodeDbMessages(db).map(r => r.id), ['native']);
});

test('Codex keeps unknown and distinct models within each configuration instance', async t => {
  const home = await temp(t), queuePath = path.join(home, 'queue.jsonl');
  const totals = n => ({ input_tokens: n, output_tokens: 0, total_tokens: n, billable_total_tokens: n });
  const sources = ['codex', 'codex@ar-instance:fixture'];
  const buckets = Object.fromEntries(sources.flatMap(source => ['model-a', 'model-b', 'unknown'].map((m, i) => [`${source}|${m}|${hour}`, { totals: totals((i + 1) * 10) }])));
  let cursors = { hourly: { buckets } };
  await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
  const rows = (await fs.readFile(queuePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 6);
  for (const source of sources) assert.deepEqual(rows.filter(r => r.source === source).map(r => r.total_tokens).sort((a,b) => a-b), [10,20,30]);
  const saved = await fs.readFile(queuePath, 'utf8'); cursors = JSON.parse(JSON.stringify(cursors));
  await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
  assert.equal(await fs.readFile(queuePath, 'utf8'), saved);
});

test('account quota fallback keeps resets, auth failures, account switches and product refreshes isolated', async t => {
  const home = await temp(t); let account = 'one', clock = Date.parse(hour);
  const run = (slot, provider = 'cursor') => withAccountLimitsCache({ home, provider, identity: () => account, now: () => clock, fetchLimits: async () => slot });
  const live = { configured: true, primary_window: { remaining_percent: 80, reset_at: new Date(clock + 60000).toISOString() } };
  await run(live);
  const cache = path.join(home, '.agentrouter/collector/tracker/agentrouter-cursor-limits-cache.json');
  assert.equal(JSON.parse(await fs.readFile(cache, 'utf8')).cursor.identity, 'one');
  assert.equal((await fs.stat(cache)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(home, '.tokentracker')), { code: 'ENOENT' });
  const failed = { configured: true, error: 'network timeout' };
  assert.equal((await run(failed)).primary_window.remaining_percent, 80);
  assert.equal((await run(failed, 'grokbot')).error, failed.error);
  assert.equal((await run(failed, 'cursor-all')).error, failed.error, 'a product-only snapshot cannot satisfy a full refresh');
  await run({ ...live, primary_window: { ...live.primary_window, remaining_percent: 60 },
    quaternary_window: { ...live.primary_window, remaining_percent: 40 } }, 'cursor-all');
  assert.equal((await run(failed)).primary_window.remaining_percent, 80, 'full refresh cannot overwrite the product-only cache');
  assert.equal((await run(failed, 'cursor-all')).quaternary_window.remaining_percent, 40);
  assert.equal((await run({ configured: true, error: '401 Unauthorized' })).error, '401 Unauthorized');
  account = 'two'; assert.equal((await run(failed)).error, failed.error);
  account = 'one'; clock += 60001; assert.equal((await run(failed)).error, failed.error);
});

test('overlapping quota polls cannot replace a newer cache or persist another account', async t => {
  const home = await temp(t); let account = 'one', release;
  const slot = n => ({ configured: true, primary_window: { remaining_percent: n, reset_at: '2099-01-01T00:00:00Z' } });
  const run = fetchLimits => withAccountLimitsCache({ home, provider: 'grok', identity: () => account, fetchLimits });
  const old = run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await run(async () => slot(50)); release(slot(80)); await old;
  assert.equal((await run(async () => ({ configured: true, error: 'timeout' }))).primary_window.remaining_percent, 50);
  await run(async () => { account = 'two'; return slot(5); });
  assert.equal((await run(async () => ({ configured: true, error: 'timeout' }))).error, 'timeout');
});

test('session refresh reuses unchanged files and rebuilds a damaged sidecar', async t => {
  const home = await temp(t), dir = path.join(home, '.codex/sessions/2026/11/10');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-fixture.jsonl');
  await fs.writeFile(file, [
    { timestamp: hour, type: 'session_meta', payload: { id: 'fixture', cwd: '/fixture' } },
    { timestamp: hour, type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { timestamp: hour, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const first = await buildSessionAnalytics({ home, force: true });
  assert.ok(first.some(r => r.source === 'codex' && r.total_tokens === 110));
  const sidecar = resolveSessionSidecarPath(home), original = await fs.stat(sidecar);
  assert.deepEqual(await buildSessionAnalytics({ home, recheck: true }), first);
  assert.equal((await fs.stat(sidecar)).mtimeMs, original.mtimeMs, 'unchanged transcript should reuse its cached rows');
  await fs.writeFile(sidecar, 'damaged-json\n');
  const rebuilt = await buildSessionAnalytics({ home, recheck: true });
  assert.ok(rebuilt.some(r => r.source === 'codex' && r.total_tokens === 110));
});
