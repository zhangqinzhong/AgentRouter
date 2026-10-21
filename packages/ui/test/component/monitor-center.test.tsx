import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MonitorReport } from "@agentrouter/core/contracts/monitor";
import {
  health,
  initialQuery,
  saveQuery,
  ranges,
} from "../../src/pages/home/components/monitor/state";
import {
  Traffic,
  Latency,
} from "../../src/pages/home/components/monitor/charts";
import {
  Ranking,
  Failures,
  failureMessage,
} from "../../src/pages/home/components/monitor/rankings";
import { Flow, Heatmap } from "../../src/pages/home/components/monitor/flow";
import { installBrowserGlobals } from "../fixtures/index";
installBrowserGlobals();
const empty = {
  requests: 0,
  failed: 0,
  success: 0,
  successRate: null,
  tokens: 0,
  input: 0,
  output: 0,
  cached: 0,
  cost: 0,
  priced: 0,
  cacheRate: null,
  duration: null,
  ttft: null,
  ttftSamples: 0,
  streaming: 0,
  logSamples: 0,
  outputSpeed: null,
};
const distribution = {
  samples: 0,
  average: null,
  p50: null,
  p90: null,
  p95: null,
  p99: null,
  max: null,
  histogram: Array(9).fill(0),
};
const report: MonitorReport = {
  generatedAt: "2026-10-21T00:00:00Z",
  query: { range: "24h", timeZone: "UTC" },
  from: "2026-10-20T00:00:00Z",
  to: "2026-10-21T00:00:00Z",
  previousFrom: "2026-10-19T00:00:00Z",
  previousTo: "2026-10-20T00:00:00Z",
  stepMs: 1800000,
  current: empty,
  previous: empty,
  series: [],
  minutes: [],
  latency: {
    bounds: [1000, 3000, 5000, 10000, 20000, 30000, 60000, 120000],
    total: distribution,
    firstToken: distribution,
    previousTotal: distribution,
    previousFirstToken: distribution,
    coverageStart: null,
  },
  rankings: { models: [], providers: [], clients: [] },
  options: { models: [], providers: [], clients: [] },
  failures: [],
  failureStatuses: [],
  flows: [],
  heatmap: [],
  logAvailable: false,
};
test("monitor health excludes absent observations rather than reporting a healthy empty gateway", () => {
  assert.equal(health(report).score, null);
  assert.equal(
    health({ ...report, current: { ...empty, requests: 10, successRate: 100 } })
      .score,
    100,
  );
  assert.equal(
    health({ ...report, current: { ...empty, requests: 10, successRate: 90 } })
      .score,
    0,
  );
});
test("monitor URL round-trips multi-select filters, timezone, and range without losing other query state", () => {
  let href = "http://localhost/?other=keep#monitor";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      get search() {
        return new URL(href).search;
      },
    },
  });
  Object.defineProperty(window, "history", {
    configurable: true,
    value: {
      replaceState: (_a: unknown, _b: unknown, next: string) => {
        href = new URL(next, href).href;
      },
    },
  });
  const query = {
    range: "14d" as const,
    timeZone: "Asia/Shanghai",
    models: ["a", "b"],
    providers: ["p::type"],
    clients: ["Codex"],
  };
  saveQuery(query);
  assert.deepEqual(initialQuery(), query);
  assert.ok(href.includes("other=keep"));
  assert.ok(href.endsWith("#monitor"));
  href = "http://localhost/?monitorRange=bad&monitorTz=bad";
  assert.equal(initialQuery().range, "24h");
  assert.equal(initialQuery().timeZone, "UTC");
  assert.equal(ranges.length, 7);
});
test("complete monitor analysis remains navigable without measured data and does not invent latency", () => {
  const html = renderToStaticMarkup(
    <>
      <Traffic report={report} />
      <Latency report={report} />
      <Failures report={report} onSelect={() => {}} />
      {(["models", "providers", "clients"] as const).map((d) => (
        <Ranking key={d} report={report} dimension={d} onSelect={() => {}} />
      ))}
      <Flow report={report} onSelect={() => {}} />
      <Heatmap report={report} />
    </>,
  );
  for (const label of [
    "Traffic",
    "Latency distribution",
    "Failure",
    "Model performance",
    "Channel health",
    "Client ranking",
    "Traffic flow",
    "UTC",
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, />0\.00s</);
});

test("failure details use structured upstream messages without rendering response objects", () => {
  const detail = {responseBody:{encoding:"utf8",text:JSON.stringify({error:{message:"Upstream timeout"}})}} as any;
  assert.equal(failureMessage(detail),"Upstream timeout");
  assert.equal(failureMessage({...detail,error:"Connection reset"}),"Connection reset");
  assert.equal(failureMessage({...detail,responseBody:{encoding:"utf8",text:"<html>error</html>"}}),undefined);
});
