"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveKimiProfile } = require("../../../packages/core/src/vendor/tokentracker/lib/kimi-profile");
const { fetchKimiLimits, loadKimiCredentials } = require("../../../packages/core/src/vendor/tokentracker/lib/usage-limits");

const globalKey = "kimi-code-env-0e4f99c69cc27850";
const regions = {
  mainland: { oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.com/coding/v1", key: "kimi-code" },
  global: { oauthHost: "https://auth.kimi.ai", baseUrl: "https://api.kimi.ai/coding/v1", key: globalKey },
};

function fixture(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-kimi-profile-"));
    try { await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

function writeLogin(home, { region = "global", dirname = ".kimi-code", login = true, expired = false } = {}) {
  const profile = regions[region];
  const dir = path.join(home, dirname);
  fs.mkdirSync(path.join(dir, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"),
    `[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "${profile.baseUrl}"\n` +
    `[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/${profile.key}"\noauth_host = "${profile.oauthHost}"\n`);
  const credsPath = path.join(dir, "credentials", `${profile.key}.json`);
  if (login) fs.writeFileSync(credsPath, JSON.stringify({ access_token: `${region}-token`, refresh_token: `${region}-refresh`, expires_at: expired ? 1 : 4_000_000_000 }));
  return credsPath;
}

function reply(status = 200, body = { usage: { used: 4, limit: 10 } }) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

for (const region of Object.keys(regions)) {
  test(`Kimi ${region} quota uses its active endpoint-scoped credentials`, fixture(async (home) => {
    const credsPath = writeLogin(home, { region });
    const profile = resolveKimiProfile({ home, env: {} });
    assert.equal(profile.credsPath, credsPath);
    const calls = [];
    const result = await fetchKimiLimits({ home, env: {}, fetchImpl: async (url, options) => {
      calls.push([url, options.headers.Authorization, options.redirect]);
      return reply();
    } });
    assert.equal(result.primary_window.used_percent, 40);
    assert.deepEqual(calls, [[`${regions[region].baseUrl}/usages`, `Bearer ${region}-token`, "error"]]);
  }));
}

test("active global profile never falls back to a stale mainland or legacy login", fixture(async (home) => {
  writeLogin(home, { region: "mainland", dirname: ".kimi" });
  writeLogin(home, { region: "mainland" });
  writeLogin(home, { login: false });
  assert.equal(loadKimiCredentials({ home, env: {} }), null);
  const result = await fetchKimiLimits({ home, env: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.equal(result.configured, false);
}));

for (const expireFirst of [true, false]) {
  test(`global refresh ${expireFirst ? "before usage" : "after a 401"} updates only the active slot`, fixture(async (home) => {
    const legacy = writeLogin(home, { region: "mainland", dirname: ".kimi" });
    const originalLegacy = fs.readFileSync(legacy, "utf8");
    const globalFile = writeLogin(home, { expired: expireFirst });
    const calls = [];
    let usageCalls = 0;
    const result = await fetchKimiLimits({ home, env: {}, fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      if (url === "https://auth.kimi.ai/api/oauth/token") {
        assert.equal(options.body.get("refresh_token"), "global-refresh");
        return reply(200, { access_token: "fresh-global", refresh_token: "rotated-global", expires_in: 900 });
      }
      assert.equal(url, "https://api.kimi.ai/coding/v1/usages");
      usageCalls++;
      if (!expireFirst && usageCalls === 1) return reply(401);
      assert.equal(options.headers.Authorization, "Bearer fresh-global");
      return reply();
    } });
    assert.equal(result.error, null);
    assert.equal(calls.length, expireFirst ? 2 : 3);
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).refresh_token, "rotated-global");
    assert.equal(fs.readFileSync(legacy, "utf8"), originalLegacy);
  }));
}

test("legacy users retain the mainland login when no managed Code profile exists", fixture(async (home) => {
  const credsPath = writeLogin(home, { region: "mainland", dirname: ".kimi" });
  assert.equal(resolveKimiProfile({ home, env: {} }).credsPath, credsPath);
  assert.equal(loadKimiCredentials({ home, env: {} }).access_token, "mainland-token");
}));

test("official environment overrides derive the global slot without using a stale configured key", fixture(async (home) => {
  writeLogin(home, { region: "mainland" });
  const env = { KIMI_CODE_OAUTH_HOST: "https://auth.kimi.ai/", KIMI_CODE_BASE_URL: "https://api.kimi.ai/coding/v1/" };
  const profile = resolveKimiProfile({ home, env });
  assert.equal(profile.error, null);
  assert.equal(path.basename(profile.credsPath), `${globalKey}.json`);
  assert.equal(loadKimiCredentials({ home, env }), null);
}));

test("malformed, unsupported or cross-region profiles send no credentials", fixture(async (home) => {
  for (const patch of [
    (text) => text.replace("https://auth.kimi.ai", "https://attacker.invalid"),
    (text) => text.replace("https://auth.kimi.ai", "https://auth.kimi.com"),
    (text) => text.replace('storage = "file"', 'storage = "keyring"'),
    () => "[providers.\"managed:kimi-code\"\n",
  ]) {
    writeLogin(home);
    const configPath = path.join(home, ".kimi-code", "config.toml");
    fs.writeFileSync(configPath, patch(fs.readFileSync(configPath, "utf8")));
    const result = await fetchKimiLimits({ home, env: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
    assert.equal(result.configured, true);
    assert.ok(result.error);
  }
}));

test("in-flight refresh keeps the original profile when config changes", fixture(async (home) => {
  const globalFile = writeLogin(home, { expired: true });
  const result = await fetchKimiLimits({ home, env: {}, fetchImpl: async (url) => {
    if (url === "https://auth.kimi.ai/api/oauth/token") {
      writeLogin(home, { region: "mainland" });
      return reply(200, { access_token: "fresh-global", expires_in: 900 });
    }
    assert.equal(url, "https://api.kimi.ai/coding/v1/usages");
    return reply();
  } });
  assert.equal(result.error, null);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).access_token, "fresh-global");
  assert.equal(loadKimiCredentials({ home, env: {} }).access_token, "mainland-token");
}));
