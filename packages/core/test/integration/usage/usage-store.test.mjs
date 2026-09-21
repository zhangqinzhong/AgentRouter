import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RequestLogStore } from "@agentrouter/core/observability/request-log-store.ts";
import { createBetterSqliteDatabase } from "@agentrouter/core/storage/sqlite-native.ts";
import { GatewayBillingSynchronizer } from "@agentrouter/core/usage/billing-sync.ts";
import { resolveUsageModelAttribution } from "@agentrouter/core/usage/model-attribution.ts";
import { mergeLocalOverviewSnapshot, UsageStore } from "@agentrouter/core/usage/store.ts";

const fusionUsageConfig = {
  Providers: [
    {
      baseUrl: "https://api.moonshot.cn/anthropic",
      models: ["kimi-for-coding", "kimi-vision"],
      name: "Kimi Code - Coding Plan",
      type: "anthropic_messages"
    },
    {
      baseUrl: "https://api.example.com/v1",
      models: ["openai-vision"],
      name: "OpenAI Compatible",
      type: "openai_chat_completions"
    }
  ],
  virtualModelProfiles: [
    {
      baseModel: { fixedModel: "Kimi Code - Coding Plan/kimi-for-coding", mode: "fixed" },
      enabled: true,
      id: "kimisearch",
      key: "kimisearch",
      match: { exactAliases: ["kimisearch"], prefixes: [], suffixes: [] }
    }
  ]
};

test("Fusion usage attribution resolves fixed aliases to their upstream model", () => {
  assert.deepEqual(resolveUsageModelAttribution(fusionUsageConfig, "Fusion/kimisearch"), {
    logicalModel: "Fusion/kimisearch",
    model: "kimi-for-coding",
    provider: "Kimi Code - Coding Plan"
  });
});

test("Fusion usage attribution mirrors gateway virtual-model precedence and target rewriting", () => {
  const config = {
    Providers: [
      { models: ["base", "web-base-tail", "web-special-base"], name: "Requested", type: "openai_chat_completions" },
      { models: ["long-prefix", "short-prefix", "suffix"], name: "Targets", type: "openai_chat_completions" }
    ],
    virtualModelProfiles: [
      {
        baseModel: { fixedModel: "Targets/short-prefix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["web-"], suffixes: [] }
      },
      {
        baseModel: { fixedModel: "Targets/long-prefix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["web-special-"], suffixes: [] }
      },
      {
        baseModel: { fixedModel: "Targets/suffix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: [], suffixes: ["-tail"] }
      },
      {
        baseModel: { mode: "request" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["raw-"], suffixes: [] }
      }
    ]
  };

  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/web-special-base"), {
    logicalModel: "Requested/web-special-base",
    model: "long-prefix",
    provider: "Targets"
  });
  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/web-base-tail"), {
    logicalModel: "Requested/web-base-tail",
    model: "suffix",
    provider: "Targets"
  });
  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/raw-base"), {
    logicalModel: "Requested/raw-base",
    model: "base",
    provider: "Requested"
  });
});

test("usage attribution preserves slash-containing physical model IDs", () => {
  const model = "accounts/fireworks/models/llama-v3p2-11b-vision-instruct";
  assert.deepEqual(resolveUsageModelAttribution(fusionUsageConfig, model, { physicalModel: true }), {
    logicalModel: model,
    model
  });
});

test("overview merges local MiMo and ZCode usage without inventing gateway requests", () => {
  const snapshot = {
    clientModels: [],
    generatedAt: new Date().toISOString(),
    models: [{
      avgDurationMs: 40,
      caption: "Gateway",
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: 1,
      errorCount: 0,
      inputTokens: 10,
      key: "gateway::model",
      label: "gateway-model",
      maxShare: 0,
      outputTokens: 5,
      provider: "Gateway",
      requestCount: 1,
      successRate: 1,
      totalTokens: 15
    }],
    providerModels: [],
    range: "7d",
    recentRequests: [],
    series: [{
      avgDurationMs: 40,
      bucket: "2026-09-19",
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: 1,
      errorCount: 0,
      inputTokens: 10,
      label: "09/19",
      outputTokens: 5,
      requestCount: 1,
      successRate: 1,
      totalTokens: 15
    }],
    totals: {
      avgDurationMs: 40,
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: 1,
      errorCount: 0,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      successRate: 1,
      totalTokens: 15
    }
  };
  const merged = mergeLocalOverviewSnapshot(snapshot, {
    series: [{
      day: "2026-09-19",
      input_tokens: 140,
      output_tokens: 30,
      total_tokens: 170
    }],
    sources: [{
      source: "mimo",
      models: [{
        model: "mimo-x-pro-preview",
        totals: {
          conversation_count: 2,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          total_cost_usd: "2.5"
        }
      }]
    }, {
      source: "zcode",
      models: [{
        model: "GLM-5.3",
        totals: {
          conversation_count: 1,
          input_tokens: 40,
          output_tokens: 10,
          total_tokens: 50,
          total_cost_usd: "0.5"
        }
      }]
    }],
    totals: {
      input_tokens: 140,
      output_tokens: 30,
      total_tokens: 170,
      total_cost_usd: "3"
    }
  }, {});

  assert.equal(merged.totals.totalTokens, 185);
  assert.equal(merged.totals.costUsd, 4);
  assert.equal(merged.totals.requestCount, 4);
  assert.equal(merged.totals.errorCount, 0);
  assert.deepEqual(
    merged.models.filter((row) => row.provider === "MiMo" || row.provider === "ZCode").map((row) => row.model),
    ["mimo-x-pro-preview", "GLM-5.3"]
  );
  assert.deepEqual(
    merged.providerModels.filter((row) => row.provider === "MiMo" || row.provider === "ZCode").map((row) => row.label),
    ["MiMo", "ZCode"]
  );
  assert.deepEqual(
    merged.clientModels.filter((row) => row.provider === "MiMo" || row.provider === "ZCode").map((row) => [row.client, row.requestCount]),
    [["MiMo", 2], ["ZCode", 1]]
  );
  assert.equal(merged.series[0].totalTokens, 185);
});

test("UsageStore all range covers history older than 30 days with an all-time series", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-test-"));
  const dayKey = (value) => {
    const pad = (part) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  };
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

    await store.record({
      createdAt: old.toISOString(),
      durationMs: 100,
      method: "POST",
      model: "old-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-old",
      statusCode: 200,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
    await store.record({
      createdAt: now.toISOString(),
      durationMs: 100,
      method: "POST",
      model: "new-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-new",
      statusCode: 200,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    });

    const monthStats = await store.getStats("30d", {});
    assert.equal(monthStats.totals.requestCount, 1);

    const allStats = await store.getStats("all", {});
    assert.equal(allStats.range, "all");
    assert.equal(allStats.totals.requestCount, 2);
    assert.equal(allStats.totals.totalTokens, 20);
    assert.equal(allStats.series.length, 101);
    assert.equal(allStats.series[0].bucket, dayKey(old));
    assert.equal(allStats.series[0].totalTokens, 15);
    assert.equal(allStats.series.at(-1).bucket, dayKey(now));
    assert.equal(allStats.series.at(-1).totalTokens, 5);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore caps all-time daily buckets relative to today while retaining historical totals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-all-time-cap-"));
  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const old = new Date(now);
    old.setFullYear(old.getFullYear() - 5);
    for (const [createdAt, tokens] of [[old, 100], [now, 10]]) {
      await store.record({
        createdAt: createdAt.toISOString(),
        durationMs: 10,
        method: "POST",
        model: "history-model",
        path: "/v1/messages",
        provider: "alpha",
        statusCode: 200,
        costUsd: 0,
        usage: { inputTokens: tokens, totalTokens: tokens }
      });
    }
    const stats = await store.getStats("all", {});
    const firstDay = new Date(now);
    firstDay.setDate(firstDay.getDate() - 729);
    assert.equal(stats.series.length, 730);
    assert.equal(stats.series[0].bucket, dayKey(firstDay));
    assert.equal(stats.series.at(-1).bucket, dayKey(now));
    assert.equal(stats.totals.totalTokens, 110);
    assert.equal(stats.totals.requestCount, 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("overview merge keeps local series days that predate the gateway template", () => {
  const snapshot = {
    clientModels: [],
    generatedAt: new Date().toISOString(),
    models: [],
    providerModels: [],
    range: "all",
    recentRequests: [],
    series: [{
      bucket: "2026-09-19",
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: 1,
      errorCount: 0,
      inputTokens: 10,
      label: "09/19",
      outputTokens: 5,
      requestCount: 1,
      successRate: 1,
      totalTokens: 15
    }],
    totals: {
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: 1,
      errorCount: 0,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      successRate: 1,
      totalTokens: 15
    }
  };
  const merged = mergeLocalOverviewSnapshot(snapshot, {
    series: [
      { day: "2026-09-19", input_tokens: 5, total_tokens: 6 },
      { day: "2026-04-01", input_tokens: 10, total_tokens: 12 }
    ],
    sources: [{
      source: "lmstudio",
      models: [{
        model: "local-model",
        totals: { input_tokens: 15, total_tokens: 18, conversation_count: 2 }
      }]
    }],
    totals: { input_tokens: 15, total_tokens: 18, conversation_count: 2 }
  }, {});

  assert.deepEqual(merged.series.map((point) => point.bucket), ["2026-04-01", "2026-09-19"]);
  assert.equal(merged.series[0].totalTokens, 12);
  assert.equal(merged.series[1].totalTokens, 21);
});

test("UsageStore aggregates stats in SQLite without loading all events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    await store.record({
      createdAt: earlier.toISOString(),
      durationMs: 120,
      method: "POST",
      model: "alpha-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-1",
      statusCode: 200,
      usage: {
        cacheReadTokens: 2,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 17
      }
    });
    await store.record({
      createdAt: now.toISOString(),
      durationMs: 80,
      method: "POST",
      model: "beta-model",
      path: "/v1/messages",
      provider: "beta",
      requestId: "req-2",
      statusCode: 500,
      usage: {
        inputTokens: 4,
        outputTokens: 6
      }
    });

    const stats = await store.getStats("30d", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 2);
    assert.equal(stats.totals.errorCount, 1);
    assert.equal(stats.totals.totalTokens, 27);
    assert.equal(stats.totals.inputTokens, 14);
    assert.equal(stats.totals.outputTokens, 11);
    assert.equal(stats.recentRequests.length, 2);
    assert.equal(stats.models[0]?.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore cache ratio denominator includes cache tokens when total tokens omit cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-cache-ratio-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));

    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 50,
      method: "POST",
      model: "glm-cache",
      path: "/v1/messages",
      provider: "zhipu",
      requestId: "cache-ratio-total-omits-cache",
      statusCode: 200,
      usage: {
        cacheReadTokens: 90,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    });

    const stats = await store.getStats("30d");
    assert.equal(stats.totals.totalTokens, 105);
    assert.equal(stats.totals.cacheRatio, 0.9);
    assert.equal(stats.models[0]?.cacheRatio, 0.9);
    assert.equal(stats.recentRequests[0]?.totalTokens, 105);
    assert.equal(stats.recentRequests[0]?.cacheRatio, 0.9);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore excludes proxy rows by default and includes them on request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-proxy-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const createdAt = new Date().toISOString();

    await store.record({
      createdAt,
      durationMs: 10,
      method: "POST",
      model: "direct/model-a",
      path: "/v1/messages",
      requestId: "direct-1",
      statusCode: 200,
      usage: {
        inputTokens: 5,
        outputTokens: 7
      }
    });
    await store.record({
      createdAt,
      durationMs: 10,
      method: "POST",
      model: "proxy-model",
      path: "/v1/messages",
      provider: "proxy",
      requestId: "proxy-1",
      statusCode: 200,
      usage: {
        inputTokens: 100,
        outputTokens: 200
      }
    });

    const defaultStats = await store.getStats("30d");
    assert.equal(defaultStats.totals.requestCount, 1);
    assert.equal(defaultStats.totals.totalTokens, 12);
    assert.equal(defaultStats.providerModels[0]?.provider, "direct");
    assert.equal(defaultStats.providerModels[0]?.model, "model-a");

    const withProxy = await store.getStats("30d", { includeProxy: true });
    assert.equal(withProxy.totals.requestCount, 2);
    assert.equal(withProxy.totals.totalTokens, 312);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore treats null web RPC usage filters as empty filters", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-null-filter-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));

    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 10,
      method: "POST",
      model: "alpha-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-null-filter",
      statusCode: 200,
      usage: {
        inputTokens: 3,
        outputTokens: 4
      }
    });

    const stats = await store.getStats("7d", null);
    assert.equal(stats.range, "7d");
    assert.equal(stats.totals.requestCount, 1);

    const defaultRangeStats = await store.getStats(null, null);
    assert.equal(defaultRangeStats.range, "7d");
    assert.equal(defaultRangeStats.totals.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore keeps the Fusion logical model while grouping by the upstream model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-fusion-attribution-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 25,
      logicalModel: "Fusion/kimisearch",
      method: "POST",
      model: "kimi-for-coding",
      path: "/v1/messages",
      provider: "Kimi Code - Coding Plan",
      requestId: "fusion-request-1",
      statusCode: 200,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
    });

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, "kimi-for-coding");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.logicalModel, "Fusion/kimisearch");
    assert.equal(stats.totals.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore attributes Claude App encoded response model IDs to the routed upstream model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-claude-app-encoded-model-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const encodedModel = `anthropic/claude-ar-h${Buffer.from("Fusion/kimisearch", "utf8").toString("hex")}`;

    await store.recordCapture({
      bodyText: [
        "event: message_start",
        `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${encodedModel}","usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}}`,
        "",
        "data: [DONE]",
        ""
      ].join("\n"),
      client: "Claude Code",
      config: fusionUsageConfig,
      durationMs: 100,
      fallbackModel: "Fusion/kimisearch",
      method: "POST",
      path: "/v1/messages",
      providerProtocol: "anthropic_messages",
      requestId: "encoded-claude-app-model",
      responseHeaders: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
      statusCode: 200
    });

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, "kimi-for-coding");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.logicalModel, "Fusion/kimisearch");
    assert.notEqual(stats.models[0]?.model, encodedModel);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight usage synchronization records and deduplicates Fusion internal upstream calls", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-fusion-internal-test-"));
  try {
    let estimateCallCount = 0;
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async () => {
        estimateCallCount += 1;
        return { amountUsd: 99, model: "unexpected", source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
    const event = {
      billing: {
        cost: { total: 0.001 },
        usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-vision-event-1",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 150 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        credentialId: "test-1",
        model: "kimi-vision",
        providerName: "Kimi Code - Coding Plan"
      }
    };

    assert.equal(await synchronizer.ingest(event), true);
    assert.equal(await store.hasRequestId(event.eventId), true);
    assert.equal(await synchronizer.ingest(event), true);
    assert.equal(await synchronizer.ingest({
      ...event,
      eventId: "top-level-embedding-event",
      source: { adapterKey: "openai_embeddings", provider: "openai" }
    }), false);
    assert.equal(await synchronizer.ingest({ ...event, eventId: "legacy-full-billing-event", schema: undefined }), false);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 1);
    assert.equal(stats.totals.totalTokens, 55);
    assert.equal(stats.totals.costUsd, 0.001);
    assert.equal(stats.models[0]?.model, "kimi-vision");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.credentialId, "test-1");
    assert.equal(estimateCallCount, 0);

    const database = createBetterSqliteDatabase(path.join(dir, "usage.sqlite"));
    try {
      const queryPlan = database
        .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM usage_events WHERE request_id = ? LIMIT 1")
        .all(event.eventId)
        .map((row) => String(row.detail ?? ""))
        .join("\n");
      assert.match(queryPlan, /usage_events_request_id_idx/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage normalizes OpenAI cache tokens and estimates unconfigured zero costs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-fusion-zero-cost-test-"));
  try {
    const estimatedInputs = [];
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async (input) => {
        estimatedInputs.push(input);
        return { amountUsd: 0.0025, model: input.model, source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: { total: 0 },
        usage: {
          cache_read_tokens: 10,
          input_tokens: 50,
          output_tokens: 5,
          total_tokens: 55
        }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-vision-zero-cost-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        model: "openai-vision",
        providerName: "OpenAI Compatible::openai_chat_completions"
      }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.inputTokens, 40);
    assert.equal(stats.totals.cacheTokens, 10);
    assert.equal(stats.totals.totalTokens, 55);
    assert.equal(stats.totals.costUsd, 0.0025);
    assert.equal(stats.models[0]?.provider, "OpenAI Compatible");
    assert.deepEqual(estimatedInputs, [{
      cacheReadTokens: 10,
      cacheWrite1hTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 40,
      model: "openai-vision",
      outputTokens: 5,
      pricing: undefined,
      provider: "OpenAI Compatible"
    }]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage preserves slash-containing external model IDs through storage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-fusion-external-model-test-"));
  try {
    const estimatedInputs = [];
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async (input) => {
        estimatedInputs.push(input);
        return { amountUsd: 0.004, model: input.model, source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
    const model = "accounts/fireworks/models/llama-v3p2-11b-vision-instruct";

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: {},
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-external-slash-model-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: { model }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, model);
    assert.equal(stats.models[0]?.provider, "unknown");
    assert.equal(stats.recentRequests[0]?.logicalModel, model);
    assert.deepEqual(estimatedInputs, [{
      cacheReadTokens: 0,
      cacheWrite1hTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 10,
      model,
      outputTokens: 3,
      pricing: undefined,
      provider: "unknown"
    }]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage honors numeric-string zero costs from global core billing rates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-fusion-global-rate-test-"));
  try {
    let estimateCallCount = 0;
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async () => {
        estimateCallCount += 1;
        return { amountUsd: 99, model: "unexpected", source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({
      getConfig: () => fusionUsageConfig,
      getGlobalBillingConfig: () => ({
        rates: {
          openai: {
            cacheReadPerMillionUsd: "0",
            cacheWritePerMillionUsd: "0",
            inputPerMillionUsd: "0",
            outputPerMillionUsd: "0"
          }
        }
      }),
      store
    });

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: { total: 0 },
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-global-zero-rate-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        model: "openai-vision",
        providerName: "OpenAI Compatible::openai_chat_completions"
      }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.costUsd, 0);
    assert.equal(estimateCallCount, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage coalesces concurrent deliveries of the same event", async () => {
  let hasRequestIdCallCount = 0;
  let recordCallCount = 0;
  let releaseRecord;
  let markRecordStarted;
  const recordStarted = new Promise((resolve) => {
    markRecordStarted = resolve;
  });
  const recordReleased = new Promise((resolve) => {
    releaseRecord = resolve;
  });
  const store = {
    hasRequestId: async () => {
      hasRequestIdCallCount += 1;
      return false;
    },
    record: async () => {
      recordCallCount += 1;
      markRecordStarted();
      await recordReleased;
    }
  };
  const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
  const event = {
    billing: {
      cost: { total: 0.001 },
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
    },
    emittedAt: new Date().toISOString(),
    eventId: "fusion-concurrent-event",
    outcome: { status: "success", statusCode: 200 },
    performance: { latency_ms: 100 },
    route: { method: "POST", url: "/v1/chat/completions" },
    schema: "ccr.fusion-usage.v1",
    source: { adapterKey: "openai_chat", provider: "fusion_vision" },
    target: { model: "openai-vision", providerName: "OpenAI Compatible" }
  };

  const first = synchronizer.ingest(event);
  await recordStarted;
  const second = synchronizer.ingest(event);
  releaseRecord();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(hasRequestIdCallCount, 1);
  assert.equal(recordCallCount, 1);
});

test("UsageStore backfills missing events from request logs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-request-log-backfill-test-"));
  try {
    const requestLogDbFile = path.join(dir, "request-logs.sqlite");
    const requestLogStore = new RequestLogStore(requestLogDbFile);
    const usageStore = new UsageStore(path.join(dir, "usage.sqlite"), { requestLogDbFile });
    const createdAt = new Date().toISOString();

    await requestLogStore.record({
      client: "Claude Code",
      completedAt: createdAt,
      durationMs: 25,
      method: "POST",
      path: "/v1/messages",
      providerName: "alpha",
      requestBody: Buffer.from(JSON.stringify({ model: "alpha-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-backfill-1",
      responseBodyText: JSON.stringify({
        model: "alpha-model",
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: createdAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const stats = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 1);
    assert.equal(stats.totals.totalTokens, 17);
    assert.equal(stats.providerModels[0]?.provider, "alpha");
    assert.equal(stats.providerModels[0]?.model, "alpha-model");

    const reread = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(reread.totals.requestCount, 1);
    assert.equal(reread.totals.totalTokens, 17);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore reset clears overview stats and does not backfill old request logs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-reset-test-"));
  try {
    const requestLogDbFile = path.join(dir, "request-logs.sqlite");
    const requestLogStore = new RequestLogStore(requestLogDbFile);
    const usageStore = new UsageStore(path.join(dir, "usage.sqlite"), { requestLogDbFile });
    const beforeResetAt = new Date().toISOString();

    await requestLogStore.record({
      client: "Claude Code",
      completedAt: beforeResetAt,
      durationMs: 25,
      method: "POST",
      path: "/v1/messages",
      providerName: "alpha",
      requestBody: Buffer.from(JSON.stringify({ model: "alpha-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-reset-before",
      responseBodyText: JSON.stringify({
        model: "alpha-model",
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: beforeResetAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const before = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(before.totals.requestCount, 1);

    const reset = await usageStore.resetStatistics();
    assert.equal(reset.deletedEvents, 1);

    const afterReset = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(afterReset.totals.requestCount, 0);
    assert.equal(afterReset.totals.totalTokens, 0);

    const afterResetAt = new Date(Date.parse(reset.resetAt) + 1000).toISOString();
    await requestLogStore.record({
      client: "Claude Code",
      completedAt: afterResetAt,
      durationMs: 40,
      method: "POST",
      path: "/v1/messages",
      providerName: "beta",
      requestBody: Buffer.from(JSON.stringify({ model: "beta-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-reset-after",
      responseBodyText: JSON.stringify({
        model: "beta-model",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: afterResetAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const afterNewRequest = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(afterNewRequest.totals.requestCount, 1);
    assert.equal(afterNewRequest.totals.totalTokens, 10);
    assert.equal(afterNewRequest.providerModels[0]?.provider, "beta");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("native activity calendar fills local days and filters providers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-native-activity-"));
  const store = new UsageStore(path.join(dir, "usage.sqlite"), { estimateCost: async () => undefined });
  try {
    for (const [provider, totalTokens] of [["Company", 12], ["Personal", 30]]) {
      await store.record({ createdAt: new Date().toISOString(), requestId: provider, method: "POST", path: "/v1/responses", statusCode: 200, durationMs: 10, provider, model: "test", usage: { totalTokens } });
    }
    const points = await store.getActivitySeries(182, { provider: "Company" });
    assert.equal(points.length, 182);
    assert.equal(points.at(-1).totalTokens, 12);
    assert.equal(points.slice(0, -1).reduce((sum, point) => sum + point.totalTokens, 0), 0);
    assert.equal((await store.getActivitySeries(1, { includeProxy: true }))[0].totalTokens, 42);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UsageStore provider filter matches compound provider keys by their id segment", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    await store.record({
      createdAt: now.toISOString(),
      durationMs: 50,
      method: "POST",
      model: "glm-5.3",
      path: "/v1/messages",
      provider: "provider-workglm-abc::anthropic_messages",
      requestId: "req-1",
      statusCode: 200,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    });
    await store.record({
      createdAt: now.toISOString(),
      durationMs: 50,
      method: "POST",
      model: "gpt-test",
      path: "/v1/messages",
      provider: "api::openai_chat_completions::cred:primary",
      requestId: "req-2",
      statusCode: 200,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
    });

    const workglm = await store.getStats("30d", { provider: "provider-workglm-abc" });
    assert.equal(workglm.totals.requestCount, 1);
    assert.equal(workglm.totals.totalTokens, 15);

    const api = await store.getStats("30d", { provider: "api" });
    assert.equal(api.totals.requestCount, 1);
    assert.equal(api.totals.totalTokens, 25);

    const none = await store.getStats("30d", { provider: "provider-workglm-xyz" });
    assert.equal(none.totals.requestCount, 0);

    const stats = await store.getStats("30d", {});
    assert.equal(stats.providerModels.length, 2);
    assert.ok(stats.providerModels.every((row) => !row.provider.includes("::")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore honors custom date ranges with a fixed provider status window", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-custom-range-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const pad = (value) => String(value).padStart(2, "0");
    const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const now = new Date();
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(now.getDate() - 2);

    const recordEvent = async (createdAt, provider, requestId) => {
      await store.record({
        createdAt: createdAt.toISOString(),
        durationMs: 100,
        method: "POST",
        model: "alpha-model",
        path: "/v1/messages",
        provider,
        requestId,
        statusCode: 200,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      });
    };
    await recordEvent(twoDaysAgo, "alpha", "custom-1");
    await recordEvent(now, "alpha", "custom-2");

    const narrow = await store.getStats("custom", { includeProxy: true }, { from: dayKey(twoDaysAgo), to: dayKey(twoDaysAgo) });
    assert.equal(narrow.range, "custom");
    assert.equal(narrow.totals.requestCount, 1);
    assert.equal(narrow.series.length, 1);

    const wide = await store.getStats("custom", { includeProxy: true }, { from: dayKey(twoDaysAgo), to: dayKey(now) });
    assert.equal(wide.range, "custom");
    assert.equal(wide.series.length, 3);
    assert.equal(wide.totals.requestCount, 2);

    const fallback = await store.getStats("custom", { includeProxy: true }, { from: "", to: "nope" });
    assert.equal(fallback.range, "7d");

    // Provider status series always spans the trailing 90-day window, whatever the range.
    assert.equal(wide.providerSeries?.[0]?.series.length, 90);
    const today = await store.getStats("today", { includeProxy: true });
    assert.equal(today.providerSeries?.[0]?.series.length, 90);
    assert.ok(today.providerSeries?.[0]?.series.every((point) => !point.bucket.includes(" ")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore merges credential-suffixed provider keys in the status series", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-usage-compound-provider-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const recordEvent = async (provider, requestId) => {
      await store.record({
        createdAt: new Date().toISOString(),
        durationMs: 90,
        method: "POST",
        model: "glm-5.3-flash",
        path: "/v1/messages",
        provider,
        requestId,
        statusCode: 200,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      });
    };
    await recordEvent("workglm::openai_compatible", "compound-1");
    await recordEvent("workglm::openai_compatible::cred:key-2", "compound-2");

    const stats = await store.getStats("today", { includeProxy: true });
    const workglm = stats.providerSeries.find((row) => row.provider === "workglm");
    assert.ok(workglm, "credential-suffixed keys should collapse onto the base provider label");
    assert.equal(workglm.series.length, 90);
    assert.equal(workglm.totals.requestCount, 2);
    const todayBucket = workglm.series[workglm.series.length - 1];
    assert.equal(todayBucket.requestCount, 2, "same-day rows from both keys must sum, not overwrite");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
