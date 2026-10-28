const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readSqliteJsonRowsAsync } = require('./lib/sqlite-reader');

function canonical(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}
function unique(values) { const found = new Map(); for (const value of values) if (!found.has(canonical(value))) found.set(canonical(value), value); return [...found.values()]; }
function expand(value, home) {
  return value === '~' ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : path.resolve(home, value);
}
function claudeProjects(root) { return fs.existsSync(path.join(root, 'projects')) ? path.join(root, 'projects') : root; }
function codexStores(root) {
  if (['sessions', 'archived_sessions'].includes(path.basename(root))) return [root];
  let direct = false;
  try { direct = fs.readdirSync(root).some(name => /^\d{4}$/.test(name) || /^rollout-.*\.jsonl(?:\.zstd?)?$/.test(name)); } catch {}
  return direct ? [root] : [path.join(root, 'sessions'), path.join(root, 'archived_sessions')];
}

// The session index owns location preferences. Usage collection reads the same
// records, rather than maintaining a second configuration that can drift.
async function collectionRoots({ home = os.homedir(), indexPath = path.join(home, '.agentrouter/sessions/index.sqlite'), env = process.env } = {}) {
  const defaultClaude = [path.join(home, '.claude/projects')];
  const defaultCodex = codexStores(path.join(home, '.codex'));
  const customClaude = [], customCodex = [];
  if (path.resolve(home) === path.resolve(os.homedir())) {
    if (env.CLAUDE_CONFIG_DIR?.trim()) defaultClaude.push(path.join(expand(env.CLAUDE_CONFIG_DIR, home), 'projects'));
    if (env.CODEX_HOME?.trim()) defaultCodex.push(...codexStores(expand(env.CODEX_HOME, home)));
  }
  const profiles = path.join(home, '.agentrouter/profiles');
  for (const entry of await fsp.readdir(profiles, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!entry.isDirectory()) continue;
    for (const prefix of ['', 'custom']) {
      customClaude.push(path.join(profiles, entry.name, prefix, 'claude/projects'));
      customCodex.push(...codexStores(path.join(profiles, entry.name, prefix, 'codex')));
    }
  }
  // Preserve the existing tracker configuration for command-line users.
  const legacyConfig = path.join(home, '.agentrouter/collector/tracker/config.json');
  try {
    const configured = JSON.parse(await fsp.readFile(legacyConfig, 'utf8')).scanRoots || {};
    for (const root of Array.isArray(configured.claude) ? configured.claude : []) if (typeof root === 'string' && root.trim()) customClaude.push(path.join(expand(root, home), 'projects'));
    for (const root of Array.isArray(configured.codex) ? configured.codex : []) if (typeof root === 'string' && root.trim()) customCodex.push(...codexStores(expand(root, home)));
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let disabled = [], removed = [], removedRoots = [];
  if (fs.existsSync(indexPath)) {
    const options = { label: 'AgentRouter collection locations', readOnly: true, throwOnReadFailure: true };
    const query = sql => readSqliteJsonRowsAsync(indexPath, sql, options);
    const tables = new Set((await query("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
    if (tables.has('custom_roots')) for (const row of await query('SELECT agent, path FROM custom_roots ORDER BY added_at, path')) {
      if (row.agent === 'claude-code') customClaude.push(claudeProjects(row.path));
      if (row.agent === 'codex') customCodex.push(...codexStores(row.path));
    }
    if (tables.has('disabled_locations')) disabled = await query('SELECT agent, path FROM disabled_locations');
    if (tables.has('removed_default_roots')) removedRoots = await query('SELECT agent, path FROM removed_default_roots');
    if (tables.has('removed_defaults')) removed = (await query('SELECT agent FROM removed_defaults')).map(row => row.agent);
  }
  const blocked = (rows, agent, root) => rows.some(row => row.agent === agent && canonical(row.path) === canonical(root));
  const active = (agent, defaults, customs) => unique([
    ...defaults.filter(root => !removed.includes(agent) && !blocked(removedRoots, agent, root)), ...customs,
  ]).filter(root => !blocked(disabled, agent, root));
  return { claudeProjects: active('claude-code', defaultClaude, customClaude), codexStores: active('codex', defaultCodex, customCodex),
    allowsDefault: (agent, root) => !removed.includes(agent) && !blocked(removedRoots, agent, root) && !blocked(disabled, agent, root) };
}

module.exports = { collectionRoots };
