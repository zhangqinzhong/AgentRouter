import type {
  MonitorQuery,
  MonitorRange,
  MonitorReport,
} from "@agentrouter/core/contracts/monitor";
export const ranges: MonitorRange[] = [
  "1h",
  "6h",
  "24h",
  "today",
  "7d",
  "14d",
  "30d",
];
export function initialQuery(): MonitorQuery {
  const params = new URLSearchParams(window.location.search);
  let zone =
    params.get("monitorTz") || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const range = params.get("monitorRange") as MonitorRange;
  return {
    range: ranges.includes(range) ? range : "24h",
    timeZone: zone,
    models: params.getAll("monitorModel"),
    providers: params.getAll("monitorProvider"),
    clients: params.getAll("monitorClient"),
  };
}
export function saveQuery(query: MonitorQuery) {
  const url = new URL(window.location.href);
  url.searchParams.set("monitorRange", query.range);
  url.searchParams.set("monitorTz", query.timeZone);
  for (const [key, param] of [
    ["models", "monitorModel"],
    ["providers", "monitorProvider"],
    ["clients", "monitorClient"],
  ] as const) {
    url.searchParams.delete(param);
    for (const value of query[key] ?? []) url.searchParams.append(param, value);
  }
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
export function health(report: MonitorReport) {
  if (!report.current.requests)
    return { score: null, abnormal: 0, latencyChange: null };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const rate = report.current.successRate ?? 0;
  const channels = report.rankings.providers.filter((r) => r.requests >= 5),
    bad = channels.filter((r) => (r.successRate ?? 100) < 95),
    shaky = channels.filter(
      (r) => (r.successRate ?? 100) >= 95 && (r.successRate ?? 100) < 99,
    );
  const share = (rows: typeof channels) =>
    rows.reduce((s, r) => s + r.requests, 0) / report.current.requests;
  let sum = clamp(((rate - 90) / 9.5) * 100) * 0.5,
    weight = 0.5;
  if (channels.length) {
    sum += clamp(100 - share(bad) * 200 - share(shaky) * 40) * 0.25;
    weight += 0.25;
  }
  const before = report.previous.duration,
    after = report.current.duration,
    latencyChange = before && after != null ? (after / before - 1) * 100 : null;
  if (latencyChange != null) {
    sum += clamp(((100 - latencyChange) / 80) * 100) * 0.25;
    weight += 0.25;
  }
  return {
    score: Math.round(sum / weight),
    abnormal: bad.length + shaky.length,
    latencyChange,
  };
}
