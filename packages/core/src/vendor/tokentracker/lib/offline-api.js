// Local-only extraction from TokenTracker local-api.js (MIT).
// Original aggregation functions and route bodies; no HTTP listener or cloud routes.
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const {filterRowsByUsageScope,getSourceScope,listExcludedSources,normalizeUsageScope}=require('./source-metadata');
const {computeRowCost,getPricingRevision}=require('./pricing');
const {deriveProjectKeyFromRef,CLAUDE_MEM_OBSERVER_PROJECT_REF}=require('./rollout');
function resolveQueuePath() {
  const home = os.homedir();
  return path.join(home, ".tokentracker", "tracker", "queue.jsonl");
}

// Pseudo-project written by the pre-fix claude-mem observer attribution;
// mirrored Claude Code sessions, not a real repository. Excluded at read
// time so historical rows never surface on the Project Usage panel. Derived
// from rollout.js's ref so a rename there cannot silently desync the filter.
const CLAUDE_MEM_OBSERVER_PROJECT_KEY = deriveProjectKeyFromRef(
  CLAUDE_MEM_OBSERVER_PROJECT_REF,
);
const PROJECT_USAGE_MAX_ENTRIES = 10;
const MAX_TIME_ZONE_CACHE_ENTRIES = 16;

// The native dashboard fans one refresh out across several local endpoints.
// Keep one immutable, deduped view of the current queue so those endpoints do
// not all read and JSON.parse the same append-only file. A file identity +
// nanosecond timestamp signature invalidates the cache immediately on append,
// in-place rewrite, or atomic replacement.
let queueDataCache = null;
const dailyAggregationCache = new WeakMap();
const zonedPartsFormatters = new Map();

function boundedCacheSet(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function queueFileSignature(queuePath) {
  const stat = fs.statSync(queuePath, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function timeZoneContextKey({ timeZone, offsetMinutes } = {}) {
  return `${timeZone || ""}|${Number.isFinite(offsetMinutes) ? offsetMinutes : ""}|p${getPricingRevision()}`;
}

// Shared by project-usage-summary and project-usage-detail: reads the
// deduped project bucket log, drops the claude-mem pseudo project, and
// builds the from/to day-range predicate. Callers compute each row's day
// key ONCE (rowDayKey constructs an Intl.DateTimeFormat per call — the
// dominant per-row cost) and reuse it for both the range check and any
// day bucketing.
function readProjectUsageContext(qp, url) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const timeZoneContext = getTimeZoneContext(url);
  const hasRange = Boolean(from || to);
  const dayInRange = (day) => {
    if (!hasRange) return true;
    if (!day) return false;
    return (!from || day >= from) && (!to || day <= to);
  };
  const projectQueuePath = path.join(path.dirname(qp), "project.queue.jsonl");
  const projectRows = readProjectQueueData(projectQueuePath).filter(
    (row) => row.project_key !== CLAUDE_MEM_OBSERVER_PROJECT_KEY,
  );
  return { from, to, timeZoneContext, hasRange, dayInRange, projectRows };
}

// Same signature-based caching as readQueueData: the project-usage endpoints
// all fan out from one dashboard refresh, so without this every request
// re-read and re-parsed the whole append-only project queue.
let projectQueueDataCache = null;

function readProjectQueueData(projectQueuePath) {
  let signature;
  try {
    signature = queueFileSignature(projectQueuePath);
  } catch (e) {
    if (projectQueueDataCache?.queuePath === projectQueuePath) {
      projectQueueDataCache = null;
    }
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readProjectQueueData: failed to stat:", e?.message || e);
    }
    return [];
  }

  if (
    projectQueueDataCache?.queuePath === projectQueuePath &&
    projectQueueDataCache.signature === signature
  ) {
    return projectQueueDataCache.rows;
  }

  let raw;
  try {
    raw = fs.readFileSync(projectQueuePath, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readProjectQueueData: failed to read:", e?.message || e);
    }
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const seen = new Map();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const key = `${row.project_key || ""}|${row.source || ""}|${row.hour_start || ""}`;
      // Same legacy-row corrections as the main queue (codex inclusive-input,
      // cursor billable=0) so both read paths report identical numbers.
      seen.set(key, normalizeQueueRow(row));
    } catch {
      // skip malformed
    }
  }
  // Callers treat the result as read-only (sortByHour copies before sorting),
  // so the cached array can be shared across requests.
  const rows = Array.from(seen.values());
  projectQueueDataCache = { queuePath: projectQueuePath, signature, rows };
  return rows;
}

function isLegacyInclusiveCodexRow(row) {
  if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
  const inputTokens = Number(row.input_tokens || 0);
  const cachedInputTokens = Number(row.cached_input_tokens || 0);
  const outputTokens = Number(row.output_tokens || 0);
  const totalTokens = Number(row.total_tokens || 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
  if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
  // Legacy Codex queue rows stored input inclusive of cache reads, while
  // total_tokens remained input + output. Canonical rows keep input as pure
  // non-cached input, so cache-heavy legacy rows can be identified by this
  // exact invariant.
  return totalTokens === inputTokens + outputTokens;
}

function normalizeQueueRow(row) {
  let normalized = row;
  if (isLegacyInclusiveCodexRow(normalized)) {
    normalized = {
      ...normalized,
      input_tokens:
        Number(normalized.input_tokens || 0) - Number(normalized.cached_input_tokens || 0),
    };
  }
  // Legacy Cursor rows from versions ≤ 0.26.5 wrote billable_total_tokens = 0
  // for "Included in Pro" / "Enterprise" / "no charge" records (kind-based
  // gating in cursor-config.js#normalizeCursorUsage). The dashboard headline
  // sums billable_total_tokens across sources, so those rows silently
  // disappeared from the displayed total once any other source contributed
  // non-zero billable usage (GitHub issue #106). Treat billing and usage as
  // orthogonal: bump billable up to total_tokens at read time so historical
  // queue.jsonl entries render correctly without requiring a file rewrite.
  // Antigravity had the same symptom from e69e2746a (billable deleted during
  // the O(N) refactoring, leaving 167 local rows with billable=0 until the
  // parser fix). Apply the same read-time healing so upgraded installs show
  // correct heatmap / rolling numbers without a queue rewrite.
  const sourceName = String(normalized.source || "").toLowerCase();
  if (sourceName === "cursor" || sourceName === "antigravity") {
    const totalTokens = Number(normalized.total_tokens || 0);
    const billable = Number(normalized.billable_total_tokens || 0);
    if (totalTokens > 0 && billable < totalTokens) {
      normalized = { ...normalized, billable_total_tokens: totalTokens };
    }
  }
  return normalized;
}

function readQueueData(queuePath) {
  let stat;
  try {
    stat = fs.statSync(queuePath, { bigint: true });
  } catch (e) {
    if (queueDataCache?.queuePath === queuePath) queueDataCache = null;
    if (e?.code !== "ENOENT") {
      console.error("[LocalAPI] readQueueData: failed to stat queue:", e?.message || e);
    }
    return [];
  }
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

  const cached = queueDataCache;
  if (cached?.queuePath === queuePath && cached.signature === signature) {
    return cached.rows;
  }

  // The queue is append-only, so on a same-file append only the new tail is
  // read and parsed; the deduped row set carries over. A replaced, truncated,
  // or first-seen file falls back to a full read.
  const devIno = `${stat.dev}:${stat.ino}`;
  const fileSize = Number(stat.size);
  const canAppend =
    cached != null &&
    cached.queuePath === queuePath &&
    cached.devIno === devIno &&
    fileSize >= cached.consumedBytes;
  let seen = canAppend ? cached.seen : new Map();
  let offset = canAppend ? cached.consumedBytes : 0;

  // Integrity probe for the append assumption: repo writers only append or
  // atomically replace (inode change), but an EXTERNAL in-place rewrite
  // (cp over the file, shell redirect) keeps the inode with a same/larger
  // size while changing the prefix. The byte before our offset must be the
  // newline that terminated the last consumed line — anything else means the
  // prefix is no longer ours, so fall back to a full read.
  if (offset > 0) {
    try {
      const fd = fs.openSync(queuePath, "r");
      try {
        const probe = Buffer.allocUnsafe(1);
        if (fs.readSync(fd, probe, 0, 1, offset - 1) !== 1 || probe[0] !== 0x0a) {
          seen = new Map();
          offset = 0;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      seen = new Map();
      offset = 0;
    }
  }

  let raw = "";
  if (fileSize > offset) {
    try {
      if (offset === 0) {
        raw = fs.readFileSync(queuePath, "utf8");
      } else {
        const fd = fs.openSync(queuePath, "r");
        try {
          const length = fileSize - offset;
          const buffer = Buffer.allocUnsafe(length);
          let read = 0;
          while (read < length) {
            // A concurrent truncation between stat and open makes readSync hit
            // EOF early — without the 0-byte break this loop never terminates.
            const n = fs.readSync(fd, buffer, read, length - read, offset + read);
            if (n === 0) break;
            read += n;
          }
          raw = buffer.toString("utf8", 0, read);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (e) {
      // ENOENT is legitimate (queue deleted between stat and read); anything
      // else is a signal we don't want to hide behind an empty array forever —
      // the dashboard would otherwise render "0 tokens" with no clue the queue
      // was unreadable.
      if (e?.code !== "ENOENT") {
        console.error("[LocalAPI] readQueueData: failed to read queue:", e?.message || e);
      }
      return canAppend ? cached.rows : [];
    }
  }

  // Parse row-by-row so a single corrupted line (partial write, disk-full
  // truncation, …) does not wipe out every other row with it. An unterminated
  // tail is attempted (legacy writers may omit the final newline) but NOT
  // marked consumed — a mid-append partial line is re-read once it completes.
  // "\n" (0x0A) never appears inside a multi-byte UTF-8 sequence, so cutting
  // on the last newline is byte-safe.
  let consumedBytes = offset;
  let malformed = 0;
  if (raw) {
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline !== -1) {
      consumedBytes += Buffer.byteLength(raw.slice(0, lastNewline), "utf8") + 1;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Account session states (and the pre-release watermark records
        // this branch may still hold in a dev queue) are cloud-side control
        // records, not usage rows - never surface them locally.
        if (row?.kind === "account_session_state" || row?.kind === "account_sync_watermark") continue;
        // Deduplicate: each sync appends cumulative totals per bucket, so for
        // each (source, model, hour_start) keep only the latest (last) entry.
        const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
        seen.set(key, normalizeQueueRow(row));
      } catch {
        malformed += 1;
      }
    }
  }
  if (malformed > 0) {
    console.error(
      `[LocalAPI] readQueueData: skipped ${malformed} malformed line(s) in ${queuePath}`,
    );
  }
  const rows = Array.from(seen.values());
  queueDataCache = { queuePath, signature, devIno, consumedBytes, seen, rows };
  return rows;
}

function rowDayKey(row, timeZoneContext) {
  const hs = row.hour_start;
  if (!hs) return "";
  if (
    timeZoneContext &&
    (timeZoneContext.timeZone || Number.isFinite(timeZoneContext.offsetMinutes))
  ) {
    const parts = getZonedParts(new Date(hs), timeZoneContext);
    const key = formatPartsDayKey(parts);
    if (key) return key;
  }
  return hs.slice(0, 10);
}

function aggregateByDay(rows, timeZoneContext = null) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const cacheKey = timeZoneContextKey(timeZoneContext || {});
  let cachedByTimeZone = dailyAggregationCache.get(normalizedRows);
  if (cachedByTimeZone?.has(cacheKey)) {
    const cached = cachedByTimeZone.get(cacheKey);
    // Touch the entry so the small per-queue map behaves as an LRU.
    cachedByTimeZone.delete(cacheKey);
    cachedByTimeZone.set(cacheKey, cached);
    return cached;
  }

  const byDay = new Map();
  for (const row of normalizedRows) {
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const a = byDay.get(day);
    a.total_tokens += row.total_tokens || 0;
    a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += row.input_tokens || 0;
    a.output_tokens += row.output_tokens || 0;
    a.cached_input_tokens += row.cached_input_tokens || 0;
    a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    a.conversation_count += row.conversation_count || 0;

    if (!a.models) {
      a.models = {};
    }
    const model = row.model || "unknown";
    a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
  }
  const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  if (!cachedByTimeZone) {
    cachedByTimeZone = new Map();
    dailyAggregationCache.set(normalizedRows, cachedByTimeZone);
  }
  boundedCacheSet(cachedByTimeZone, cacheKey, daily, MAX_TIME_ZONE_CACHE_ENTRIES);
  return daily;
}

function buildCodexCategoryFallbackFromQueue(queueRows, { from, to, timeZoneContext }) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let conversationCount = 0;

  for (const row of queueRows || []) {
    if ((row?.source || "") !== "codex") continue;
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (from && day < from) continue;
    if (to && day > to) continue;
    totals.input_tokens += Number(row.input_tokens || 0);
    totals.cached_input_tokens += Number(row.cached_input_tokens || 0);
    totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
    totals.output_tokens += Number(row.output_tokens || 0);
    totals.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
    totals.total_tokens += Number(row.total_tokens || 0);
    conversationCount += Number(row.conversation_count || 0);
  }

  return {
    source: "codex",
    scope: "supported",
    breakdown_status: "queue_fallback",
    totals,
    session_count: 0,
    message_count: conversationCount,
    fallback: "queue_totals",
    message_breakdown: {
      categories: [
        {
          key: "user_input",
          name: "User input",
          totals: {
            input_tokens: totals.input_tokens,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.input_tokens,
          },
        },
        {
          key: "conversation_history",
          name: "Conversation history",
          totals: {
            input_tokens: 0,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.cached_input_tokens + totals.cache_creation_input_tokens,
          },
        },
        {
          key: "assistant_response",
          name: "Assistant response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
            reasoning_output_tokens: 0,
            total_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
          },
        },
      ].sort((a, b) => Number(b.totals.total_tokens || 0) - Number(a.totals.total_tokens || 0)),
      privacy: {
        includes_content: false,
        note: "Queue fallback includes aggregated token categories only; message text is never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: 0,
      tools: [],
      categories: [],
      tools_total: 0,
      privacy: {
        includes_inputs: false,
        note: "Codex rollout sessions were unavailable; totals come from TokenTracker queue rows.",
      },
    },
    exec_command_breakdown: {
      by_type: [],
      by_exit: [],
    },
  };
}

function getRequestedUsageScope(url) {
  if (url.searchParams.get("include_account_level") === "1") return "all";
  return normalizeUsageScope(url.searchParams.get("scope"));
}

function scopedQueueRows(queuePath, url) {
  const scope = getRequestedUsageScope(url);
  const allRows = readQueueData(queuePath);
  const requestedSources = new Set(
    String(url.searchParams.get("source") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const sourceRows = requestedSources.size > 0
    ? allRows.filter((row) => requestedSources.has(String(row.source || "").trim().toLowerCase()))
    : allRows;
  return {
    scope,
    allRows,
    rows: filterRowsByUsageScope(sourceRows, scope),
    excludedSources: listExcludedSources(allRows, scope),
  };
}

// ── Local achievements ───────────────────────────────────────────────────────
// Local-only badges (the cloud nine live in scripts/ops/user-badges.sql).
// Thresholds are ordered bronze → silver → gold → diamond. This module is the
// single server-side home for LOCAL thresholds; the dashboard renders whatever
// the payload says and embeds none of these numbers.
const LOCAL_BADGE_THRESHOLDS = {
  project_hopper: [3, 5, 10, 20], // distinct projects
  project_devotion: [1000000, 10000000, 100000000, 1000000000], // max tokens in one project
  night_owl: [5, 20, 60, 150], // active hour buckets between 00:00–05:59 local
};

const LOCAL_TIER_KEYS = ["bronze", "silver", "gold", "diamond"];

/**
 * Compute the local badge set from deduped queue rows.
 * Rows are replayed in hour_start order so each tier's `achieved` timestamp is
 * the hour at which the running metric first crossed that threshold. Local
 * time (night_owl) follows the caller's tz query params like every other
 * usage endpoint.
 */
function computeLocalAchievements(queueRows, projectRows, { timeZoneContext } = {}) {
  const sortByHour = (rows) =>
    rows
      .filter((row) => row && row.hour_start)
      .slice()
      .sort((a, b) => String(a.hour_start).localeCompare(String(b.hour_start)));

  const trackers = {
    project_hopper: { value: 0, achieved: {}, meta: {} },
    project_devotion: { value: 0, achieved: {}, meta: {} },
    night_owl: { value: 0, achieved: {}, meta: {} },
  };

  const bump = (badgeId, newValue, atIso, meta) => {
    const tracker = trackers[badgeId];
    if (newValue <= tracker.value) return;
    tracker.value = newValue;
    if (meta) tracker.meta = meta;
    const thresholds = LOCAL_BADGE_THRESHOLDS[badgeId];
    for (let i = 0; i < thresholds.length; i += 1) {
      const tierKey = LOCAL_TIER_KEYS[i];
      if (newValue >= thresholds[i] && !tracker.achieved[tierKey]) {
        tracker.achieved[tierKey] = atIso;
      }
    }
  };

  const seenProjects = new Set();
  const perProjectTokens = new Map();
  for (const row of sortByHour(projectRows || [])) {
    const projectKey = row.project_key;
    const tokens = Number(row.total_tokens || 0);
    if (!projectKey || tokens <= 0) continue;
    if (!seenProjects.has(projectKey)) {
      seenProjects.add(projectKey);
      bump("project_hopper", seenProjects.size, row.hour_start);
    }
    const running = (perProjectTokens.get(projectKey) || 0) + tokens;
    perProjectTokens.set(projectKey, running);
    if (running > trackers.project_devotion.value) {
      bump("project_devotion", running, row.hour_start, { project_key: projectKey });
    }
  }

  const nightHours = new Set();
  for (const row of sortByHour(queueRows || [])) {
    if (Number(row.total_tokens || 0) <= 0) continue;
    if (nightHours.has(row.hour_start)) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext || {});
    if (!parts || parts.hour >= 6) continue;
    nightHours.add(row.hour_start);
    bump("night_owl", nightHours.size, row.hour_start);
  }

  return Object.entries(LOCAL_BADGE_THRESHOLDS).map(([badgeId, thresholds]) => {
    const tracker = trackers[badgeId];
    let tier = 0;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (tracker.value >= thresholds[i]) tier = i + 1;
    }
    return {
      id: badgeId,
      tier,
      metric_value: tracker.value,
      thresholds: thresholds.slice(),
      lower_is_better: false,
      next_threshold: tier >= 4 ? null : thresholds[tier],
      achieved: {
        bronze: tracker.achieved.bronze || null,
        silver: tracker.achieved.silver || null,
        gold: tracker.achieved.gold || null,
        diamond: tracker.achieved.diamond || null,
      },
      meta: tracker.meta,
    };
  });
}

function getTimeZoneContext(url) {
  const tz = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  return {
    timeZone: tz || null,
    offsetMinutes: Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null,
  };
}

function getZonedParts(date, { timeZone, offsetMinutes } = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      let formatter;
      if (zonedPartsFormatters.has(timeZone)) {
        formatter = zonedPartsFormatters.get(timeZone);
      } else {
        try {
          formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          });
        } catch {
          // Cache invalid zone ids too; otherwise a bad local query would
          // throw once per queue row before falling back to its fixed offset.
          formatter = null;
        }
        boundedCacheSet(
          zonedPartsFormatters,
          timeZone,
          formatter,
          MAX_TIME_ZONE_CACHE_ENTRIES,
        );
      }
      const parts = formatter?.formatToParts(dt) || [];
      const values = parts.reduce((acc, part) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {});
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
        return { year, month, day, hour, minute, second };
      }
    } catch (_e) {
      // fall through
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    second: dt.getSeconds(),
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function aggregateHourlyByDay(rows, dayKey, timeZoneContext) {
  const byHour = new Map();
  for (const row of rows) {
    if (!row.hour_start) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext);
    if (!parts) continue;
    if (formatPartsDayKey(parts) !== dayKey) continue;
    const hourKey = `${dayKey}T${String(parts.hour).padStart(2, "0")}:00:00`;
    if (!byHour.has(hourKey)) {
      byHour.set(hourKey, {
        hour: hourKey,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const bucket = byHour.get(hourKey);
    bucket.total_tokens += row.total_tokens || 0;
    bucket.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    bucket.input_tokens += row.input_tokens || 0;
    bucket.output_tokens += row.output_tokens || 0;
    bucket.cached_input_tokens += row.cached_input_tokens || 0;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    bucket.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    bucket.conversation_count += row.conversation_count || 0;

    if (!bucket.models) {
      bucket.models = {};
    }
    const model = row.model || "unknown";
    bucket.models[model] = (bucket.models[model] || 0) + (row.total_tokens || 0);
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
}

// ---------------------------------------------------------------------------
// Sync helper
// ---------------------------------------------------------------------------

function trimOutput(value, max = 4000) {
  const t = String(value || "");
  return t.length <= max ? t : t.slice(t.length - max);
}

function normalizeRemoteHttpBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_e) {
    return null;
  }
}

function resolveAllowedInsforgeBaseUrl(value) {
  const requested = normalizeRemoteHttpBaseUrl(value);
  if (!requested) return null;

  const runtime = resolveRuntimeConfig();
  const allowed = new Set(
    [runtime.baseUrl, DEFAULT_BASE_URL]
      .map((entry) => normalizeRemoteHttpBaseUrl(entry))
      .filter(Boolean),
  );

  return allowed.has(requested) ? requested : null;
}

function parseCookieHeader(value) {
  const out = new Map();
  if (typeof value !== "string" || !value.trim()) return out;
  for (const part of value.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (key) out.set(key, rawValue);
  }
  return out;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function hasAllowedLoopbackOrigin(headers = {}) {
  const candidates = [headers.origin, headers.referer];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    try {
      const url = new URL(String(raw));
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
    } catch (_e) {
      return false;
    }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error(`Request body exceeds ${Math.ceil(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (error) => { if (!failed) reject(error); });
  });
}

function runSyncCommand(extraEnv = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [TRACKER_BIN, "sync"];
    if (opts.auto === true) args.push("--auto");
    if (opts.background === true) args.push("--background");
    if (opts.publishAccount === true) args.push("--publish-account");
    if (opts.allLocalSources === true) args.push("--all-local-sources");
    if (opts.drain === true) args.push("--drain");
    if (opts.waitForLock === true) args.push("--wait-for-lock");
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      fn(v);
    };
    const tid = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        Object.assign(new Error("Sync timed out"), {
          code: "SYNC_TIMEOUT",
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
        }),
      );
    }, SYNC_TIMEOUT_MS);
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e) => {
      finish(reject, Object.assign(e, { stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
    });
    child.on("close", (code) => {
      const r = { code: code ?? 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) };
      if (code === 0) {
        finish(resolve, r);
        return;
      }
      const error = Object.assign(
        new Error(r.stderr || r.stdout || `exit ${r.code}`),
        r,
      );
      if (/\bSYNC_BUSY\b/.test(`${r.stderr}\n${r.stdout}`)) {
        error.code = "SYNC_BUSY";
      }
      finish(reject, error);
    });
  });
}

// ---------------------------------------------------------------------------
// Project detection helpers
// ---------------------------------------------------------------------------

function parseGitUrl(url) {
  if (!url) return null;
  const ssh = url.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const http = url.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

function extractProjectFromCwd(cwd) {
  const home = os.homedir();
  if (!cwd || cwd === home) return null;
  const rel = cwd.replace(home + "/", "");
  const parts = rel.split("/").filter((p) => p && !p.startsWith(".") && p !== "ext-global");
  return parts.length > 0 ? parts[0] : null;
}

function scanCodexProjects(projectMap) {
  const dir = path.join(os.homedir(), ".codex", "sessions");
  try {
    for (const year of fs.readdirSync(dir)) {
      const yp = path.join(dir, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          const files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
          for (const file of files.slice(0, 200)) {
            try {
              const first = fs.readFileSync(path.join(dp, file), "utf8").split("\n")[0];
              const d = JSON.parse(first);
              if (d.git?.repository_url) {
                const p = parseGitUrl(d.git.repository_url);
                if (p) {
                  const key = `${p.owner}/${p.repo}`;
                  if (!projectMap.has(key))
                    projectMap.set(key, {
                      project_key: key,
                      project_ref: d.git.repository_url,
                      count: 0,
                    });
                  projectMap.get(key).count++;
                }
              }
            } catch (_e) {}
          }
        }
      }
    }
  } catch (_e) {}
}

function findSubagentsDirs(dir, depth) {
  const out = [];
  if (depth > 3) return out;
  try {
    for (const item of fs.readdirSync(dir)) {
      const fp = path.join(dir, item);
      if (!fs.statSync(fp).isDirectory()) continue;
      if (item === "subagents") out.push(fp);
      else out.push(...findSubagentsDirs(fp, depth + 1));
    }
  } catch (_e) {}
  return out;
}

function scanClaudeProjects(projectMap) {
  const dir = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const subDir of findSubagentsDirs(dir, 0)) {
      const files = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files.slice(0, 100)) {
        try {
          const first = fs.readFileSync(path.join(subDir, file), "utf8").split("\n")[0];
          if (!first) continue;
          const d = JSON.parse(first);
          const name = extractProjectFromCwd(d.cwd);
          if (name) {
            if (!projectMap.has(name))
              projectMap.set(name, {
                project_key: name,
                project_ref: `file://${d.cwd}`,
                count: 0,
              });
            projectMap.get(name).count++;
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// IP check API proxy: dashboard/src/pages/IpCheckPage.jsx is a native React
// page that calls ip.net.coffee's data endpoints (/api/iprisk, /api/geoip,
// /api/dns/result, /favicons, /claude/status.json). Browser-side fetch can't
// hit them cross-origin from the dashboard, so we reverse-proxy /proxy/ipcheck/*
// to https://ip.net.coffee/* and strip embedding-hostile headers.
// (Previously this proxy also served the upstream HTML page for an iframe;
// the iframe and its HTML-rewrite path have been removed.)
// ---------------------------------------------------------------------------


async function queryOffline(queuePath,pathname,query={}) {
const qp=queuePath; const p=pathname;const url=new URL(pathname,'http://local.invalid');for(const [key,value] of Object.entries(query))url.searchParams.set(key,String(value));let result;const res={writeHead(){},setHeader(){},end(body){result=JSON.parse(body)}};
async function dispatch(){
if (p === "/functions/tokentracker-usage-summary") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const allDaily = aggregateByDay(rows, timeZoneContext);
      const daily = allDaily.filter((d) => d.day >= from && d.day <= to);
      const totals = daily.reduce(
        (acc, r) => {
          acc.total_tokens += r.total_tokens;
          acc.billable_total_tokens += r.billable_total_tokens;
          acc.total_cost_usd += r.total_cost_usd || 0;
          acc.input_tokens += r.input_tokens;
          acc.output_tokens += r.output_tokens;
          acc.cached_input_tokens += r.cached_input_tokens;
          acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
          acc.reasoning_output_tokens += r.reasoning_output_tokens;
          acc.conversation_count += r.conversation_count;
          return acc;
        },
        { total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 },
      );
      const totalCost = totals.total_cost_usd;

      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);

      const shiftDay = (dayStr, delta) => {
        const d = new Date(`${dayStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      const collectDays = (n) => {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
          const ds = shiftDay(todayStr, -i);
          const dd = allDaily.find((x) => x.day === ds);
          if (dd) out.push(dd);
        }
        return out;
      };
      const sumDays = (days) =>
        days.reduce((a, r) => {
          a.billable_total_tokens += r.billable_total_tokens;
          a.conversation_count += r.conversation_count;
          return a;
        }, { billable_total_tokens: 0, conversation_count: 0 });

      const l7 = collectDays(7);
      const l30 = collectDays(30);
      const l7t = sumDays(l7);
      const l30t = sumDays(l30);
      const l7fromStr = shiftDay(todayStr, -6);
      const l30fromStr = shiftDay(todayStr, -29);

      json(res, {
        from, to, days: daily.length, scope, excluded_sources: excludedSources,
        totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
        rolling: {
          last_7d: { from: l7fromStr, to: todayStr, active_days: l7.length, totals: l7t },
          last_30d: { from: l30fromStr, to: todayStr, active_days: l30.length, totals: l30t, avg_per_active_day: l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0 },
        },
      });
      return true;
    }
if (p === "/functions/tokentracker-usage-daily") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext).filter((d) => d.day >= from && d.day <= to);
      json(res, { from, to, scope, excluded_sources: excludedSources, data: daily });
      return true;
    }
if (p === "/functions/tokentracker-usage-heatmap") {
      const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const daily = aggregateByDay(rows, timeZoneContext);
      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);
      const end = new Date(`${todayStr}T00:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
      const from = start.toISOString().slice(0, 10);
      const to = end.toISOString().slice(0, 10);
      const byDay = new Map(daily.map((d) => [d.day, d]));

      const allValues = daily.map((d) => d.billable_total_tokens).filter((v) => v > 0);
      const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
      const calcLevel = (v) => {
        if (v <= 0) return 0;
        if (maxValue === 0) return 1;
        const r = v / maxValue;
        if (r <= 0.25) return 1;
        if (r <= 0.5) return 2;
        if (r <= 0.75) return 3;
        return 4;
      };

      // Build cells and group into weeks (array of 7-cell arrays) for the dashboard
      const cells = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const day = cursor.toISOString().slice(0, 10);
        const data = byDay.get(day);
        const billable = data?.billable_total_tokens || 0;
        cells.push({ day, total_tokens: data?.total_tokens || 0, billable_total_tokens: billable, level: calcLevel(billable), models: data?.models || null });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const weeksArr = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeksArr.push(cells.slice(i, i + 7));
      }

      let totalCostUsd = 0;
      for (const d of daily) {
        if (d.day >= from && d.day <= to) {
          totalCostUsd += d.total_cost_usd || 0;
        }
      }

      json(res, { 
        from, 
        to, 
        scope, 
        excluded_sources: excludedSources, 
        week_starts_on: "sun", 
        active_days: cells.filter((c) => c.billable_total_tokens > 0).length, 
        streak_days: 0, 
        weeks: weeksArr,
        total_cost_usd: totalCostUsd
      });
      return true;
    }
if (p === "/functions/tokentracker-usage-model-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows: scopedRows, scope, excludedSources } = scopedQueueRows(qp, url);
      const rows = scopedRows.filter((r) => {
        if (!r.hour_start) return false;
        const d = rowDayKey(r, timeZoneContext);
        return d >= from && d <= to;
      });

      const bySource = new Map();
      for (const row of rows) {
        const src = row.source || "unknown";
        const mdl = row.model || "unknown";
        if (!bySource.has(src))
          bySource.set(src, { source: src, source_scope: getSourceScope(src), totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0, total_cost_usd: "0" }, models: new Map() });
        const sa = bySource.get(src);
        sa.totals.total_tokens += row.total_tokens || 0;
        sa.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        sa.totals.input_tokens += row.input_tokens || 0;
        sa.totals.output_tokens += row.output_tokens || 0;
        sa.totals.cached_input_tokens += row.cached_input_tokens || 0;
        sa.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        sa.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        sa.totals.conversation_count += row.conversation_count || 0;
        if (!sa.models.has(mdl))
          sa.models.set(mdl, { model: mdl, model_id: mdl, totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0, total_cost_usd: "0" } });
        const ma = sa.models.get(mdl);
        ma.totals.total_tokens += row.total_tokens || 0;
        ma.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        ma.totals.input_tokens += row.input_tokens || 0;
        ma.totals.output_tokens += row.output_tokens || 0;
        ma.totals.cached_input_tokens += row.cached_input_tokens || 0;
        ma.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        ma.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        ma.totals.conversation_count += row.conversation_count || 0;
        ma.totals.total_cost_usd = Number(ma.totals.total_cost_usd || 0)
          + (Number(row.total_cost_usd) || 0);
      }

      const sources = Array.from(bySource.values()).map((s) => {
        s.models = Array.from(s.models.values())
          .map((m) => {
            const cost = computeRowCost({
              ...m.totals,
              model: m.model,
              source: s.source,
            });
            return { ...m, totals: { ...m.totals, total_cost_usd: cost.toFixed(6) } };
          })
          .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
        const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
        s.totals.total_cost_usd = sourceCost.toFixed(6);
        return s;
      });

      json(res, {
        from, to, days: 0, scope, excluded_sources: excludedSources, sources,
        pricing: { model: "per-model", pricing_mode: "per_token_type", source: "litellm", effective_from: new Date().toISOString().slice(0, 10) },
      });
      return true;
    }
if (p === "/functions/tokentracker-project-usage-summary") {
      // Use the per-project bucket log that rollout.js emits — it already
      // carries the actual tokens attributed to each (project_key, source,
      // hour_start). Falling back to "session-file count × total tokens"
      // (the old behavior) produced pure fiction: every short-and-hot
      // project got the same weight as every long-and-cold one.
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), PROJECT_USAGE_MAX_ENTRIES)
        : PROJECT_USAGE_MAX_ENTRIES;
      const { timeZoneContext, hasRange, dayInRange, projectRows } =
        readProjectUsageContext(qp, url);

      const aggregateEntries = (rows, keyOf, refOf) => {
        const byKey = new Map();
        for (const row of rows) {
          if (hasRange && !dayInRange(rowDayKey(row, timeZoneContext))) continue;
          const key = keyOf(row);
          if (!byKey.has(key)) {
            byKey.set(key, {
              project_key: key,
              project_ref: refOf(row),
              total_tokens: 0,
              billable_total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              reasoning_output_tokens: 0,
              conversation_count: 0,
              sourceTotals: new Map(),
            });
          }
          const agg = byKey.get(key);
          agg.total_tokens += Number(row.total_tokens || 0);
          agg.billable_total_tokens += Number(
            row.billable_total_tokens ?? row.total_tokens ?? 0,
          );
          agg.input_tokens += Number(row.input_tokens || 0);
          agg.output_tokens += Number(row.output_tokens || 0);
          agg.cached_input_tokens += Number(row.cached_input_tokens || 0);
          agg.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
          agg.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
          agg.conversation_count += Number(row.conversation_count || 0);
          if (!agg.project_ref) agg.project_ref = refOf(row);
          const src = row.source || "unknown";
          agg.sourceTotals.set(
            src,
            (agg.sourceTotals.get(src) || 0) + Number(row.total_tokens || 0),
          );
        }
        return Array.from(byKey.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .slice(0, limit)
          .map(({ sourceTotals, ...entry }) => ({
            ...entry,
            total_tokens: String(entry.total_tokens),
            billable_total_tokens: String(entry.billable_total_tokens),
            sources: Array.from(sourceTotals.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([source, totalTokens]) => ({ source, total_tokens: totalTokens })),
          }));
      };

      let entries = aggregateEntries(
        projectRows,
        (row) => row.project_key || "unknown",
        (row) => row.project_ref || "",
      );

      // If no project-attributed rows exist yet (user hasn't synced project
      // attribution, or never used a project-capable CLI), fall back to
      // per-source aggregation over the main queue so the panel isn't
      // totally empty. This path used to also exist for the non-empty case
      // and produce wrong numbers; keep it only as the empty fallback.
      if (entries.length === 0 && projectRows.length === 0) {
        entries = aggregateEntries(
          readQueueData(qp),
          (row) => row.source || "unknown",
          // Synthetic source-only row: leave project_ref empty rather than
          // fabricating `https://${src}.ai`, which resolves to unrelated
          // domains (e.g. codex.ai, cursor.ai) and was sent to the
          // dashboard as a clickable href before v0.11.1 / this commit.
          () => "",
        );
      }

      json(res, { generated_at: new Date().toISOString(), entries });
      return true;
    }
if (p === "/functions/tokentracker-usage-hourly") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const data = aggregateHourlyByDay(rows, day, timeZoneContext);
      json(res, { day, scope, excluded_sources: excludedSources, data });
      return true;
    }
if (p === "/functions/tokentracker-usage-monthly") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = scopedQueueRows(qp, url);
      const byMonth = new Map();
      for (const row of rows) {
        if (!row.hour_start) continue;
        const day = rowDayKey(row, timeZoneContext);
        if (!day || day < from || day > to) continue;
        const month = day.slice(0, 7);
        if (!byMonth.has(month))
          byMonth.set(month, { month, total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 });
        const a = byMonth.get(month);
        a.total_tokens += row.total_tokens || 0;
        a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        a.input_tokens += row.input_tokens || 0;
        a.output_tokens += row.output_tokens || 0;
        a.cached_input_tokens += row.cached_input_tokens || 0;
        a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        a.conversation_count += row.conversation_count || 0;

        if (!a.models) {
          a.models = {};
        }
        const model = row.model || "unknown";
        a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
      }
      json(res, { from, to, scope, excluded_sources: excludedSources, data: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)) });
      return true;
    }
if (p === "/functions/tokentracker-session-insights") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      const home = path.resolve(qp, "..", "..", "..");
      try {
        const { buildSessionAnalytics, summarizeSessions } = require("./session-analytics");
        const sessions = await buildSessionAnalytics({ home, force: refresh });
        const includeSessions = ["1", "true"].includes(url.searchParams.get("include_sessions"));
        const result = summarizeSessions(sessions, { from, to, includeSessions });
        json(res, { from, to, ...result });
      } catch (error) {
        json(res, { available: false, error: error?.message || "Session analytics failed" }, 500);
      }
      return true;
    }
if (p === "/functions/tokentracker-sessions") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      const limitParam = parseInt(url.searchParams.get("limit") || "0", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 0;
      const home = path.resolve(qp, "..", "..", "..");
      try {
        const { buildSessionAnalytics, listSessionsForBrowser } = require("./session-analytics");
        const sessions = await buildSessionAnalytics({ home, force: refresh });
        const result = listSessionsForBrowser(sessions, { from, to, limit });
        json(res, { from, to, ...result });
      } catch (error) {
        console.warn("[local-api] session browser failed:", error?.message || error);
        json(res, { available: false, error: "Session browser failed" }, 500);
      }
      return true;
    }
if (p === "/functions/tokentracker-context-health") {
      const home = path.resolve(qp, "..", "..", "..");
      const { computeContextHealth } = require("./context-health");
      json(res, computeContextHealth({ home, cwd: process.cwd(), env: process.env }));
      return true;
    }
throw new Error('Unsupported local statistics request');
}
await dispatch();return result;
}
module.exports={queryOffline};

module.exports.getTimeZoneContext=getTimeZoneContext;
