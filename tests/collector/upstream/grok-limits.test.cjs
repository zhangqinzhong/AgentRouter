const assert=require('node:assert/strict');
const {describe,it}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { fetchGrokLimits }=require('../../../packages/core/src/vendor/tokentracker/lib/grok-limits');
  it("falls back to legacy billing when format=credits returns an unrecognized shape", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-shape-fallback-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::test": { key: "test-token" },
        }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          if (String(url).endsWith("/v1/settings")) return { ok: false, status: 503 };
          urls.push(url);
          if (String(url).includes("format=credits")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return { config: { futureBillingField: true } };
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 250 },
                  billingPeriodStart: "2026-07-01T00:00:00Z",
                  billingPeriodEnd: "2026-08-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.deepEqual(urls, [
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        "https://cli-chat-proxy.grok.com/v1/billing",
      ]);
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.period_type, "monthly");
      assert.equal(result.primary_window.used_percent, 25);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not replace malformed unified billing with a legacy monthly pool", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-limits-malformed-period-"));
    try {
      const grokHome = path.join(tmp, ".grok");
      fs.mkdirSync(grokHome, { recursive: true });
      fs.writeFileSync(
        path.join(grokHome, "auth.json"),
        JSON.stringify({ "https://auth.x.ai::test": { key: "test-token" } }),
        "utf8",
      );

      const urls = [];
      const result = await fetchGrokLimits({
        home: tmp,
        env: { GROK_HOME: grokHome },
        fetchImpl: async (url) => {
          urls.push(String(url));
          if (String(url).endsWith("/v1/settings")) return { ok: false, status: 503 };
          return {
            ok: true,
            status: 200,
            async json() {
              if (String(url).includes("format=credits")) {
                return {
                  config: {
                    currentPeriod: {
                      type: "USAGE_PERIOD_TYPE_WEEKLY",
                      start: "2026-07-22T00:00:00Z",
                      end: "2026-07-29T00:00:00Z",
                    },
                    creditUsagePercent: "40%",
                  },
                };
              }
              return {
                config: {
                  monthlyLimit: { val: 1000 },
                  used: { val: 10 },
                  billingPeriodStart: "2026-07-01T00:00:00Z",
                  billingPeriodEnd: "2026-08-01T00:00:00Z",
                },
              };
            },
          };
        },
      });

      assert.equal(result.configured, true);
      assert.equal(result.error, "Could not parse Grok billing: no quota windows in response");
      assert.deepEqual(urls, ["https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
      assert.equal(result.primary_window, undefined);
      assert.equal(result.period_type, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

