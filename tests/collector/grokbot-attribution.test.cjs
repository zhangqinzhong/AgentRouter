const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryOffline } = require('../../packages/core/src/vendor/tokentracker/lib/offline-api');

test('Cursor exports classify only Grok Bot before aggregation and filtering, preserving snapshots and totals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-grokbot-'));
  const queue = path.join(dir, 'queue.jsonl');
  const row = (source, model, tokens) => ({source, model, hour_start: '2026-10-06T01:00:00Z', input_tokens: tokens, total_tokens: tokens, billable_total_tokens: tokens});
  const rows = [row('cursor','grok-bot-default',10), row('cursor','grok-bot-default',20), row('cursor','grok-bot-automation',30), row('cursor','cursor-grok-4.6-medium',40), row('grok','grok-code',50)];
  const raw = rows.map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(queue, raw);
  const query = {from:'2026-10-06',to:'2026-10-06',tz:'UTC'};
  const models = (extra={}) => queryOffline(queue,'/functions/tokentracker-usage-model-breakdown',{...query,...extra});
  try {
    const result = await models();
    assert.deepEqual(Object.fromEntries(result.sources.map(s=>[s.source,s.totals.total_tokens])),{grokbot:50,cursor:40,grok:50});
    assert.equal(result.sources.find(s=>s.source==='grokbot').source_scope,'account');
    assert.equal((await models({source:'grokbot'})).sources[0].totals.total_tokens,50);
    assert.equal((await models({source:'cursor'})).sources[0].totals.total_tokens,40);
    assert.deepEqual((await models({scope:'personal'})).sources.map(s=>s.source),['grok']);
    fs.appendFileSync(queue, JSON.stringify(row('cursor','grok-bot-default',25))+'\n');
    assert.equal((await models({source:'grokbot'})).sources[0].totals.total_tokens,55);
    assert.equal(fs.readFileSync(queue,'utf8'),raw+JSON.stringify(row('cursor','grok-bot-default',25))+'\n');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
