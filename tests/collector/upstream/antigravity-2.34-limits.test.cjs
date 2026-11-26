// Ported from TokenTracker v1.5.26 (MIT, #1159): Antigravity 2.34 removed
// GetUnleashData; limits are read through GetUserStatus and the daemon hub file.
"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const binaryProbe = process.platform === "win32" ? "where" : "which";
const {
  detectAntigravityProcess,
  parseAntigravityHubDiscoveryJson,
  listAntigravityHubDiscoveryRecords,
  resolveAntigravityHubDiscovery,
  mergeAntigravityProbePorts,
  probeAntigravityPort,
  fetchAntigravityLimits,
} = require("../../../packages/core/src/vendor/tokentracker/lib/usage-limits");

function antigravityQuotaSummaryPayload() {
  return {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.58, resetTime: "2026-09-07T00:00:00Z" },
          { bucketId: "3p-5h", remainingFraction: 0.82, resetTime: "2026-08-31T10:00:00Z" },
        ],
      },
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.4, resetTime: "2026-09-07T00:00:00Z" },
          { bucketId: "gemini-5h", remainingFraction: 0.9, resetTime: "2026-08-31T10:00:00Z" },
        ],
      },
    ],
  };
}

describe("Antigravity 2.34 limits", () => {
  it("detects 2.34 hub flags from equals-separated process arguments", async () => {
    const commandRunner = () => ({
      stdout: "654 agy --hub --hub-port=18765 --https_server_port=18766 --app_data_dir antigravity --subclient_type hub\n",
      status: 0,
    });

    const result = await detectAntigravityProcess({ commandRunner, platform: "linux" });

    assert.equal(result.configured, true);
    assert.equal(result.pid, 654);
    assert.equal(result.csrfToken, null);
    assert.equal(result.hubPort, 18765);
    assert.equal(result.httpsPort, 18766);
  });

  it("parses daemon hub discovery JSON and rejects unsafe records", () => {
    const record = parseAntigravityHubDiscoveryJson(JSON.stringify({
      pid: 654,
      httpPort: 18765,
      httpsPort: 18766,
      csrfToken: "hub-token",
      lsVersion: "2.34.0",
    }));
    assert.equal(record.pid, 654);
    assert.equal(record.httpPort, 18765);
    assert.equal(record.httpsPort, 18766);
    assert.equal(record.csrfToken, "hub-token");
    assert.equal(parseAntigravityHubDiscoveryJson('{"httpPort":18765,"csrfToken":"bad token"}'), null);
    assert.equal(parseAntigravityHubDiscoveryJson('{"csrfToken":"hub-token"}'), null);
    assert.equal(parseAntigravityHubDiscoveryJson("not-json"), null);
  });

  it("recovers a missing CSRF token from the matching daemon hub file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-hub-"));
    try {
      const daemonDir = path.join(tmp, ".gemini", "antigravity", "daemon");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "hub_18765.json"),
        JSON.stringify({
          pid: 654,
          httpPort: 18765,
          httpsPort: 18766,
          csrfToken: "hub-token",
        }),
        "utf8",
      );
      fs.writeFileSync(path.join(daemonDir, "readme.txt"), "ignore", "utf8");

      const records = listAntigravityHubDiscoveryRecords({ home: tmp });
      assert.equal(records.length, 1);
      assert.equal(records[0].csrfToken, "hub-token");

      const resolved = resolveAntigravityHubDiscovery({
        configured: true,
        pid: 654,
        csrfToken: null,
        hubPort: 18765,
        httpsPort: 18766,
        extensionPort: null,
      }, { home: tmp });
      assert.equal(resolved.csrfToken, "hub-token");
      assert.deepEqual(mergeAntigravityProbePorts(resolved, [19000]), [18765, 18766, 19000]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not attach a contradictory leftover hub record to another process", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-stale-hub-"));
    try {
      const daemonDir = path.join(tmp, ".gemini", "antigravity", "daemon");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "hub_18765.json"),
        JSON.stringify({
          pid: 999,
          httpPort: 18765,
          httpsPort: 18766,
          csrfToken: "stale-token",
        }),
        "utf8",
      );

      const resolved = resolveAntigravityHubDiscovery({
        configured: true,
        pid: 456,
        csrfToken: null,
        hubPort: null,
        httpsPort: null,
        extensionPort: null,
      }, { home: tmp, ports: [35345] });

      assert.equal(resolved.csrfToken, null);
      assert.equal(resolved.hubPort, null);
      assert.equal(resolved.httpsPort, null);
      assert.deepEqual(mergeAntigravityProbePorts(resolved, [35345]), [35345]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still uses a working agy HTTP port when a leftover hub record is stale", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-stale-hub-fetch-"));
    try {
      const daemonDir = path.join(tmp, ".gemini", "antigravity", "daemon");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "hub_18765.json"),
        JSON.stringify({
          pid: 999,
          httpPort: 18765,
          httpsPort: 18766,
          csrfToken: "stale-token",
        }),
        "utf8",
      );
      const commandRunner = (command) => {
        if (command === "/bin/ps") {
          return { stdout: "456 agy\n", status: 0 };
        }
        if (command === binaryProbe) {
          return { stdout: "/usr/bin/lsof\n", status: 0 };
        }
        if (String(command).endsWith("lsof")) {
          return {
            stdout: "agy 456 me 14u IPv4 0x123 0t0 TCP 127.0.0.1:35345 (LISTEN)\n",
            status: 0,
          };
        }
        return { stdout: "", stderr: "", status: 1 };
      };
      const calls = [];
      const requestFn = async ({ path: requestPath, csrfToken, scheme, port }) => {
        calls.push({ endpoint: requestPath.split("/").pop(), csrfToken, scheme, port });
        if (port !== 35345 || csrfToken) {
          throw new Error(`HTTP 401: unauthorized`);
        }
        if (requestPath.includes("GetStatus") || requestPath.includes("GetUnleashData")) {
          throw new Error("HTTP 404: removed");
        }
        if (requestPath.includes("RetrieveUserQuotaSummary") || requestPath.includes("GetUserStatus")) {
          if (requestPath.includes("GetUserStatus") && scheme === "http") {
            return {
              userStatus: {
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    {
                      label: "Gemini 3 Pro",
                      modelOrAlias: { model: "gemini-3-pro" },
                      quotaInfo: {
                        remainingFraction: 0.5,
                        resetTime: "2026-05-22T00:00:00.000Z",
                      },
                    },
                  ],
                },
              },
            };
          }
          if (requestPath.includes("RetrieveUserQuotaSummary")) {
            throw new Error("HTTP 404: not found");
          }
        }
        throw new Error(`unexpected ${requestPath}`);
      };

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        requestFn,
        nowMs: Date.parse("2026-05-21T00:00:00.000Z"),
      });

      assert.equal(result.error, null);
      assert.equal(result.configured, true);
      assert.ok(calls.every((call) => call.csrfToken == null && call.port === 35345));
      assert.ok(result.primary_window || result.tertiary_window);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats a 404 GetUnleashData probe as unimplemented and continues to GetUserStatus", async () => {
    const probed = [];
    const requestFn = async ({ path: requestPath }) => {
      probed.push(requestPath.split("/").pop());
      if (requestPath.includes("GetStatus") || requestPath.includes("GetUnleashData")) {
        throw new Error("HTTP 404: removed");
      }
      if (requestPath.includes("GetUserStatus")) {
        return { userStatus: { planStatus: { planInfo: { planName: "Pro" } } } };
      }
      throw new Error(`unexpected ${requestPath}`);
    };

    assert.equal(await probeAntigravityPort(18765, "hub-token", { requestFn, timeoutMs: 1000 }), true);
    assert.deepEqual(probed, ["GetStatus", "GetUnleashData", "GetUserStatus"]);
  });

  it("does not treat a 401 CSRF rejection as an unimplemented probe", async () => {
    const probed = [];
    const requestFn = async ({ path: requestPath }) => {
      probed.push(requestPath.split("/").pop());
      throw new Error("HTTP 401: unauthorized");
    };

    assert.equal(await probeAntigravityPort(18765, "wrong-token", { requestFn, timeoutMs: 1000 }), false);
    assert.deepEqual(probed, ["GetStatus"]);
  });

  it("reads 2.34 quota after GetUnleashData is removed and CSRF leaves process args", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-antigravity-234-"));
    try {
      const daemonDir = path.join(tmp, ".gemini", "antigravity", "daemon");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "hub_18765.json"),
        JSON.stringify({
          pid: 654,
          httpPort: 18765,
          httpsPort: 18766,
          csrfToken: "hub-token",
        }),
        "utf8",
      );
      const commandRunner = (command) => {
        if (command === "/bin/ps") {
          return {
            stdout: "654 agy --hub --hub-port=18765 --https_server_port=18766 --app_data_dir antigravity --subclient_type hub\n",
            status: 0,
          };
        }
        if (command === binaryProbe) {
          return { stdout: "/usr/bin/lsof\n", status: 0 };
        }
        if (String(command).endsWith("lsof")) {
          return {
            stdout: "agy 654 me 22u IPv4 0x123 0t0 TCP 127.0.0.1:18765 (LISTEN)\nagy 654 me 23u IPv4 0x124 0t0 TCP 127.0.0.1:18766 (LISTEN)\n",
            status: 0,
          };
        }
        return { stdout: "", stderr: "", status: 1 };
      };
      const calls = [];
      const requestFn = async ({ path: requestPath, csrfToken, scheme, port }) => {
        calls.push({ endpoint: requestPath.split("/").pop(), csrfToken, scheme, port });
        if (requestPath.includes("GetStatus") || requestPath.includes("GetUnleashData")) {
          throw new Error("HTTP 404: removed");
        }
        if (requestPath.includes("RetrieveUserQuotaSummary") && csrfToken === "hub-token") {
          return antigravityQuotaSummaryPayload();
        }
        if (requestPath.includes("GetUserStatus")) {
          return {
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: "Gemini 3 Pro",
                    modelOrAlias: { model: "gemini-3-pro" },
                    quotaInfo: {
                      remainingFraction: 0.4,
                      resetTime: "2026-05-22T00:00:00.000Z",
                    },
                  },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${requestPath}`);
      };

      const result = await fetchAntigravityLimits({
        platform: "linux",
        home: tmp,
        commandRunner,
        requestFn,
        nowMs: Date.parse("2026-05-21T00:00:00.000Z"),
      });

      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.ok(
        calls.some((call) => call.endpoint === "GetUserStatus" && call.csrfToken === "hub-token"),
        `expected a CSRF-authenticated GetUserStatus probe, got ${JSON.stringify(calls)}`,
      );
      assert.equal(result.primary_window.used_percent, 42);
      assert.equal(result.secondary_window.used_percent, 18);
      assert.equal(result.tertiary_window.used_percent, 60);
      assert.equal(result.quaternary_window.used_percent, 10);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
