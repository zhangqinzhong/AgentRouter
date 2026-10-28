const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { collectionRoots } = require('../../packages/core/src/vendor/tokentracker/collection-roots.cjs');
const { createCollector } = require('../../packages/core/src/vendor/tokentracker/collector.cjs');
const { discoverSessionFiles, buildSessionAnalytics } = require('../../packages/core/src/vendor/tokentracker/lib/session-analytics');

test('isolated Claude home is shared by usage collection and session analytics, without symlink duplicates', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-collection-roots-'));
  const root = path.join(home, 'Library/Application Support/Fixture/code');
  const project = path.join(root, 'projects/work');
  const index = path.join(home, '.agentrouter/sessions/index.sqlite');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.dirname(index), { recursive: true });
  const db = new DatabaseSync(index);
  db.exec('CREATE TABLE custom_roots(agent TEXT,path TEXT,added_at INTEGER); CREATE TABLE disabled_locations(agent TEXT,path TEXT);');
  try {
    const alias = path.join(home, 'alias'); fs.symlinkSync(root, alias, 'dir');
    db.prepare('INSERT INTO custom_roots VALUES (?,?,0)').run('claude-code', root);
    db.prepare('INSERT INTO custom_roots VALUES (?,?,1)').run('claude-code', alias);
    fs.writeFileSync(path.join(project, 'one.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-27T10:00:00Z', requestId: 'one', message: { id: 'one', model: 'claude-sonnet-4', usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
    const roots = await collectionRoots({ home });
    assert.equal(roots.claudeProjects.filter(p => fs.existsSync(p)).length, 1);
    const collector = createCollector({ home, fetchImpl: async () => { throw new Error('offline fixture'); } });
    await collector.sync(true);
    const total = await collector.query('/functions/tokentracker-usage-summary', { from: '2026-10-27', to: '2026-10-27', tz: 'UTC' });
    assert.equal(total.totals.total_tokens, 120);
    assert.equal((await buildSessionAnalytics({ home, force: true })).find(r => r.source === 'claude').total_tokens, 120);
    db.prepare('INSERT INTO disabled_locations VALUES (?,?)').run('claude-code', path.join(root, 'projects'));
    assert.equal((await discoverSessionFiles(home)).claude.flat().length, 0, 'disabled location is absent from analytics too');
    await collector.sync(true);
    assert.equal((await collector.query('/functions/tokentracker-usage-summary', { from: '2026-10-27', to: '2026-10-27', tz: 'UTC' })).totals.total_tokens, 120, 'disabling keeps collected history');
    assert.ok(fs.existsSync(path.join(project, 'one.jsonl')));
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('custom Codex stores and legacy scanRoots use the same discovery contract', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-codex-roots-'));
  const root = path.join(home, 'private-codex'), archive = path.join(root, 'archived_sessions');
  const index = path.join(home, '.agentrouter/sessions/index.sqlite');
  fs.mkdirSync(archive, { recursive: true }); fs.mkdirSync(path.dirname(index), { recursive: true });
  const db = new DatabaseSync(index); db.exec('CREATE TABLE custom_roots(agent TEXT,path TEXT,added_at INTEGER)');
  try {
    db.prepare('INSERT INTO custom_roots VALUES (?,?,0)').run('codex', archive);
    const config = path.join(home, '.agentrouter/collector/tracker/config.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ scanRoots: { codex: [root] } }));
    const roots = await collectionRoots({ home });
    assert.equal(roots.codexStores.filter(p => p === archive).length, 1);
    assert.ok(roots.codexStores.includes(path.join(root, 'sessions')));
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
