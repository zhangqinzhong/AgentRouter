const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryOffline } = require('../../packages/core/src/vendor/tokentracker/lib/offline-api');
const { computeRowCost } = require('../../packages/core/src/vendor/tokentracker/lib/pricing');

function bucket(source, model, hour, extra = {}) {
  return {
    source, model, hour_start: hour,
    input_tokens: 1_000_000, output_tokens: 100_000,
    cached_input_tokens: 200_000, cache_creation_input_tokens: 30_000,
    total_tokens: 1_330_000, billable_total_tokens: 1_330_000,
    conversation_count: 3, ...extra,
  };
}

async function withQueue(rows, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-overview-statistics-'));
  const queue = path.join(dir, 'queue.jsonl');
  fs.writeFileSync(queue, rows.map(JSON.stringify).join('\n') + '\n');
  try { await run(queue); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
function close(actual, expected, tolerance = 0.00001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

async function assertViewsAgree(queue, query) {
  const summary = await queryOffline(queue, '/functions/tokentracker-usage-summary', query);
  const models = await queryOffline(queue, '/functions/tokentracker-usage-model-breakdown', query);
  const daily = await queryOffline(queue, '/functions/tokentracker-usage-daily', query);
  const modelTotals = models.sources.flatMap(source => source.models.map(model => model.totals));
  const sourceTotals = models.sources.map(source => source.totals);
  for (const field of ['total_tokens', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_creation_input_tokens', 'conversation_count']) {
    for (const rows of [modelTotals, sourceTotals, daily.data]) {
      assert.equal(sum(rows, field), Number(summary.totals[field]), field);
    }
  }
  for (const rows of [modelTotals, sourceTotals, daily.data]) {
    close(sum(rows, 'total_cost_usd'), Number(summary.totals.total_cost_usd));
  }
  const hourly = [];
  for (const day of daily.data) {
    const data = await queryOffline(queue, '/functions/tokentracker-usage-hourly', { ...query, day: day.day });
    hourly.push(...data.data);
  }
  assert.equal(sum(hourly, 'total_tokens'), Number(summary.totals.total_tokens));
  assert.equal(sum(hourly, 'conversation_count'), Number(summary.totals.conversation_count));
  close(sum(hourly, 'total_cost_usd'), Number(summary.totals.total_cost_usd));
  return summary;
}

test('model cost preserves each DeepSeek bucket time-of-use price', async () => {
  const rows = [
    bucket('claude', 'deepseek-v4-pro', '2026-10-20T02:00:00Z'),
    bucket('claude', 'deepseek-v4-pro', '2026-10-20T12:00:00Z'),
  ];
  assert.ok(computeRowCost(rows[0]) > computeRowCost(rows[1]));
  await withQueue(rows, async queue => {
    const result = await assertViewsAgree(queue, { from: '2026-10-20', to: '2026-10-20', tz: 'UTC' });
    close(Number(result.totals.total_cost_usd), rows.reduce((total, row) => total + computeRowCost(row), 0));
  });
});

test('model cost preserves long-context premiums instead of repricing summed ordinary tokens', async () => {
  const rows = [bucket('codex', 'gpt-6-astra', '2026-10-20T12:00:00Z', {
    long_context_input_tokens: 700_000,
    long_context_cached_input_tokens: 150_000,
    long_context_cache_creation_input_tokens: 20_000,
    long_context_output_tokens: 80_000,
  })];
  assert.ok(computeRowCost(rows[0]) > computeRowCost({ ...rows[0], long_context_input_tokens: 0, long_context_cached_input_tokens: 0, long_context_cache_creation_input_tokens: 0, long_context_output_tokens: 0 }));
  await withQueue(rows, queue => assertViewsAgree(queue, { from: '2026-10-20', to: '2026-10-20', tz: 'UTC' }));
});

test('mixed reported and estimated costs both contribute to the model and client totals', async () => {
  const rows = [
    bucket('grok', 'grok-code-fast-1', '2026-10-20T12:00:00Z', { total_cost_usd: 2.25 }),
    bucket('grok', 'grok-code-fast-1', '2026-10-20T13:00:00Z'),
  ];
  assert.ok(computeRowCost(rows[1]) > 0);
  await withQueue(rows, queue => assertViewsAgree(queue, { from: '2026-10-20', to: '2026-10-20', tz: 'UTC' }));
});

test('overview aggregations agree after snapshot deduplication, rolling boundaries, time zones and model filters', async () => {
  const rows = [
    bucket('codex', 'gpt-6-astra', '2026-10-18T12:00:00Z'),
    bucket('claude', 'deepseek-v4-pro', '2026-10-19T12:00:00Z', { total_tokens: 20 }),
    bucket('claude', 'deepseek-v4-pro', '2026-10-19T12:00:00Z'),
    bucket('claude', 'deepseek-v4-pro', '2026-10-20T02:00:00Z'),
    bucket('codex', 'gpt-6-astra', '2026-10-20T18:00:00Z'),
  ];
  await withQueue(rows, async queue => {
    for (const query of [
      { from: '', to: '2026-10-22', tz: 'UTC' },
      { from: '2026-10-19', to: '2026-10-20', since: '2026-10-19T12:45:00Z', tz: 'UTC' },
      { from: '2026-10-20', to: '2026-10-21', tz: 'Asia/Shanghai' },
      { from: '', to: '2026-10-22', tz: 'UTC', model: 'deepseek-v4-pro' },
      { from: '', to: '2026-10-22', tz: 'UTC', source: 'codex' },
    ]) await assertViewsAgree(queue, query);
  });
});
