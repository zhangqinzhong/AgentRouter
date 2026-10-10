const assert=require('node:assert/strict');
const {describe,it}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { getUsageLimits,resetUsageLimitsCache }=require('../../../packages/core/src/vendor/tokentracker/lib/usage-limits');
describe("getUsageLimits reads Claude Code's cached usage", () => {
  const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
  const ACCOUNT = "11111111-2222-4333-8444-555555555555";

  function writeClaudeCreds(home, token) {
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  }

  /** Write Claude Code's global config with a cached /api/oauth/usage body. */
  function writeClaudeCodeConfig(dir, {
    fetchedAtMs,
    fiveHour,
    cachedAccount = ACCOUNT,
    currentAccount = ACCOUNT,
    fiveHourResetMs = Date.now() + 3_600_000,
    sevenDayResetMs = Date.now() + 86_400_000,
  }) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
      oauthAccount: { accountUuid: currentAccount },
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: cachedAccount,
        utilization: {
          five_hour: { utilization: fiveHour, resets_at: new Date(fiveHourResetMs).toISOString() },
          seven_day: { utilization: 12, resets_at: new Date(sevenDayResetMs).toISOString() },
          limits: [],
        },
      },
    }));
  }

  function writeOwnCache(home, { cachedAt, fiveHour }) {
    const cacheDir = path.join(home, ".agentrouter/collector", "tracker");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "claude-usage-limits-cache.json"), JSON.stringify({
      claude: {
        five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: null, seven_day_opus: null, weekly_scoped: null, extra_usage: null,
        cached_at: cachedAt,
      },
    }));
  }

  /** Run getUsageLimits on Linux with Claude's usage endpoint answering via `claudeResponse`. */
  async function run(home, claudeResponse, extra = {}) {
    return getUsageLimits({
      home,
      platform: "linux",
      providerTimeoutMs: 2000,
      securityRunner() { return { status: 1, stdout: "" }; },
      commandRunner() { return { status: 1, stdout: "" }; },
      fetchImpl(url) {
        if (url === CLAUDE_USAGE_URL) return claudeResponse();
        return Promise.reject(new Error("unmocked"));
      },
      ...extra,
    });
  }

  const rateLimited = () => Promise.resolve({
    ok: false,
    status: 429,
    headers: { get: (k) => (k === "retry-after" ? "3600" : null) },
    json: async () => ({}),
  });

  it("serves Claude Code's newer cached read instead of our older cache when the live read 429s", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-code-cache-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-cc-cache");
      writeOwnCache(tmp, { cachedAt: new Date(Date.now() - 15 * 3_600_000).toISOString(), fiveHour: 80 });
      const fetchedAtMs = Date.now() - 60 * 60 * 1000;
      writeClaudeCodeConfig(tmp, { fetchedAtMs, fiveHour: 5 });

      const result = await run(tmp, rateLimited);

      assert.equal(result.claude.error, null);
      assert.equal(result.claude.stale, true);
      assert.equal(result.claude.five_hour.utilization, 5);
      assert.equal(result.claude.seven_day.utilization, 12);
      assert.equal(result.claude.cached_at, new Date(fetchedAtMs).toISOString());
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the usage API while Claude Code's cached read is within the fresh TTL", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-code-fresh-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-cc-fresh");
      writeClaudeCodeConfig(tmp, { fetchedAtMs: Date.now() - 2 * 60 * 1000, fiveHour: 33 });
      let calls = 0;

      const result = await run(tmp, () => { calls += 1; return rateLimited(); });

      assert.equal(calls, 0, "a fresh Claude Code read must not spend another usage request");
      assert.equal(result.claude.error, null);
      assert.equal(result.claude.stale, false);
      assert.equal(result.claude.five_hour.utilization, 33);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores Claude Code's cached read when it belongs to another account", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-code-account-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-cc-account");
      const ownCachedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      writeOwnCache(tmp, { cachedAt: ownCachedAt, fiveHour: 70 });
      writeClaudeCodeConfig(tmp, {
        fetchedAtMs: Date.now() - 60 * 1000,
        fiveHour: 1,
        cachedAccount: "99999999-2222-4333-8444-555555555555",
      });

      const result = await run(tmp, rateLimited);

      assert.equal(result.claude.five_hour.utilization, 70);
      assert.equal(result.claude.cached_at, ownCachedAt);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays on the token's profile and ignores a $CLAUDE_CONFIG_DIR copy", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-code-configdir-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-cc-configdir");
      const ownCachedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      writeOwnCache(tmp, { cachedAt: ownCachedAt, fiveHour: 70 });
      // The token comes from the default profile, so another profile's cache must not be used.
      const configDir = path.join(tmp, "alt-claude");
      writeClaudeCodeConfig(configDir, { fetchedAtMs: Date.now() - 60 * 1000, fiveHour: 21 });

      const result = await run(tmp, rateLimited, { env: { CLAUDE_CONFIG_DIR: configDir } });

      assert.equal(result.claude.five_hour.utilization, 70);
      assert.equal(result.claude.cached_at, ownCachedAt);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps an older usable cache when Claude Code's newer read has only expired windows", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-claude-code-expired-"));
    try {
      writeClaudeCreds(tmp, "sk-ant-oauth-cc-expired");
      const ownCachedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      writeOwnCache(tmp, { cachedAt: ownCachedAt, fiveHour: 64 });
      writeClaudeCodeConfig(tmp, {
        fetchedAtMs: Date.now() - 60 * 60 * 1000,
        fiveHour: 2,
        fiveHourResetMs: Date.now() - 60 * 1000,
        sevenDayResetMs: Date.now() - 60 * 1000,
      });

      const result = await run(tmp, rateLimited);

      assert.equal(result.claude.error, null);
      assert.equal(result.claude.five_hour.utilization, 64);
      assert.equal(result.claude.cached_at, ownCachedAt);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

