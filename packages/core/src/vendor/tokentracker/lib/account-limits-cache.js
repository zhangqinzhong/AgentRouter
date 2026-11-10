"use strict";

// AR's targeted refreshes can overlap a full menu refresh. Reuse TokenTracker's
// last-good pipeline, partitioned by account AND requested product, and never let
// an older poll write over a newer one or a login changed during the fetch.
const { createLimitsCache, withLimitsCacheFallback } = require("./limits-cache");
const os = require("node:os");
const path = require("node:path");
const generations = new Map();
const caches = new Map();
const fields = {
  membership_type: "string", plan_label: "string", grok_bot_plan_label: "string",
  period_type: "string", monthly_credits_limit: "raw", monthly_credits_used: "raw",
  credit_usage_percent: "raw", on_demand_cap: "raw", on_demand_used: "raw",
  billing_period_start: "string",
  products: {
    write: (record) => Array.isArray(record?.products) ? record.products : [],
    read: (raw, ctx) => Array.isArray(raw?.products)
      ? raw.products.filter((p) => ctx.isWindowUsable(p?.window, { nowMs: ctx.nowMs })) : [],
  },
};

async function withAccountLimitsCache({ home, provider, identity, fetchLimits, now = Date.now }) {
  if (!["cursor", "cursor-all", "grokbot", "grok"].includes(provider)) throw new Error("Unsupported quota cache provider");
  const key = `${home || ""}\0${provider}`;
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  const isCurrentGeneration = () => generations.get(key) === generation;
  const before = await identity();
  const slot = await fetchLimits();
  if (!caches.has(provider)) caches.set(provider, createLimitsCache({
    file: `agentrouter-${provider}-limits-cache.json`, key: provider,
    fields, windowKeys: ["primary_window", "secondary_window", "tertiary_window", "quaternary_window"],
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, unknownResetTtlMs: 10 * 60 * 1000,
    identityField: "identity", identityRequired: true,
    dirOverride: "trackerDir",
  }));
  const cache = caches.get(provider);
  const trackerDir = path.join(home || os.homedir(), ".agentrouter", "collector", "tracker");
  return withLimitsCacheFallback(slot, {
    home, cache: {
      ...cache,
      read: (options) => cache.read({ ...options, trackerDir }),
      write: (value, options) => cache.write(value, { ...options, trackerDir }),
    }, nowMs: now(), isCurrentGeneration,
    resolveWriteIdentity: async () => before && before === await identity() ? before : null,
    beforeRead: async () => {
      const current = await identity();
      return before && before === current ? { identity: current, nowMs: now() } : null;
    },
    passthrough: (value) => value.auth_error === true ||
      /(?:\b401\b|\b403\b|unauthorized|forbidden|not logged|expired|login|log in|sign in|authenticate|credential|invalid.*token)/i.test(value.error || ""),
  });
}

module.exports = { withAccountLimitsCache };
