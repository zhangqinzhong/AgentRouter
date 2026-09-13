import assert from "node:assert/strict";
import test from "node:test";
import { interpolateRawAppConfigEnvVars } from "@agentrouter/core/config/config.ts";

test("config env interpolation is limited to legacy JSON config", () => {
  const previous = process.env.AR_ENV_INTERPOLATION_SECRET;
  process.env.AR_ENV_INTERPOLATION_SECRET = "env-secret";

  try {
    const rawConfig = {
      Providers: [
        {
          account: {
            connectors: [
              {
                body: {
                  token: "${AR_ENV_INTERPOLATION_SECRET}"
                },
                endpoint: "https://usage.example.com/account",
                headers: {
                  "x-env-secret": "$AR_ENV_INTERPOLATION_SECRET"
                },
                mapping: {
                  meters: [
                    {
                      id: "balance",
                      kind: "balance",
                      remaining: "$.balance",
                      unit: "$AR_ENV_INTERPOLATION_SECRET"
                    }
                  ]
                },
                type: "http-json"
              }
            ],
            enabled: true
          },
          api_key: "${AR_ENV_INTERPOLATION_SECRET}",
          baseUrl: "https://api.example.com/v1",
          models: ["model"],
          name: "Remote"
        }
      ]
    };

    const sqliteConfig = interpolateRawAppConfigEnvVars(rawConfig, "sqlite");
    assert.equal(sqliteConfig.Providers[0].api_key, "${AR_ENV_INTERPOLATION_SECRET}");
    assert.equal(sqliteConfig.Providers[0].account.connectors[0].headers["x-env-secret"], "$AR_ENV_INTERPOLATION_SECRET");
    assert.equal(sqliteConfig.Providers[0].account.connectors[0].body.token, "${AR_ENV_INTERPOLATION_SECRET}");
    assert.equal(sqliteConfig.Providers[0].account.connectors[0].mapping.meters[0].unit, "$AR_ENV_INTERPOLATION_SECRET");

    const legacyConfig = interpolateRawAppConfigEnvVars(rawConfig, "legacy-json");
    assert.equal(legacyConfig.Providers[0].api_key, "env-secret");
    assert.equal(legacyConfig.Providers[0].account.connectors[0].headers["x-env-secret"], "env-secret");
    assert.equal(legacyConfig.Providers[0].account.connectors[0].body.token, "env-secret");
    assert.equal(legacyConfig.Providers[0].account.connectors[0].mapping.meters[0].unit, "env-secret");
  } finally {
    if (previous === undefined) {
      delete process.env.AR_ENV_INTERPOLATION_SECRET;
    } else {
      process.env.AR_ENV_INTERPOLATION_SECRET = previous;
    }
  }
});
