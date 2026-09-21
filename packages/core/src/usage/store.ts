import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeClaudeAppGatewayRouteId } from "@agentrouter/core/agents/claude-app/gateway-routes";
import { getLocalUsageOverview, LOCAL_OVERVIEW_SOURCE_KEYS, type LocalUsageOverviewData, type LocalUsageRange } from "@agentrouter/core/collector/usage-page";
import { REQUEST_LOGS_DB_FILE, USAGE_DB_FILE } from "@agentrouter/core/config/constants";
import { estimateUsageCostUsd, providerModelPricingForUsage } from "@agentrouter/core/models/pricing-service";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@agentrouter/core/storage/sqlite-native";
import { normalizeUsageInputTokens } from "@agentrouter/core/usage/normalization";
import { resolveUsageModelAttribution } from "@agentrouter/core/usage/model-attribution";
import type {
  AppConfig,
  GatewayProviderProtocol,
  ProviderModelPricing,
  UsageComparisonRow,
  UsageDateRange,
  UsageStatsFilter,
  UsageSeriesPoint,
  UsageStatsRange,
  UsageStatsResetResult,
  UsageStatsSnapshot,
  UsageTotals
} from "@agentrouter/core/contracts/app";

type SqlDatabase = BetterSqliteDatabase;
type SqlValue = bigint | Buffer | number | string | null;

type UsageNumbers = {
  cacheReadTokens?: number;
  cacheWrite1hTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWriteTokens?: number;
  inputIncludesCacheTokens?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type UsageEventInput = {
  client?: string;
  costSource?: string;
  costUsd?: number;
  createdAt?: string;
  credentialId?: string;
  durationMs: number;
  logicalModel?: string;
  method: string;
  model?: string;
  modelIsRouteSelector?: boolean;
  path: string;
  provider?: string;
  pricing?: ProviderModelPricing;
  requestId?: string;
  statusCode: number;
  usage?: UsageNumbers;
};

export type UsageCaptureInput = {
  bodyText: string;
  client?: string;
  config?: Pick<AppConfig, "Providers" | "virtualModelProfiles">;
  durationMs: number;
  fallbackModel?: string;
  method: string;
  path: string;
  providerName?: string;
  providerProtocol?: GatewayProviderProtocol;
  requestId?: string;
  responseHeaders: Headers;
  statusCode: number;
};

type UsageStatsQueryOptions = {
  includeProxy?: boolean;
};

type UsageStoreOptions = {
  estimateCost?: typeof estimateUsageCostUsd;
  requestLogDbFile?: string;
};

type UsageWhereClause = {
  params: SqlValue[];
  where: string;
};

type StoredUsageEvent = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  client: string;
  costSource: string;
  costUsd: number;
  createdAt: string;
  credentialId: string;
  durationMs: number;
  id: number;
  inputTokens: number;
  logicalModel: string;
  method: string;
  model: string;
  outputTokens: number;
  path: string;
  provider: string;
  requestId: string;
  statusCode: number;
  totalTokens: number;
};

type UsageSnapshot = UsageNumbers & {
  model?: string;
};

const usageEvents = new EventEmitter();
const usageStatsRanges = new Set<UsageStatsRange>(["today", "24h", "7d", "30d", "all", "custom"]);
// Hard ceiling for the "all" trend template so a corrupt earliest row can never
// generate an unbounded bucket walk.
const allTimeMaxBuckets = 730;
// The system-status strips always cover this many trailing days, independent of
// the selected usage range; UI tick geometry mirrors this constant.
const providerStatusDays = 90;
const customRangeDayLimit = 366;
const usageStatsResetAtKey = "usage_stats_reset_at";
const localOverviewCacheTtlMs = 30_000;
const localOverviewSources = new Map<string, string>([
  ["acode", "AStudio"],
  ["every-code", "Every Code"],
  ["openclaw", "OpenClaw"],
  ["lmstudio", "LM Studio"],
  ["cursor", "Cursor"],
  ["antigravity", "Antigravity"],
  ["qoder", "Qoder"],
  ["qoder-cn", "Qoder CN"],
  ["claude-science", "Claude Science"],
  ["kiro", "Kiro"],
  ["kiro-cli", "Kiro CLI"],
  ["hermes", "Hermes"],
  ["kimi", "Kimi"],
  ["kimi-code", "Kimi Code"],
  ["codebuddy", "CodeBuddy"],
  ["workbuddy", "WorkBuddy"],
  ["omp", "oh-my-pi"],
  ["pi", "pi"],
  ["prime-agent", "Prime Agent"],
  ["craft", "Craft"],
  ["reasonix", "Reasonix"],
  ["kilocode", "Kilo Code"],
  ["roocode", "Roo Code"],
  ["zed", "Zed"],
  ["unsloth", "Unsloth"],
  ["anythingllm", "AnythingLLM"],
  ["devin", "Devin"],
  ["goose", "Goose"],
  ["droid", "Droid"],
  ["dsh", "DeepSeek Harness"],
  ["copilot", "GitHub Copilot"],
  ["mimo", "MiMo"],
  ["zcode", "ZCode"]
]);
const localOverviewSourceKeys = new Set<string>(LOCAL_OVERVIEW_SOURCE_KEYS);
let localOverviewCache: {
  expiresAt: number;
  key: string;
  value: LocalUsageOverviewData;
} | undefined;
const emptyTotals: UsageTotals = {
  avgDurationMs: 0,
  cacheRatio: 0,
  cacheTokens: 0,
  costUsd: 0,
  errorCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  successRate: 0,
  totalTokens: 0
};

export class UsageStore {
  private database?: SqlDatabase;
  private readonly estimateCost: typeof estimateUsageCostUsd;
  private initPromise?: Promise<SqlDatabase>;
  private readonly requestLogDbFile?: string;
  private requestLogBackfillFailureLogged = false;

  constructor(private readonly dbFile: string, options: UsageStoreOptions = {}) {
    this.estimateCost = options.estimateCost ?? estimateUsageCostUsd;
    this.requestLogDbFile = options.requestLogDbFile;
  }

  async record(event: UsageEventInput): Promise<void> {
    const database = await this.getDatabase();
    const usage = event.usage ?? {};
    const inputTokens = normalizeCount(usage.inputTokens);
    const outputTokens = normalizeCount(usage.outputTokens);
    const cacheReadTokens = normalizeCount(usage.cacheReadTokens);
    const cacheWrite1hTokens = normalizeCount(usage.cacheWrite1hTokens);
    const cacheWrite5mTokens = normalizeCount(usage.cacheWrite5mTokens);
    const cacheWriteTokens = normalizeCount(usage.cacheWriteTokens);
    const cacheTokens = cacheReadTokens + cacheWriteTokens;
    const totalTokens = normalizeCount(usage.totalTokens) || inputTokens + outputTokens + cacheTokens;
    const route = event.modelIsRouteSelector === false ? {} : splitRouteSelector(event.model);
    const model = normalizeLabel(route.model ?? event.model, "unknown");
    const provider = normalizeLabel(event.provider ?? route.provider, "unknown");
    const logicalModel = normalizeLabel(event.logicalModel ?? event.model, model);
    const credentialId = normalizeLabel(event.credentialId, "");
    const explicitCost = normalizeOptionalCost(event.costUsd);
    const estimatedCost = explicitCost === undefined
      ? await this.estimateCost({
          cacheReadTokens,
          cacheWrite1hTokens,
          cacheWrite5mTokens,
          cacheWriteTokens,
          inputTokens,
          model,
          outputTokens,
          pricing: event.pricing,
          provider
        })
      : undefined;
    const costUsd = explicitCost ?? estimatedCost?.amountUsd;
    const costSource = explicitCost === undefined
      ? estimatedCost?.source ?? ""
      : normalizeLabel(event.costSource, "gateway_billing");

    const statement = database.prepare(`
      INSERT INTO usage_events (
        created_at,
        request_id,
        client,
        method,
        path,
        model,
        logical_model,
        provider,
        credential_id,
        status_code,
        duration_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_usd,
        cost_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      event.createdAt ?? new Date().toISOString(),
      event.requestId ?? "",
      normalizeLabel(event.client, "unknown"),
      event.method,
      event.path,
      model,
      logicalModel,
      provider,
      credentialId,
      normalizeCount(event.statusCode),
      normalizeCount(event.durationMs),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd ?? null,
      costSource
    );
    usageEvents.emit("recorded");
  }

  async recordCapture(input: UsageCaptureInput): Promise<void> {
    const headersUsage = extractUsageFromBillingHeaders(input.responseHeaders);
    const bodyUsage = extractUsageFromBody(input.bodyText);
    // Normalize each source under its own convention before merging them: on a
    // translated response the billing headers and the body state input tokens
    // differently, and one shared rule is wrong for one of them.
    const usage = mergeUsageSnapshots(
      normalizeUsageInputTokens(headersUsage, {
        path: input.path,
        providerProtocol: input.providerProtocol,
        source: "providerBilling"
      }),
      normalizeUsageInputTokens(bodyUsage, {
        path: input.path,
        source: "responseBody"
      })
    );
    const fallbackAttribution = resolveUsageModelAttribution(input.config, input.fallbackModel);
    const responseAttribution = resolveUsageResponseModelAttribution(input.config, bodyUsage?.model);
    const route = splitRouteSelector(input.fallbackModel);
    const provider =
      input.providerName ??
      readHeader(input.responseHeaders, "x-gateway-target-provider-name") ??
      readHeader(input.responseHeaders, "x-gateway-target-provider") ??
      responseAttribution.provider ??
      fallbackAttribution.provider ??
      route.provider;
    const model = responseAttribution.model ?? fallbackAttribution.model ?? route.model ?? input.fallbackModel;

    await this.record({
      durationMs: input.durationMs,
      method: input.method,
      logicalModel: fallbackAttribution.logicalModel ?? input.fallbackModel,
      model,
      modelIsRouteSelector: false,
      path: input.path,
      client: input.client,
      provider,
      pricing: providerModelPricingForUsage(input.config, provider, model),
      credentialId: readCredentialId(input.responseHeaders),
      requestId: input.requestId,
      statusCode: input.statusCode,
      usage
    });
  }

  async hasRequestId(requestId: string): Promise<boolean> {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return false;
    }
    const database = await this.getDatabase();
    return queryRows(
      database,
      "SELECT 1 FROM usage_events WHERE request_id = ? LIMIT 1",
      [normalizedRequestId]
    ).length > 0;
  }

  async getStats(
    range: UsageStatsRange | null | undefined = "7d",
    filter: UsageStatsFilter | null | undefined = {},
    customRange?: UsageDateRange | null
  ): Promise<UsageStatsSnapshot> {
    const database = await this.getDatabase();
    const now = new Date();
    const custom = parseUsageDateRange(customRange);
    let normalizedRange = normalizeUsageRange(range);
    if (normalizedRange === "custom" && !custom) {
      normalizedRange = "7d";
    }
    const since = custom && normalizedRange === "custom" ? custom.since : getRangeSince(normalizedRange, now);
    const statusSince = floorDay(new Date(now));
    statusSince.setDate(statusSince.getDate() - (providerStatusDays - 1));
    this.backfillFromRequestLogs(database, statusSince < since ? statusSince : since);
    const query = buildUsageWhereClause(since, filter);
    if (custom && normalizedRange === "custom") {
      query.where += " AND created_at < ?";
      query.params.push(custom.until.toISOString());
    }
    // System status reads a fixed trailing window so its ticks never follow the
    // selected usage range (custom windows included).
    const statusQuery = buildUsageWhereClause(statusSince, filter);

    return {
      clientModels: readClientModelRows(database, query),
      generatedAt: now.toISOString(),
      models: readModelRows(database, query),
      providerModels: readProviderModelRows(database, query),
      range: normalizedRange,
      recentRequests: readRecentRequestRows(database, query),
      series: readUsageSeries(
        database,
        normalizedRange,
        now,
        query,
        custom && normalizedRange === "custom"
          ? buildDayBuckets(custom.days, now, custom.since)
          : normalizedRange === "all"
            ? buildAllTimeBuckets(database, now)
            : undefined
      ),
      providerSeries: readProviderUsageSeries(database, now, statusQuery),
      totals: readUsageTotals(database, query)
    };
  }

  async getNativeMenuUsage(from: string, to: string, unit: "day" | "hour" | "month" = "day", filter: UsageStatsFilter = {}) {
    if (![from, to].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) throw new Error("Invalid date range");
    const since = new Date(`${from}T00:00:00`);
    const until = new Date(`${to}T00:00:00`); until.setDate(until.getDate() + 1);
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) throw new Error("Invalid date range");
    const database = await this.getDatabase();
    const query = buildUsageWhereClause(since, filter);
    query.where += " AND created_at < ?"; query.params.push(until.toISOString());
    const format = unit === "hour" ? "%Y-%m-%dT%H:00:00" : unit === "month" ? "%Y-%m" : "%Y-%m-%d";
    const series = queryRows(database, `SELECT strftime('${format}', created_at, 'localtime') AS bucket,
      SUM(total_tokens) AS total_tokens, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cached_input_tokens, SUM(cache_write_tokens) AS cache_creation_input_tokens,
      SUM(COALESCE(cost_usd, 0)) AS total_cost_usd FROM usage_events WHERE ${query.where} GROUP BY bucket ORDER BY bucket LIMIT 12000`, query.params);
    const active = queryRows(database, `SELECT COUNT(DISTINCT strftime('%Y-%m-%d', created_at, 'localtime')) AS days FROM usage_events WHERE ${query.where} AND total_tokens > 0`, query.params)[0];
    return { totals: readUsageTotals(database, query), models: readClientModelRows(database, query), series, activeDays: Number(active?.days) || 0 };
  }

  async getActivitySeries(days = 182, filter: UsageStatsFilter = {}): Promise<Array<{ bucket: string; totalTokens: number }>> {
    const count = Math.min(366, Math.max(1, Math.floor(days) || 182));
    const start = floorDay(new Date());
    start.setDate(start.getDate() - count + 1);
    const database = await this.getDatabase();
    const query = buildUsageWhereClause(start, filter);
    const rows = queryRows(database, `SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS day, SUM(total_tokens) AS tokens FROM usage_events WHERE ${query.where} GROUP BY day`, query.params);
    const totals = new Map(rows.map((row) => [String(row.day), Number(row.tokens) || 0]));
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start); date.setDate(start.getDate() + index);
      const bucket = formatBucketKey(date, "day");
      return { bucket, totalTokens: totals.get(bucket) ?? 0 };
    });
  }

  async getTotalsSince(since: Date, filter: UsageStatsFilter | null | undefined = {}, options: UsageStatsQueryOptions | null | undefined = {}): Promise<UsageTotals> {
    const database = await this.getDatabase();
    this.backfillFromRequestLogs(database, since);
    return readUsageTotals(database, buildUsageWhereClause(since, filter, options));
  }

  async resetStatistics(): Promise<UsageStatsResetResult> {
    const database = await this.getDatabase();
    const resetAt = new Date().toISOString();
    let deletedEvents = 0;

    database.transaction(() => {
      const result = database.prepare("DELETE FROM usage_events").run();
      deletedEvents = Number(result.changes);
      database.prepare(`
        INSERT INTO usage_metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(usageStatsResetAtKey, resetAt);
    })();

    usageEvents.emit("recorded");
    return { deletedEvents, resetAt };
  }

  private async getDatabase(): Promise<SqlDatabase> {
    if (this.database) {
      return this.database;
    }

    this.initPromise ??= this.open();
    return this.initPromise;
  }

  private async open(): Promise<SqlDatabase> {
    mkdirSync(dirname(this.dbFile), { recursive: true });
    const database = createBetterSqliteDatabase(this.dbFile);
    configureSqliteDatabase(database);

    database.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT 'unknown',
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        logical_model TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'unknown',
        credential_id TEXT NOT NULL DEFAULT '',
        status_code INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_source TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(model);
      CREATE INDEX IF NOT EXISTS usage_events_path_idx ON usage_events(path);
      CREATE INDEX IF NOT EXISTS usage_events_request_id_idx ON usage_events(request_id);
      CREATE TABLE IF NOT EXISTS usage_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ensureUsageSchema(database);

    this.database = database;
    return database;
  }

  private backfillFromRequestLogs(database: SqlDatabase, since: Date): void {
    const requestLogDbFile = this.requestLogDbFile;
    if (!requestLogDbFile || !existsSync(requestLogDbFile)) {
      return;
    }
    const backfillSince = usageBackfillSinceAfterReset(database, since);

    let tempRequestLogDbFile: string | undefined;
    try {
      try {
        this.backfillFromAttachedRequestLog(database, requestLogDbFile, backfillSince);
      } catch {
        tempRequestLogDbFile = copySqliteDatabaseToTemp(requestLogDbFile);
        this.backfillFromAttachedRequestLog(database, tempRequestLogDbFile, backfillSince);
      }
      this.requestLogBackfillFailureLogged = false;
    } catch (error) {
      if (!this.requestLogBackfillFailureLogged) {
        console.warn(`[usage] Failed to backfill usage from request logs: ${formatError(error)}`);
        this.requestLogBackfillFailureLogged = true;
      }
    } finally {
      if (tempRequestLogDbFile) {
        cleanupSqliteTempCopy(tempRequestLogDbFile);
      }
    }
  }

  private backfillFromAttachedRequestLog(database: SqlDatabase, requestLogDbFile: string, since: Date): void {
    database.exec(`ATTACH DATABASE ${sqlString(requestLogDbFile)} AS request_log_source`);
    try {
      database.prepare(`
          INSERT INTO usage_events (
            created_at,
            request_id,
            client,
            method,
            path,
            model,
            logical_model,
            provider,
            credential_id,
            status_code,
            duration_ms,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            cost_usd,
            cost_source
          )
          SELECT
            logs.created_at,
            logs.request_id,
            logs.client,
            logs.method,
            logs.path,
            logs.model,
            logs.model,
            logs.provider,
            logs.credential_id,
            logs.status_code,
            logs.duration_ms,
            logs.input_tokens,
            logs.output_tokens,
            logs.cache_read_tokens,
            logs.cache_write_tokens,
            logs.total_tokens,
            logs.cost_usd,
            'request_log'
          FROM request_log_source.request_logs AS logs
          WHERE logs.source_usage_id IS NULL
            AND logs.path NOT LIKE ?
            AND logs.created_at >= ?
            AND NOT EXISTS (
              SELECT 1
              FROM usage_events AS existing
              WHERE (
                logs.request_id <> ''
                AND existing.request_id = logs.request_id
              ) OR (
                logs.request_id = ''
                AND existing.created_at = logs.created_at
                AND existing.path = logs.path
                AND existing.model = logs.model
              )
            )
        `).run("%/count_tokens%", since.toISOString());
    } finally {
      database.exec("DETACH DATABASE request_log_source");
    }
  }
}

export const usageStore = new UsageStore(USAGE_DB_FILE, { requestLogDbFile: REQUEST_LOGS_DB_FILE });

export function onUsageRecorded(listener: () => void): () => void {
  usageEvents.on("recorded", listener);
  return () => {
    usageEvents.off("recorded", listener);
  };
}

function ensureUsageSchema(database: SqlDatabase): void {
  const columns = new Set(
    queryRows(database, "PRAGMA table_info(usage_events)")
      .map((row) => String(row.name ?? ""))
      .filter(Boolean)
  );

  if (!columns.has("client")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN client TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!columns.has("cost_usd")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN cost_usd REAL");
  }
  if (!columns.has("cost_source")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN cost_source TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("logical_model")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN logical_model TEXT NOT NULL DEFAULT ''");
    database.exec("UPDATE usage_events SET logical_model = model WHERE logical_model = ''");
  }
  if (!columns.has("credential_id")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN credential_id TEXT NOT NULL DEFAULT ''");
  }
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_client_idx ON usage_events(client)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events(created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_credential_id_idx ON usage_events(credential_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(model)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_path_idx ON usage_events(path)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_request_id_idx ON usage_events(request_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_created_filter_idx ON usage_events(created_at, provider, model, credential_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_provider_created_at_idx ON usage_events(provider, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_model_created_at_idx ON usage_events(model, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_credential_created_at_idx ON usage_events(credential_id, created_at)");
}

export async function getUsageStats(
  range?: UsageStatsRange | null,
  filter?: UsageStatsFilter | null,
  customRange?: UsageDateRange | null
): Promise<UsageStatsSnapshot> {
  try {
    const snapshot = await usageStore.getStats(range, filter, customRange);
    try {
      const normalizedRange = normalizeUsageRange(range);
      const now = new Date();
      const localRange = localOverviewRange(normalizedRange, customRange, now);
      const local = await getCachedLocalUsageOverview(localRange.range, localRange.period);
      return mergeLocalOverviewSnapshot(snapshot, local, filter);
    } catch (error) {
      console.warn(`[usage] Failed to merge local usage into overview: ${formatError(error)}`);
      return snapshot;
    }
  } catch (error) {
    console.warn(`[usage] Failed to read usage stats: ${formatError(error)}`);
    return emptySnapshot(normalizeUsageRange(range));
  }
}

async function getCachedLocalUsageOverview(range: LocalUsageRange, period: "day" | "hour"): Promise<LocalUsageOverviewData> {
  const key = JSON.stringify({ period, range });
  const now = Date.now();
  if (localOverviewCache?.key === key && localOverviewCache.expiresAt > now) {
    return localOverviewCache.value;
  }
  const value = await getLocalUsageOverview(range, period);
  localOverviewCache = { expiresAt: now + localOverviewCacheTtlMs, key, value };
  return value;
}

function localOverviewRange(
  range: UsageStatsRange,
  customRange: UsageDateRange | null | undefined,
  now: Date
): { period: "day" | "hour"; range: LocalUsageRange } {
  const day = (value: Date) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const date = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${date}`;
  };
  const to = day(now);
  if (range === "custom" && customRange) {
    return { period: "day", range: { from: customRange.from, to: customRange.to } };
  }
  if (range === "all") {
    // Empty from = the collector aggregates from the beginning of local history.
    return { period: "day", range: { from: "", to } };
  }
  if (range === "today" || range === "24h") {
    const from = new Date(now);
    from.setMinutes(0, 0, 0);
    if (range === "24h") {
      from.setHours(from.getHours() - 23);
    }
    return { period: "hour", range: { from: day(from), to } };
  }
  const days = range === "30d" ? 30 : 7;
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { period: "day", range: { from: day(from), to } };
}

function localOverviewFilterMatches(source: string, model: string, filter: UsageStatsFilter | null | undefined): boolean {
  const provider = typeof filter?.provider === "string" ? filter.provider.trim().toLowerCase() : "";
  const requestedModel = typeof filter?.model === "string" ? filter.model.trim() : "";
  const sourceLabel = localOverviewSources.get(source) ?? source;
  if (provider && provider !== source && provider !== sourceLabel.toLowerCase()) {
    return false;
  }
  return !requestedModel || requestedModel === model;
}

function localTotalsToUsageTotals(totals: Record<string, unknown>): UsageTotals {
  const inputTokens = normalizeCount(totals.input_tokens);
  const outputTokens = normalizeCount(totals.output_tokens);
  const cacheTokens = normalizeCount(totals.cached_input_tokens) + normalizeCount(totals.cache_creation_input_tokens);
  const requestCount = normalizeCount(totals.conversation_count ?? totals.request_count);
  const totalTokens = normalizeCount(totals.total_tokens);
  return {
    ...emptyTotals,
    avgDurationMs: 0,
    cacheRatio: inputTokens + cacheTokens > 0 ? cacheTokens / (inputTokens + cacheTokens) : 0,
    cacheTokens,
    costUsd: normalizeCost(totals.total_cost_usd),
    inputTokens,
    outputTokens,
    requestCount,
    successRate: requestCount > 0 ? 1 : 0,
    totalTokens
  };
}

function localSeriesToUsagePoint(row: Record<string, unknown>, period: "day" | "hour"): UsageSeriesPoint | undefined {
  const rawBucket = String(row.day ?? row.hour ?? "").trim();
  if (!rawBucket) {
    return undefined;
  }
  const bucket = period === "hour"
    ? rawBucket.replace("T", " ").replace(/:00:00$/, ":00")
    : rawBucket;
  const totals = localTotalsToUsageTotals(row);
  return {
    ...totals,
    bucket,
    label: period === "hour" ? bucket.slice(11, 16) : `${Number(bucket.slice(5, 7))}/${Number(bucket.slice(8, 10))}`
  };
}

function mergeLocalUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const total = left.requestCount + right.requestCount;
  const cacheTokens = left.cacheTokens + right.cacheTokens;
  const inputTokens = left.inputTokens + right.inputTokens;
  return {
    ...left,
    avgDurationMs: total > 0
      ? Math.round((left.avgDurationMs * left.requestCount + right.avgDurationMs * right.requestCount) / total)
      : 0,
    cacheRatio: inputTokens + cacheTokens > 0 ? cacheTokens / (inputTokens + cacheTokens) : 0,
    cacheTokens,
    costUsd: left.costUsd + right.costUsd,
    errorCount: left.errorCount + right.errorCount,
    inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    requestCount: total,
    successRate: total > 0 ? (total - left.errorCount - right.errorCount) / total : 0,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function localComparisonRow(
  source: string,
  model: string,
  totals: Record<string, unknown>
): UsageComparisonRow {
  const provider = localOverviewSources.get(source) ?? source;
  return {
    ...localTotalsToUsageTotals(totals),
    caption: `${provider} / local session`,
    key: `local:${source}:${model}`,
    label: model,
    maxShare: 0,
    model,
    provider
  };
}

function localClientComparisonRow(
  source: string,
  model: string,
  totals: Record<string, unknown>
): UsageComparisonRow {
  const provider = localOverviewSources.get(source) ?? source;
  return {
    ...localTotalsToUsageTotals(totals),
    caption: `${provider} / ${model}`,
    client: provider,
    key: `local-client:${source}:${model}`,
    label: provider,
    maxShare: 0,
    model,
    provider
  };
}

export function mergeLocalOverviewSnapshot(
  snapshot: UsageStatsSnapshot,
  local: LocalUsageOverviewData,
  filter: UsageStatsFilter | null | undefined
): UsageStatsSnapshot {
  const localRows: UsageComparisonRow[] = [];
  const localClientRows: UsageComparisonRow[] = [];
  for (const entry of local.sources) {
    const source = String(entry.source ?? "").trim().toLowerCase();
    if (!localOverviewSources.has(source) || !localOverviewSourceKeys.has(source)) {
      continue;
    }
    for (const model of (Array.isArray(entry.models) ? entry.models : []) as Array<Record<string, unknown>>) {
      const modelName = String(model?.model ?? model?.model_id ?? "").trim();
      if (modelName && localOverviewFilterMatches(source, modelName, filter)) {
        const totals = (model.totals ?? {}) as Record<string, unknown>;
        localRows.push(localComparisonRow(source, modelName, totals));
        localClientRows.push(localClientComparisonRow(source, modelName, totals));
      }
    }
  }
  if (localRows.length === 0) {
    return snapshot;
  }

  const localTotals = localRows.reduce(
    (total, row) => mergeLocalUsageTotals(total, row),
    { ...emptyTotals }
  );
  const localModelsByKey = new Map<string, UsageComparisonRow>();
  for (const row of localRows) {
    const key = `${row.provider ?? ""}::${row.model ?? row.label}`;
    const previous = localModelsByKey.get(key);
    localModelsByKey.set(key, previous ? {
      ...previous,
      ...mergeLocalUsageTotals(previous, row),
      key: previous.key,
      label: previous.label,
      model: previous.model,
      provider: previous.provider
    } : row);
  }
  const localProviderRows = [...localModelsByKey.values()].map((row) => ({
    ...row,
    key: `local-provider:${row.provider ?? row.label}:${row.model ?? row.label}`,
    label: row.provider ?? row.label,
    caption: row.model ?? row.label
  }));
  // Day-grain rows outside the snapshot template are kept: bounded day ranges
  // query the same window on both sides, and "all" local history can predate
  // the first gateway event, so those earlier days must survive the merge (the
  // daily endpoint only returns active days, so there is no zero-bucket flood).
  // Hour-grain rows stay template-bound: the local query covers whole calendar
  // days, which is wider than the rolling today/24h windows.
  const hourly = local.series.some((item) => item.hour);
  const localSeries = local.series
    .map((row) => localSeriesToUsagePoint(row, hourly ? "hour" : "day"))
    .filter((row): row is UsageSeriesPoint => Boolean(row))
    .filter((row) => !hourly || snapshot.series.some((point) => point.bucket === row.bucket));
  const seriesByBucket = new Map(snapshot.series.map((row) => [row.bucket, row]));
  for (const row of localSeries) {
    const existing = seriesByBucket.get(row.bucket);
    seriesByBucket.set(row.bucket, existing ? { ...mergeLocalUsageTotals(existing, row), bucket: existing.bucket, label: existing.label } : row);
  }

  return {
    ...snapshot,
    clientModels: [...snapshot.clientModels, ...localClientRows],
    models: [...snapshot.models, ...localRows],
    providerModels: [...snapshot.providerModels, ...localProviderRows],
    series: [...seriesByBucket.values()].sort((left, right) => left.bucket.localeCompare(right.bucket)),
    totals: mergeLocalUsageTotals(snapshot.totals, localTotals)
  };
}

export async function resetOverviewStatistics(): Promise<UsageStatsResetResult> {
  try {
    return await usageStore.resetStatistics();
  } catch (error) {
    console.warn(`[usage] Failed to reset overview statistics: ${formatError(error)}`);
    throw error;
  }
}

export async function getTodayUsageTotals(filter?: UsageStatsFilter | null, options?: UsageStatsQueryOptions | null): Promise<UsageTotals> {
  try {
    return await usageStore.getTotalsSince(floorDay(new Date()), filter, options);
  } catch (error) {
    console.warn(`[usage] Failed to read today's usage totals: ${formatError(error)}`);
    return { ...emptyTotals };
  }
}

export async function getUsageTotalsSince(since: Date, filter?: UsageStatsFilter | null, options?: UsageStatsQueryOptions | null): Promise<UsageTotals> {
  try {
    return await usageStore.getTotalsSince(since, filter, options);
  } catch (error) {
    console.warn(`[usage] Failed to read usage totals: ${formatError(error)}`);
    return { ...emptyTotals };
  }
}

export async function recordGatewayUsageCapture(input: UsageCaptureInput): Promise<void> {
  try {
    await usageStore.recordCapture(input);
  } catch (error) {
    console.warn(`[usage] Failed to record usage: ${formatError(error)}`);
  }
}

export async function recordGatewayUsageCaptureIfMissing(input: UsageCaptureInput): Promise<void> {
  try {
    const requestId = input.requestId?.trim();
    if (requestId && await usageStore.hasRequestId(requestId)) {
      return;
    }
    await usageStore.recordCapture(input);
  } catch (error) {
    console.warn(`[usage] Failed to record usage: ${formatError(error)}`);
  }
}

function resolveUsageResponseModelAttribution(
  config: Pick<AppConfig, "Providers" | "virtualModelProfiles"> | undefined,
  model: string | undefined
) {
  const decodedClaudeRouteModel = model ? decodeClaudeAppGatewayRouteId(model) : undefined;
  if (decodedClaudeRouteModel) {
    const attribution = resolveUsageModelAttribution(config, decodedClaudeRouteModel);
    return !config || attribution.provider ? attribution : {};
  }
  return resolveUsageModelAttribution(config, model, { physicalModel: true });
}

function buildUsageWhereClause(
  since: Date,
  filter: UsageStatsFilter | null | undefined,
  options: UsageStatsQueryOptions | null | undefined = {}
): UsageWhereClause {
  const normalizedFilter = normalizeUsageFilter(filter);
  const normalizedOptions = normalizeUsageQueryOptions(options);
  const where = ["created_at >= ?"];
  const params: SqlValue[] = [since.toISOString()];
  const credential = normalizeFilterValue(normalizedFilter.credential);
  const provider = normalizeFilterValue(normalizedFilter.provider);
  const model = normalizeFilterValue(normalizedFilter.model);

  if (provider) {
    // Stored provider keys are compound ("providerId::connector" or with a trailing
    // credential segment); match the bare id and every compound form of it.
    where.push("(provider = ? OR provider LIKE ? ESCAPE '\\')");
    params.push(provider, `${escapeSqlLike(provider)}::%`);
  } else if (!normalizedOptions.includeProxy && normalizedFilter.includeProxy !== true) {
    where.push("provider <> ?");
    params.push("proxy");
  }
  if (model) {
    where.push("model = ?");
    params.push(model);
  }
  if (credential) {
    where.push("credential_id = ?");
    params.push(credential);
  }

  return {
    params,
    where: where.join(" AND ")
  };
}

function normalizeUsageRange(range: UsageStatsRange | null | undefined): UsageStatsRange {
  return range && usageStatsRanges.has(range) ? range : "7d";
}

// Validates a "custom" usage range; until is exclusive (to + 1 day).
function parseUsageDateRange(custom: UsageDateRange | null | undefined): { since: Date; until: Date; days: number } | undefined {
  if (!isRecord(custom)) {
    return undefined;
  }
  const from = typeof custom.from === "string" ? custom.from.trim() : "";
  const to = typeof custom.to === "string" ? custom.to.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return undefined;
  }
  const since = new Date(`${from}T00:00:00`);
  const until = new Date(`${to}T00:00:00`);
  until.setDate(until.getDate() + 1);
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) {
    return undefined;
  }
  const days = Math.min(customRangeDayLimit, Math.round((until.getTime() - since.getTime()) / 86_400_000));
  return { since, until, days };
}

function normalizeUsageFilter(filter: UsageStatsFilter | null | undefined): UsageStatsFilter {
  if (!isRecord(filter)) {
    return {};
  }
  return {
    credential: typeof filter.credential === "string" ? filter.credential : undefined,
    includeProxy: filter.includeProxy === true,
    model: typeof filter.model === "string" ? filter.model : undefined,
    provider: typeof filter.provider === "string" ? filter.provider : undefined
  };
}

function normalizeUsageQueryOptions(options: UsageStatsQueryOptions | null | undefined): UsageStatsQueryOptions {
  return isRecord(options) && options.includeProxy === true ? { includeProxy: true } : {};
}

function configureSqliteDatabase(database: SqlDatabase): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
}

function queryRows(database: SqlDatabase, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  return database.prepare(sql).all(...params) as Record<string, SqlValue>[];
}

function usageBackfillSinceAfterReset(database: SqlDatabase, since: Date): Date {
  const resetAt = readUsageStatsResetAt(database);
  if (!resetAt || resetAt.getTime() < since.getTime()) {
    return since;
  }
  return new Date(resetAt.getTime() + 1);
}

function readUsageStatsResetAt(database: SqlDatabase): Date | undefined {
  const row = queryRows(database, "SELECT value FROM usage_metadata WHERE key = ? LIMIT 1", [usageStatsResetAtKey])[0];
  if (typeof row?.value !== "string") {
    return undefined;
  }
  const date = new Date(row.value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function copySqliteDatabaseToTemp(file: string): string {
  const target = join(tmpdir(), `ar-request-logs-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.sqlite`);
  copyFileSync(file, target);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${file}${suffix}`;
    if (existsSync(source)) {
      copyFileSync(source, `${target}${suffix}`);
    }
  }
  return target;
}

function cleanupSqliteTempCopy(file: string): void {
  for (const item of [file, `${file}-wal`, `${file}-shm`]) {
    rmSync(item, { force: true });
  }
}

function toStoredUsageEvent(row: Record<string, SqlValue>): StoredUsageEvent {
  return {
    cacheReadTokens: normalizeCount(row.cache_read_tokens),
    cacheWriteTokens: normalizeCount(row.cache_write_tokens),
    client: normalizeLabel(String(row.client ?? ""), "unknown"),
    costSource: String(row.cost_source ?? ""),
    costUsd: normalizeCost(row.cost_usd),
    createdAt: String(row.created_at ?? ""),
    credentialId: normalizeLabel(String(row.credential_id ?? ""), ""),
    durationMs: normalizeCount(row.duration_ms),
    id: normalizeCount(row.id),
    inputTokens: normalizeCount(row.input_tokens),
    logicalModel: normalizeLabel(String(row.logical_model ?? row.model ?? ""), "unknown"),
    method: String(row.method ?? ""),
    model: normalizeLabel(String(row.model ?? ""), "unknown"),
    outputTokens: normalizeCount(row.output_tokens),
    path: normalizeLabel(String(row.path ?? ""), "/"),
    provider: normalizeLabel(String(row.provider ?? ""), "unknown"),
    requestId: String(row.request_id ?? ""),
    statusCode: normalizeCount(row.status_code),
    totalTokens: normalizeCount(row.total_tokens)
  };
}

const usageTotalsSelect = `
            COUNT(*) AS request_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(CASE
              WHEN total_tokens > input_tokens + output_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens
              ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
            END), 0) AS computed_total_tokens,
            COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
            COALESCE(SUM(duration_ms), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) AS success_count,
            COALESCE(SUM(CASE
              WHEN total_tokens - output_tokens > input_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens - output_tokens
              ELSE input_tokens + cache_read_tokens + cache_write_tokens
            END), 0) AS prompt_tokens
`;

function readUsageTotals(database: SqlDatabase, query: UsageWhereClause): UsageTotals {
  const row = queryRows(
    database,
    `
      SELECT
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
    `,
    query.params
  )[0];
  return usageTotalsFromRow(row);
}

function readProviderUsageSeries(
  database: SqlDatabase,
  now: Date,
  query: UsageWhereClause
): Array<{ provider: string; series: UsageSeriesPoint[]; totals: UsageTotals }> {
  // Fixed daily buckets over a trailing window; the strip UI scrolls instead of
  // re-bucketing when the usage range changes.
  const bucketExpression = "strftime('%Y-%m-%d', created_at, 'localtime')";
  const rows = queryRows(
    database,
    `
      SELECT
        provider,
        ${bucketExpression} AS bucket,
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
      GROUP BY provider, bucket
    `,
    query.params
  );
  const byProvider = new Map<string, Map<string, UsageTotals>>();
  for (const row of rows) {
    const provider = usageProviderLabel(normalizeLabel(String(row.provider ?? ""), "unknown"));
    const bucket = String(row.bucket ?? "");
    const buckets = byProvider.get(provider) ?? new Map<string, UsageTotals>();
    // Credential-suffixed provider keys collapse onto one display provider;
    // merge instead of overwrite so days served via several keys sum up.
    const existing = buckets.get(bucket);
    buckets.set(bucket, existing ? mergeUsageTotals(existing, usageTotalsFromRow(row)) : usageTotalsFromRow(row));
    byProvider.set(provider, buckets);
  }
  const template = buildDayBuckets(providerStatusDays, now);
  return [...byProvider.entries()]
    .map(([provider, totalsByBucket]) => {
      const series = template.map(({ key, label }) => ({
        ...(totalsByBucket.get(key) ?? { ...emptyTotals }),
        bucket: key,
        label
      }));
      const requestCount = sum(series, (point) => point.requestCount);
      const errorCount = sum(series, (point) => point.errorCount);
      const totals: UsageTotals = {
        ...emptyTotals,
        errorCount,
        requestCount,
        successRate: requestCount > 0 ? (requestCount - errorCount) / requestCount : 0,
        totalTokens: sum(series, (point) => point.totalTokens)
      };
      return { provider, series, totals };
    })
    .sort((left, right) => right.totals.requestCount - left.totals.requestCount)
    .slice(0, 8);
}

function readUsageSeries(
  database: SqlDatabase,
  range: UsageStatsRange,
  now: Date,
  query: UsageWhereClause,
  template?: Array<{ key: string; label: string }>
): UsageSeriesPoint[] {
  const unit: "day" | "hour" = range === "today" || range === "24h" ? "hour" : "day";
  const bucketExpression = unit === "hour"
    ? "strftime('%Y-%m-%d %H:00', created_at, 'localtime')"
    : "strftime('%Y-%m-%d', created_at, 'localtime')";
  const rows = queryRows(
    database,
    `
      SELECT
        ${bucketExpression} AS bucket,
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
      GROUP BY bucket
    `,
    query.params
  );
  const totalsByBucket = new Map(rows.map((row) => [String(row.bucket ?? ""), usageTotalsFromRow(row)]));
  const modelsByBucket = readUsageModelsByBucket(database, bucketExpression, query);

  return (template ?? buildBuckets(range, now)).map(({ key, label }) => {
    const models = modelsByBucket.get(key);
    return {
      ...(totalsByBucket.get(key) ?? { ...emptyTotals }),
      bucket: key,
      label,
      ...(models && Object.keys(models).length > 0 ? { models } : {})
    };
  });
}

function readUsageModelsByBucket(
  database: SqlDatabase,
  bucketExpression: string,
  query: UsageWhereClause
): Map<string, Record<string, number>> {
  const rows = queryRows(
    database,
    `
      SELECT
        ${bucketExpression} AS bucket,
        model AS model,
        COALESCE(SUM(CASE
          WHEN total_tokens > input_tokens + output_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens
          ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
        END), 0) AS computed_total_tokens
      FROM usage_events
      WHERE ${query.where}
      GROUP BY bucket, model
    `,
    query.params
  );
  const modelsByBucket = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const bucket = String(row.bucket ?? "");
    const model = String(row.model ?? "").trim() || "unknown";
    const value = Number(row.computed_total_tokens) || 0;
    if (value <= 0) {
      continue;
    }
    const models = modelsByBucket.get(bucket) ?? {};
    models[model] = (models[model] ?? 0) + value;
    modelsByBucket.set(bucket, models);
  }
  return modelsByBucket;
}

function readModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "provider, model",
    "provider, model, MAX(credential_id) AS credential_id",
    // Same display model can arrive via several providers/credential-suffixed
    // provider keys; consumers merge by name, so fetch a wide enough slice.
    25
  ).map((row) => {
    const provider = usageProviderLabel(normalizeLabel(String(row.provider ?? ""), "unknown"));
    return {
      ...usageTotalsFromRow(row),
      caption: provider,
      credentialId: normalizeFilterValue(String(row.credential_id ?? "")),
      key: `${provider}::${normalizeLabel(String(row.model ?? ""), "unknown")}`,
      label: normalizeLabel(String(row.model ?? ""), "unknown"),
      maxShare: 0,
      model: normalizeLabel(String(row.model ?? ""), "unknown"),
      provider
    };
  });
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readClientModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "client, provider, credential_id, model",
    "client, provider, credential_id, model",
    25
  ).map((row) => {
    const client = normalizeLabel(String(row.client ?? ""), "unknown");
    const model = normalizeLabel(String(row.model ?? ""), "unknown");
    const provider = usageProviderLabel(normalizeLabel(String(row.provider ?? ""), "unknown"));
    const credentialId = normalizeFilterValue(String(row.credential_id ?? "")) ?? "";
    return {
      ...usageTotalsFromRow(row),
      caption: credentialId ? `${provider} / ${credentialId} / ${model}` : `${provider} / ${model}`,
      client,
      credentialId: credentialId || undefined,
      key: `${client}::${provider}::${credentialId}::${model}`,
      label: client,
      maxShare: 0,
      model,
      provider
    };
  });
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readProviderModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "provider, credential_id, model",
    "provider, credential_id, model",
    25
  ).map((row) => {
    const model = normalizeLabel(String(row.model ?? ""), "unknown");
    const provider = usageProviderLabel(normalizeLabel(String(row.provider ?? ""), "unknown"));
    const credentialId = normalizeFilterValue(String(row.credential_id ?? "")) ?? "";
    return {
      ...usageTotalsFromRow(row),
      caption: credentialId ? `${credentialId} / ${model}` : model,
      credentialId: credentialId || undefined,
      key: `${provider}::${credentialId}::${model}`,
      label: provider,
      maxShare: 0,
      model,
      provider
    };
  });
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readUsageGroupRows(
  database: SqlDatabase,
  query: UsageWhereClause,
  groupBy: string,
  selectColumns: string,
  limit: number
): Record<string, SqlValue>[] {
  return queryRows(
    database,
    `
      SELECT
        ${selectColumns},
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
      GROUP BY ${groupBy}
      ORDER BY computed_total_tokens DESC, request_count DESC
      LIMIT ?
    `,
    [...query.params, limit]
  );
}

function readRecentRequestRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const events = queryRows(
    database,
    `
      SELECT
        id,
        created_at,
        request_id,
        client,
        method,
        path,
        model,
        logical_model,
        provider,
        credential_id,
        status_code,
        duration_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_usd,
        cost_source
      FROM usage_events
      WHERE ${query.where}
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `,
    query.params
  ).map(toStoredUsageEvent).reverse();
  return buildRecentRequestRows(events);
}

function mergeUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const requestCount = left.requestCount + right.requestCount;
  const errorCount = left.errorCount + right.errorCount;
  const cacheTokens = left.cacheTokens + right.cacheTokens;
  const inputTokens = left.inputTokens + right.inputTokens;
  const durationTotal = left.avgDurationMs * left.requestCount + right.avgDurationMs * right.requestCount;
  return {
    avgDurationMs: requestCount > 0 ? Math.round(durationTotal / requestCount) : 0,
    cacheRatio: cacheTokens + inputTokens > 0 ? cacheTokens / (cacheTokens + inputTokens) : 0,
    cacheTokens,
    costUsd: left.costUsd + right.costUsd,
    errorCount,
    inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    requestCount,
    successRate: requestCount > 0 ? (requestCount - errorCount) / requestCount : 0,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function usageTotalsFromRow(row: Record<string, SqlValue> | undefined): UsageTotals {  const requestCount = normalizeCount(row?.request_count);
  if (requestCount === 0) {
    return { ...emptyTotals };
  }
  const successfulRequests = normalizeCount(row?.success_count);
  const promptTokens = normalizeCount(row?.prompt_tokens);
  const cacheTokens = normalizeCount(row?.cache_read_tokens);
  return {
    avgDurationMs: Math.round(normalizeCount(row?.duration_ms) / requestCount),
    cacheRatio: ratio(cacheTokens, promptTokens),
    cacheTokens,
    costUsd: normalizeCost(row?.cost_usd),
    errorCount: requestCount - successfulRequests,
    inputTokens: normalizeCount(row?.input_tokens),
    outputTokens: normalizeCount(row?.output_tokens),
    requestCount,
    successRate: successfulRequests / requestCount,
    totalTokens: normalizeCount(row?.computed_total_tokens)
  };
}

function buildSeries(range: UsageStatsRange, now: Date, events: StoredUsageEvent[]): UsageSeriesPoint[] {
  const buckets = buildBuckets(range, now);
  const grouped = new Map<string, StoredUsageEvent[]>();
  for (const event of events) {
    const key = formatBucketKey(new Date(event.createdAt), range === "today" || range === "24h" ? "hour" : "day");
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }

  return buckets.map(({ key, label }) => ({
    ...buildTotals(grouped.get(key) ?? []),
    bucket: key,
    label
  }));
}

function buildDayBuckets(days: number, now: Date, startAt?: Date): Array<{ key: string; label: string }> {
  const start = startAt ? new Date(startAt) : floorDay(now);
  if (!startAt) {
    start.setDate(start.getDate() - (days - 1));
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: formatBucketKey(date, "day"),
      label: `${date.getMonth() + 1}/${date.getDate()}`
    };
  });
}

// "all" trend template: daily buckets from the earliest stored usage event to
// today. The local collector merge appends its own earlier days on top, so the
// gateway template only needs to span gateway rows.
function buildAllTimeBuckets(database: SqlDatabase, now: Date): Array<{ key: string; label: string }> {
  const row = queryRows(database, "SELECT MIN(created_at) AS earliest FROM usage_events")[0];
  const earliest = row?.earliest ? new Date(String(row.earliest)) : undefined;
  if (!earliest || !Number.isFinite(earliest.getTime())) {
    return buildBuckets("30d", now);
  }
  const end = floorDay(now);
  const start = floorDay(earliest);
  const buckets: Array<{ key: string; label: string }> = [];
  const cursor = new Date(start);
  if ((end.getTime() - start.getTime()) / 86_400_000 + 1 > allTimeMaxBuckets) {
    cursor.setTime(end.getTime());
    cursor.setDate(end.getDate() - (allTimeMaxBuckets - 1));
  }
  while (cursor <= end) {
    buckets.push({ key: formatBucketKey(cursor, "day"), label: `${cursor.getMonth() + 1}/${cursor.getDate()}` });
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

function buildBuckets(
  range: UsageStatsRange,
  now: Date
): Array<{ key: string; label: string }> {
  if (range === "today" || range === "24h") {
    const start = range === "today" ? floorDay(now) : floorHour(now);
    if (range === "24h") {
      start.setHours(start.getHours() - 23);
    }
    const count = range === "today" ? floorHour(now).getHours() + 1 : 24;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setHours(start.getHours() + index);
      return {
        key: formatBucketKey(date, "hour"),
        label: `${String(date.getHours()).padStart(2, "0")}:00`
      };
    });
  }

  const count = range === "7d" ? 7 : 30;
  const start = floorDay(now);
  start.setDate(start.getDate() - (count - 1));
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: formatBucketKey(date, "day"),
      label: `${date.getMonth() + 1}/${date.getDate()}`
    };
  });
}

function buildRecentRequestRows(events: StoredUsageEvent[]): UsageComparisonRow[] {
  const recent = events.slice(-10).reverse();
  const rows = recent.map((event) => ({
    ...buildTotals([event]),
    caption: `${formatRequestTime(event.createdAt)} · ${event.client} · ${event.path} · ${event.statusCode}`,
    client: event.client,
    credentialId: event.credentialId || undefined,
    key: String(event.id),
    label: event.model || "unknown",
    logicalModel: event.logicalModel,
    maxShare: 0,
    model: event.model,
    provider: event.provider
  }));

  return applyMaxShare(rows, (row) => row.totalTokens || row.avgDurationMs || 1);
}

function applyMaxShare<T extends UsageComparisonRow>(
  rows: T[],
  readValue: (row: T) => number
): T[] {
  const max = Math.max(...rows.map(readValue), 0);
  return rows.map((row) => ({
    ...row,
    maxShare: max > 0 ? readValue(row) / max : 0
  }));
}

function buildTotals(events: StoredUsageEvent[]): UsageTotals {
  if (events.length === 0) {
    return { ...emptyTotals };
  }

  const requestCount = events.length;
  const inputTokens = sum(events, (event) => event.inputTokens);
  const outputTokens = sum(events, (event) => event.outputTokens);
  const cacheTokens = sum(events, (event) => event.cacheReadTokens);
  const costUsd = sum(events, (event) => event.costUsd);
  const totalTokens = sum(events, totalTokenCount);
  const promptTokens = sum(events, promptTokenCount);
  const successfulRequests = events.filter((event) => event.statusCode >= 200 && event.statusCode < 400).length;
  const errorCount = requestCount - successfulRequests;

  return {
    avgDurationMs: Math.round(sum(events, (event) => event.durationMs) / requestCount),
    cacheRatio: ratio(cacheTokens, promptTokens),
    cacheTokens,
    costUsd,
    errorCount,
    inputTokens,
    outputTokens,
    requestCount,
    successRate: successfulRequests / requestCount,
    totalTokens
  };
}

function promptTokenCount(event: StoredUsageEvent): number {
  const cacheTokens = event.cacheReadTokens + event.cacheWriteTokens;
  const promptTokensFromTotal = event.totalTokens - event.outputTokens;
  return Math.max(event.inputTokens + cacheTokens, promptTokensFromTotal);
}

function totalTokenCount(event: StoredUsageEvent): number {
  return Math.max(
    event.totalTokens,
    event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens
  );
}

function extractUsageFromBillingHeaders(headers: Headers): UsageNumbers | undefined {
  const inputTokens = readNumberHeader(headers, "x-gateway-billing-input-tokens");
  const outputTokens = readNumberHeader(headers, "x-gateway-billing-output-tokens");
  const cacheReadTokens = readNumberHeader(headers, "x-gateway-billing-cache-read-tokens");
  const cacheWrite1hTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-1h-tokens");
  const cacheWrite5mTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-5m-tokens");
  const cacheWriteTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-tokens") ??
    sumOptionalNumbers(cacheWrite5mTokens, cacheWrite1hTokens);
  const totalTokens = readNumberHeader(headers, "x-gateway-billing-total-tokens");

  if ([inputTokens, outputTokens, cacheReadTokens, cacheWrite1hTokens, cacheWrite5mTokens, cacheWriteTokens, totalTokens].every((value) => value === undefined)) {
    return undefined;
  }

  return {
    cacheReadTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function extractUsageFromBody(text: string): UsageSnapshot | undefined {
  const snapshots: UsageSnapshot[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    const snapshot = extractUsageSnapshot(parsed);
    return snapshot && hasUsageNumbers(snapshot) ? snapshot : undefined;
  }

  for (const payload of parseStreamPayloads(trimmed)) {
    const snapshot = extractUsageSnapshot(payload);
    if (snapshot && hasUsageNumbers(snapshot)) {
      snapshots.push(snapshot);
    }
  }

  let merged: UsageSnapshot | undefined;
  for (const snapshot of snapshots) {
    merged = mergeUsageSnapshots(snapshot, merged);
  }
  return merged;
}

function parseStreamPayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
    if (!payload || payload === "[DONE]") {
      continue;
    }
    const parsed = parseJson(payload);
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function extractUsageSnapshot(payload: unknown): UsageSnapshot | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const response = isRecord(payload.response) ? payload.response : payload;
  const message = isRecord(payload.message) ? payload.message : undefined;
  const usage = isRecord(response.usage)
    ? response.usage
    : isRecord(payload.usage)
      ? payload.usage
      : isRecord(message?.usage)
        ? message.usage
      : undefined;
  const usageMetadata = isRecord(response.usageMetadata)
    ? response.usageMetadata
    : isRecord(payload.usageMetadata)
      ? payload.usageMetadata
      : undefined;

  if (usageMetadata) {
    return {
      cacheReadTokens: asNumber(usageMetadata.cachedContentTokenCount),
      inputIncludesCacheTokens: true,
      inputTokens: asNumber(usageMetadata.promptTokenCount),
      model: asString(response.modelVersion) ?? asString(payload.modelVersion),
      outputTokens: asNumber(usageMetadata.candidatesTokenCount),
      totalTokens: asNumber(usageMetadata.totalTokenCount)
    };
  }

  if (!usage) {
    return undefined;
  }

  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
  const hasAnthropicCacheFields =
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined;
  const hasOpenAiCacheFields =
    inputDetails?.cached_tokens !== undefined ||
    inputDetails?.cache_creation_tokens !== undefined ||
    usage.cached_tokens !== undefined ||
    usage.prompt_tokens !== undefined;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const cacheWrite5mTokens = asNumber(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = asNumber(cacheCreation?.ephemeral_1h_input_tokens);

  return {
    cacheReadTokens:
      asNumber(usage.cache_read_tokens) ??
      asNumber(usage.cache_read_input_tokens) ??
      asNumber(usage.cached_tokens) ??
      asNumber(inputDetails?.cached_tokens),
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    cacheWriteTokens:
      asNumber(usage.cache_write_tokens) ??
      asNumber(usage.cache_creation_tokens) ??
      asNumber(usage.cache_creation_input_tokens) ??
      asNumber(inputDetails?.cache_creation_tokens) ??
      sumOptionalNumbers(cacheWrite5mTokens, cacheWrite1hTokens),
    inputIncludesCacheTokens: hasAnthropicCacheFields ? false : hasOpenAiCacheFields ? true : undefined,
    inputTokens: asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens),
    model:
      asString(response.model) ??
      asString(payload.model) ??
      asString(message?.model) ??
      asString(response.modelVersion) ??
      asString(payload.modelVersion),
    outputTokens: asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens),
    totalTokens: asNumber(usage.total_tokens)
  };
}

function hasUsageNumbers(snapshot: UsageNumbers): boolean {
  return [
    snapshot.cacheReadTokens,
    snapshot.cacheWrite1hTokens,
    snapshot.cacheWrite5mTokens,
    snapshot.cacheWriteTokens,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.totalTokens
  ].some((value) => value !== undefined);
}

function mergeUsageSnapshots(primary: UsageNumbers | undefined, fallback: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...fallback,
    ...Object.fromEntries(Object.entries(primary).filter(([, value]) => value !== undefined))
  };
}

function sumOptionalNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value || undefined;
}

function readCredentialId(headers: Headers): string | undefined {
  return readHeader(headers, "x-ar-provider-credential-id") ?? parseCredentialChain(readHeader(headers, "x-ar-provider-credential-chain"))[0];
}

function parseCredentialChain(value: string | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of (value ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function readNumberHeader(headers: Headers, name: string): number | undefined {
  return asNumber(readHeader(headers, name));
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function normalizeCount(value: unknown): number {
  return asNumber(value) ?? 0;
}

function normalizeCost(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeOptionalCost(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function splitRouteSelector(value: string | undefined): { model?: string; provider?: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }

  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return { model: trimmed };
  }

  return {
    model: trimmed.slice(separator + 1).trim(),
    provider: trimmed.slice(0, separator).trim()
  };
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function usageProviderLabel(value: string): string {
  const first = value.split("::")[0]?.trim();
  return first || value;
}

function normalizeFilterValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getRangeSince(range: UsageStatsRange, now: Date): Date {
  const date = new Date(now);
  if (range === "today") {
    return floorDay(date);
  }
  if (range === "all") {
    return new Date(0);
  }
  if (range === "24h") {
    date.setHours(date.getHours() - 24);
  } else if (range === "7d") {
    date.setDate(date.getDate() - 7);
  } else {
    date.setDate(date.getDate() - 30);
  }
  return date;
}

function floorHour(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  return next;
}

function floorDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatBucketKey(date: Date, unit: "day" | "hour"): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (unit === "day") {
    return `${year}-${month}-${day}`;
  }
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:00`;
}

function formatRequestTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ratio(numerator: number, denominator: number): number {
  if (numerator <= 0 || denominator <= 0) {
    return 0;
  }
  return Math.min(1, numerator / denominator);
}

function sum<T>(items: T[], read: (item: T) => number): number {
  return items.reduce((total, item) => total + read(item), 0);
}

function emptySnapshot(range: UsageStatsRange): UsageStatsSnapshot {
  return {
    clientModels: [],
    generatedAt: new Date().toISOString(),
    models: [],
    providerModels: [],
    range,
    recentRequests: [],
    series: buildSeries(range, new Date(), []),
    providerSeries: [],
    totals: { ...emptyTotals }
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
