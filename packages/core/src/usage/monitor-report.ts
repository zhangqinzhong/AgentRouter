import { existsSync } from "node:fs";
import {
  createBetterSqliteDatabase,
  type BetterSqliteDatabase,
} from "../storage/sqlite-native";
import type {
  MonitorQuery,
  MonitorRange,
  MonitorReport,
  MonitorMetrics,
  MonitorPoint,
  MonitorRank,
  MonitorDistribution,
  MonitorDimension,
} from "../contracts/monitor";

const HOUR = 3600000,
  DAY = 24 * HOUR;
export const MONITOR_BOUNDS = [
  1000, 3000, 5000, 10000, 20000, 30000, 60000, 120000,
];
const ranges: MonitorRange[] = ["1h", "6h", "24h", "today", "7d", "14d", "30d"];
export function normalizeMonitorQuery(raw: MonitorQuery): MonitorQuery {
  if (!ranges.includes(raw.range))
    throw new Error("Invalid monitoring time range");
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw.timeZone }).format();
  } catch {
    throw new Error("Invalid monitoring time zone");
  }
  const list = (items: unknown) =>
    Array.isArray(items)
      ? [
          ...new Set(
            items.filter(
              (x): x is string => typeof x === "string" && x.length <= 512,
            ),
          ),
        ].slice(0, 100)
      : [];
  return {
    range: raw.range,
    timeZone: raw.timeZone,
    models: list(raw.models),
    providers: list(raw.providers),
    clients: list(raw.clients),
  };
}
function zonedParts(ms: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  return Object.fromEntries(p.map((x) => [x.type, Number(x.value)]));
}
export function monitorWindow(query: MonitorQuery, now = Date.now()) {
  let from: number;
  let previousFrom: number | undefined;
  let previousTo: number | undefined;
  if (query.range === "today") {
    const p = zonedParts(now, query.timeZone),
      midnight = Date.UTC(p.year, p.month - 1, p.day);
    from = midnight;
    // Resolve local midnight against its own offset, including DST transitions.
    const resolveMidnight = (target: number) => {
      let candidate = target;
      for (let i = 0; i < 4; i++) {
        const z = zonedParts(candidate, query.timeZone);
        const local = Date.UTC(
          z.year,
          z.month - 1,
          z.day,
          z.hour,
          z.minute,
          z.second,
        );
        const correction = target - local;
        if (!correction) break;
        candidate += correction;
      }
      return candidate;
    };
    from = resolveMidnight(midnight);
    previousFrom = resolveMidnight(midnight - DAY);
    previousTo =
      resolveMidnight(
        Date.UTC(p.year, p.month - 1, p.day - 1, p.hour, p.minute, p.second),
      ) +
      (now % 1000);
  } else
    from =
      now -
      {
        "1h": HOUR,
        "6h": 6 * HOUR,
        "24h": DAY,
        "7d": 7 * DAY,
        "14d": 14 * DAY,
        "30d": 30 * DAY,
      }[query.range];
  const span = now - from,
    stepMs =
      span <= HOUR
        ? 60000
        : span <= 6 * HOUR
          ? 5 * 60000
          : span <= DAY
            ? 30 * 60000
            : span <= 7 * DAY
              ? 3 * HOUR
              : span <= 14 * DAY
                ? 6 * HOUR
                : 12 * HOUR;
  return {
    from,
    to: now,
    previousFrom: previousFrom ?? from - span,
    previousTo: previousTo ?? from,
    stepMs,
  };
}
type Event = {
  id: number;
  created_at: string;
  request_id: string;
  client: string;
  provider: string;
  model: string;
  status_code: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  path: string;
};
type Detail = {
  id: number;
  request_id: string;
  source_usage_id: number | null;
  created_at: string;
  time_to_first_token_ms: number | null;
  stream_output_duration_ms: number | null;
  is_stream: number;
};
type Sample = { event: Event; detail?: Detail; ms: number };
const valid = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function monitorDistribution(values: number[]): MonitorDistribution {
  const sorted = values.filter(valid).sort((a, b) => a - b),
    samples = sorted.length;
  const percentile = (p: number) =>
    samples ? sorted[Math.max(0, Math.ceil(samples * p) - 1)] : null;
  const histogram = Array(MONITOR_BOUNDS.length + 1).fill(0) as number[];
  for (const n of sorted) {
    const index = MONITOR_BOUNDS.findIndex((b) => n < b);
    histogram[index < 0 ? MONITOR_BOUNDS.length : index]++;
  }
  return {
    samples,
    average: samples ? sorted.reduce((a, b) => a + b, 0) / samples : null,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: samples ? sorted[samples - 1] : null,
    histogram,
  };
}
function metrics(rows: Sample[]): MonitorMetrics {
  let failed = 0,
    tokens = 0,
    input = 0,
    output = 0,
    cached = 0,
    cacheRead = 0,
    cost = 0,
    priced = 0,
    duration = 0,
    durationSamples = 0,
    ttft = 0,
    ttftSamples = 0,
    streaming = 0,
    logSamples = 0,
    speedOutput = 0,
    speedMs = 0;
  for (const { event: e, detail: d } of rows) {
    if (e.status_code === 0 || e.status_code >= 400) failed++;
    tokens += e.total_tokens;
    input += e.input_tokens;
    output += e.output_tokens;
    cached += e.cache_read_tokens + e.cache_write_tokens;
    cacheRead += e.cache_read_tokens;
    if (valid(e.cost_usd)) {
      cost += e.cost_usd;
      priced++;
    }
    if (e.status_code > 0 && e.status_code < 400 && e.duration_ms > 0) {
      duration += e.duration_ms;
      durationSamples++;
    }
    if (d) {
      logSamples++;
      if (d.is_stream) streaming++;
      if (
        e.status_code > 0 &&
        e.status_code < 400 &&
        d.is_stream &&
        valid(d.time_to_first_token_ms)
      ) {
        ttft += d.time_to_first_token_ms;
        ttftSamples++;
      }
      if (
        e.status_code > 0 &&
        e.status_code < 400 &&
        d.is_stream &&
        valid(d.stream_output_duration_ms) &&
        d.stream_output_duration_ms > 0
      ) {
        speedOutput += e.output_tokens;
        speedMs += d.stream_output_duration_ms;
      }
    }
  }
  const requests = rows.length;
  return {
    requests,
    failed,
    success: requests - failed,
    successRate: requests ? ((requests - failed) / requests) * 100 : null,
    tokens,
    input,
    output,
    cached,
    cost,
    priced,
    cacheRate: input + cached ? (cacheRead / (input + cached)) * 100 : null,
    duration: durationSamples ? duration / durationSamples : null,
    ttft: ttftSamples ? ttft / ttftSamples : null,
    ttftSamples,
    streaming,
    logSamples,
    outputSpeed: speedMs ? speedOutput / (speedMs / 1000) : null,
  };
}
function points(
  rows: Sample[],
  from: number,
  to: number,
  step: number,
): MonitorPoint[] {
  const start = Math.floor(from / step) * step,
    n = Math.max(1, Math.ceil((to - start) / step)),
    buckets = Array.from({ length: n }, () => [] as Sample[]);
  for (const row of rows) {
    if (row.ms >= from && row.ms < to)
      buckets[Math.floor((row.ms - start) / step)]?.push(row);
  }
  return buckets.map((items, i) => ({
    ...metrics(items),
    latencyP95: monitorDistribution(
      items
        .filter(
          (x) =>
            x.event.status_code > 0 &&
            x.event.status_code < 400 &&
            x.event.duration_ms > 0,
        )
        .map((x) => x.event.duration_ms),
    ).p95,
    ttftP50: monitorDistribution(
      items
        .filter(
          (x) =>
            x.event.status_code > 0 &&
            x.event.status_code < 400 &&
            x.detail?.is_stream &&
            valid(x.detail.time_to_first_token_ms),
        )
        .map((x) => x.detail!.time_to_first_token_ms!),
    ).p50,
    at: new Date(Math.max(from, start + i * step)).toISOString(),
  }));
}
const field = {
  models: "model",
  providers: "provider",
  clients: "client",
} as const;
function rank(
  rows: Sample[],
  dimension: MonitorDimension,
  from: number,
  to: number,
  step: number,
): MonitorRank[] {
  const groups = new Map<string, Sample[]>();
  for (const row of rows) {
    const key = row.event[field[dimension]] || "unknown";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, items]) => ({
      ...metrics(items),
      key,
      latencyP95: monitorDistribution(
        items
          .filter((x) => x.event.status_code > 0 && x.event.status_code < 400)
          .map((x) => x.event.duration_ms)
          .filter((n) => n > 0),
      ).p95,
      ttftP50: monitorDistribution(
        items
          .filter((x) => x.event.status_code > 0 && x.event.status_code < 400)
          .flatMap((x) =>
            x.detail?.is_stream && valid(x.detail.time_to_first_token_ms)
              ? [x.detail.time_to_first_token_ms]
              : [],
          ),
      ).p50,
      trend: points(items, from, to, step).map((x) => x.requests),
    }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}
export function readMonitorReport(
  db: BetterSqliteDatabase,
  logPath: string,
  raw: MonitorQuery,
  now = Date.now(),
): MonitorReport {
  const query = normalizeMonitorQuery(raw),
    window = monitorWindow(query, now),
    { from, to, previousFrom, previousTo, stepMs } = window;
  const earliest = Math.min(previousFrom, now - HOUR),
    iso = (ms: number) => new Date(ms).toISOString();
  // Never read request/response bodies or credentials for aggregate monitoring.
  const events = db
    .prepare(
      "SELECT id,created_at,request_id,client,provider,model,status_code,duration_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,path FROM usage_events WHERE created_at >= ? AND created_at < ? ORDER BY created_at,id",
    )
    .all(iso(earliest), iso(now)) as Event[];
  const byRequest = new Map<string, Detail>(),
    byUsage = new Map<number, Detail>();
  let logAvailable = false;
  if (existsSync(logPath)) {
    let logs: BetterSqliteDatabase | undefined;
    try {
      logs = createBetterSqliteDatabase(logPath, {
        readonly: true,
        fileMustExist: true,
      });
      // Prefer the latest completed/final entry; duplicates must not add TTFT samples.
      const details = logs
        .prepare(
          "SELECT id,request_id,source_usage_id,created_at,time_to_first_token_ms,stream_output_duration_ms,is_stream FROM request_logs WHERE created_at >= ? AND created_at < ? AND gateway_final_attempt = 1 ORDER BY id",
        )
        .all(iso(earliest), iso(now)) as Detail[];
      for (const d of details) {
        if (d.request_id) byRequest.set(d.request_id, d);
        if (d.source_usage_id != null) byUsage.set(d.source_usage_id, d);
      }
      logAvailable = true;
    } catch {
      /* Missing/old metadata remains unavailable, not zero. */
    } finally {
      logs?.close();
    }
  }
  const all: Sample[] = events.map((event) => ({
    event,
    ms: Date.parse(event.created_at),
    detail: byUsage.get(event.id) || byRequest.get(event.request_id),
  }));
  const dimensions = Object.keys(field) as MonitorDimension[];
  const selected = all.filter((row) =>
    dimensions.every(
      (d) =>
        !query[d]?.length ||
        query[d]!.includes(row.event[field[d]] || "unknown"),
    ),
  );
  const current = selected.filter((x) => x.ms >= from && x.ms < to),
    previous = selected.filter(
      (x) => x.ms >= previousFrom && x.ms < previousTo,
    );
  const options = Object.fromEntries(
    dimensions.map((d) => [
      d,
      [
        ...new Set(
          all
            .filter((x) => x.ms >= from)
            .map((x) => x.event[field[d]] || "unknown"),
        ),
      ].sort(),
    ]),
  ) as Record<MonitorDimension, string[]>;
  const rankings = Object.fromEntries(
    dimensions.map((d) => [d, rank(current, d, from, to, stepMs)]),
  ) as MonitorReport["rankings"];
  const total = (rows: Sample[]) =>
    monitorDistribution(
      rows
        .filter((x) => x.event.status_code > 0 && x.event.status_code < 400)
        .map((x) => x.event.duration_ms)
        .filter((n) => n > 0),
    );
  const first = (rows: Sample[]) =>
    monitorDistribution(
      rows
        .filter((x) => x.event.status_code > 0 && x.event.status_code < 400)
        .flatMap((x) =>
          x.detail?.is_stream && valid(x.detail.time_to_first_token_ms)
            ? [x.detail.time_to_first_token_ms]
            : [],
        ),
    );
  const failures = current.filter(
    (x) => x.event.status_code === 0 || x.event.status_code >= 400,
  );
  const status = new Map<number, number>();
  for (const { event } of failures)
    status.set(event.status_code, (status.get(event.status_code) || 0) + 1);
  const flows = new Map<string, MonitorReport["flows"][number]>();
  const heatmap = Array.from({ length: 168 }, (_, i) => ({
    weekday: Math.floor(i / 24),
    hour: i % 24,
    requests: 0,
    failed: 0,
  }));
  const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: query.timeZone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }),
    weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const row of current) {
    const e = row.event,
      key = JSON.stringify([e.client, e.model, e.provider]);
    const flow = flows.get(key) ?? {
      client: e.client || "unknown",
      model: e.model || "unknown",
      provider: e.provider || "unknown",
      requests: 0,
      tokens: 0,
    };
    flow.requests++;
    flow.tokens += e.total_tokens;
    flows.set(key, flow);
    const parts = formatter.formatToParts(row.ms),
      weekday = weekdays.indexOf(
        parts.find((p) => p.type === "weekday")!.value,
      ),
      hour = Number(parts.find((p) => p.type === "hour")!.value),
      cell = heatmap[weekday * 24 + hour];
    cell.requests++;
    if (e.status_code === 0 || e.status_code >= 400) cell.failed++;
  }
  const coverage = current.find(
    (x) => x.detail?.is_stream && valid(x.detail.time_to_first_token_ms),
  );
  return {
    generatedAt: iso(now),
    query,
    from: iso(from),
    to: iso(to),
    previousFrom: iso(previousFrom),
    previousTo: iso(previousTo),
    stepMs,
    current: metrics(current),
    previous: metrics(previous),
    series: points(current, from, to, stepMs),
    minutes: points(
      selected,
      Math.floor(now / 60000) * 60000 - 59 * 60000,
      now + 1,
      60000,
    ),
    latency: {
      bounds: MONITOR_BOUNDS,
      total: total(current),
      firstToken: first(current),
      previousTotal: total(previous),
      previousFirstToken: first(previous),
      coverageStart: coverage?.event.created_at ?? null,
    },
    rankings,
    options,
    failures: failures
      .slice(-50)
      .reverse()
      .map(({ event: e, detail: d }) => ({
        id: e.request_id || String(e.id),
        logId: d?.id ?? null,
        at: e.created_at,
        model: e.model,
        provider: e.provider,
        client: e.client,
        status: e.status_code,
        duration: e.duration_ms,
        path: e.path,
      })),
    failureStatuses: [...status]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    flows: [...flows.values()].sort((a, b) => b.requests - a.requests),
    heatmap,
    logAvailable,
  };
}
