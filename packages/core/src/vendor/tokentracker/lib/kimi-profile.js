"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("smol-toml");
// Retain upstream home expansion without importing its CLI scanning coordinator.
function expandHome(value, home) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === "~") return path.resolve(home);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.resolve(home, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(home, trimmed);
}

const MAINLAND = { oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.com/coding/v1" };
const GLOBAL = { oauthHost: "https://auth.kimi.ai", baseUrl: "https://api.kimi.ai/coding/v1" };

function endpoint(value, fallback) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : fallback;
}

// The two supported official endpoint pairs have stable upstream credential
// slots. The global suffix is SHA-256(JSON.stringify({ oauthHost, baseUrl }))
// truncated to 16 hex characters, matching managed-kimi-code.ts. Keeping the
// filenames constant also prevents remote configuration from shaping paths.
function credentialKey(oauthHost, baseUrl) {
  return oauthHost === GLOBAL.oauthHost && baseUrl === GLOBAL.baseUrl
    ? "kimi-code-env-0e4f99c69cc27850" : "kimi-code";
}

function resolveKimiProfile({ home, env = process.env } = {}) {
  const base = home || os.homedir();
  const explicit = expandHome(env?.KIMI_HOME, base);
  const explicitCode = expandHome(env?.KIMI_CODE_HOME, base);
  const codeHome = explicit || explicitCode || path.join(base, ".kimi-code");
  const codeConfig = path.join(codeHome, "config.toml");
  let provider = null;
  let error = null;
  if (fs.existsSync(codeConfig)) {
    try {
      provider = parse(fs.readFileSync(codeConfig, "utf8"))?.providers?.["managed:kimi-code"] || null;
    } catch {
      error = "Could not parse Kimi Code config.toml";
    }
  }
  let hasCodeLogin = false;
  try {
    hasCodeLogin = Boolean(JSON.parse(fs.readFileSync(path.join(codeHome, "credentials", "kimi-code.json"), "utf8"))?.access_token);
  } catch { /* No default-slot login. */ }
  const hasEnvOverride = env?.KIMI_CODE_BASE_URL != null || env?.KIMI_CODE_OAUTH_HOST != null || env?.KIMI_OAUTH_HOST != null;
  const kimiHome = explicit || explicitCode || provider || error || hasCodeLogin || hasEnvOverride
    ? codeHome : path.join(base, ".kimi");
  const oauthHost = endpoint(hasEnvOverride ? env?.KIMI_CODE_OAUTH_HOST ?? env?.KIMI_OAUTH_HOST : provider?.oauth?.oauth_host, MAINLAND.oauthHost);
  const baseUrl = endpoint(env?.KIMI_CODE_BASE_URL ?? provider?.base_url, MAINLAND.baseUrl);
  if (![MAINLAND, GLOBAL].some((region) => region.oauthHost === oauthHost && region.baseUrl === baseUrl)) {
    error = "Unsupported Kimi quota endpoints; configure a matching official mainland or global profile";
  }
  if (provider?.oauth?.storage && provider.oauth.storage !== "file") {
    error = "Kimi quota supports file credentials; the configured credential storage is unsupported";
  }
  // Derive the endpoint-scoped slot, just as upstream does when a stored key
  // mismatches the endpoints. Never read an unrelated slot or legacy login.
  const credsPath = path.join(kimiHome, "credentials", `${credentialKey(oauthHost, baseUrl)}.json`);
  return { home: kimiHome, credsPath, oauthHost, baseUrl, error, configured: fs.existsSync(path.join(kimiHome, "config.toml")) };
}

module.exports = { resolveKimiProfile };
