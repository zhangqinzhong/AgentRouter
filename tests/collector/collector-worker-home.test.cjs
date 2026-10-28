const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { buildSync } = require('esbuild');

test('collector worker uses the configured runtime home instead of the process account home', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-worker-home-'));
  const home = path.join(root, 'configured-home'), decoy = path.join(root, 'account-home');
  const project = path.join(home, '.claude/projects/fixture');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(project, 'one.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-27T10:00:00Z', requestId: 'fixture', message: { id: 'fixture', model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
  const workerPath = path.join(root, 'worker.cjs');
  buildSync({ entryPoints: ['packages/core/src/collector/local-collector-worker.ts'], outfile: workerPath, bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node22' });
  fs.symlinkSync(path.resolve('packages/core/src/vendor/tokentracker'), path.join(root, 'tokentracker'), 'junction');
  const worker = new Worker(workerPath, { env: { ...process.env, HOME: decoy, USERPROFILE: decoy, APPDATA: path.join(decoy, 'appData'), AR_INTERNAL_HOME_DIR: home, AR_INTERNAL_APP_DATA_DIR: path.join(home, 'appData'), CODEX_HOME: path.join(decoy, '.codex'), CLAUDE_CONFIG_DIR: path.join(decoy, '.claude') } });
  let id = 0;
  const request = (endpoint, query = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const listener = message => { if (message.id !== current) return; worker.off('message', listener); message.error ? reject(new Error(message.error)) : resolve(message.data); };
    worker.on('message', listener); worker.once('error', reject); worker.postMessage({ id: current, path: endpoint, query });
  });
  worker.on('message', message => { if (message.fetchId) worker.postMessage({ fetchId: message.fetchId, error: 'offline fixture' }); });
  try {
    await request('/functions/tokentracker-local-sync');
    const result = await request('/functions/tokentracker-usage-summary', { from: '2026-10-27', to: '2026-10-27', tz: 'UTC', background: '1' });
    assert.equal(result.totals.total_tokens, 120);
    assert.ok(fs.existsSync(path.join(home, '.agentrouter/collector/queue.jsonl')));
    assert.ok(!fs.existsSync(path.join(decoy, '.agentrouter/collector/queue.jsonl')));
  } finally { await worker.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
});
