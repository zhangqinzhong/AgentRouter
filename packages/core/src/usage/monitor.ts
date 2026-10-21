import { existsSync } from "node:fs";
import {
  createBetterSqliteDatabase,
  type BetterSqliteDatabase,
} from "../storage/sqlite-native";
import type { GatewayMonitor } from "../contracts/app";

// Nearest-rank percentiles over every observed duration, not averages of buckets.
export function weightedPercentile(
  rows: Array<{ value: number; count: number }>,
  fraction: number,
): number | null {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil(total * fraction));
  let seen = 0;
  for (const row of rows) {
    seen += row.count;
    if (seen >= rank) return row.value;
  }
  return null;
}
export function readGatewayMonitor(
  db: BetterSqliteDatabase,
  query: { where: string; params: any[] },
  from: Date,
  to: Date,
  logPath: string,
): GatewayMonitor {
  const durations = db
    .prepare(
      `SELECT duration_ms AS value, COUNT(*) AS count FROM usage_events WHERE ${query.where} AND duration_ms > 0 GROUP BY duration_ms ORDER BY duration_ms`,
    )
    .all(...query.params) as Array<{ value: number; count: number }>;
  const now = Date.now();
  const minuteStart = Math.floor(now / 60000) * 60000;
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:00.000Z', created_at) AS bucket, COUNT(*) AS requests, SUM(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END) AS errors, SUM(total_tokens) AS tokens, SUM(duration_ms) AS durationMs FROM usage_events WHERE created_at >= ? AND created_at <= ? GROUP BY bucket`,
    )
    .all(
      new Date(minuteStart - 59 * 60000).toISOString(),
      new Date(now).toISOString(),
    ) as GatewayMonitor["minutes"];
  const byMinute = new Map(rows.map((row) => [row.bucket, row]));
  const minutes = Array.from({ length: 60 }, (_, i) => {
    const bucket = new Date(minuteStart - (59 - i) * 60000).toISOString();
    return (
      byMinute.get(bucket) ?? {
        bucket,
        requests: 0,
        errors: 0,
        tokens: 0,
        durationMs: 0,
      }
    );
  });
  const failures = db
    .prepare(
      `SELECT request_id AS id, created_at AS at, provider, model, status_code AS status FROM usage_events WHERE ${query.where} AND (status_code >= 400 OR status_code = 0) ORDER BY created_at DESC LIMIT 8`,
    )
    .all(...query.params) as GatewayMonitor["failures"];
  let ttft: Array<{ value: number; count: number }> = [];
  // Request logs can be disabled or retained for less time than usage totals.
  // Only report measured samples; never infer first-token latency from total duration.
  if (existsSync(logPath)) {
    let logs: BetterSqliteDatabase | undefined;
    try {
      logs = createBetterSqliteDatabase(logPath, {
        readonly: true,
        fileMustExist: true,
      });
      ttft = logs
        .prepare(
          `SELECT time_to_first_token_ms AS value, COUNT(*) AS count FROM request_logs WHERE created_at >= ? AND created_at < ? AND time_to_first_token_ms > 0 GROUP BY time_to_first_token_ms ORDER BY time_to_first_token_ms`,
        )
        .all(from.toISOString(), to.toISOString()) as typeof ttft;
    } catch {
      /* Old log schemas have no measured TTFT. */
    } finally {
      logs?.close();
    }
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    latencyP50Ms: weightedPercentile(durations, 0.5),
    latencyP95Ms: weightedPercentile(durations, 0.95),
    ttftP50Ms: weightedPercentile(ttft, 0.5),
    ttftP95Ms: weightedPercentile(ttft, 0.95),
    ttftSamples: ttft.reduce((s, r) => s + r.count, 0),
    minutes,
    failures,
  };
}
