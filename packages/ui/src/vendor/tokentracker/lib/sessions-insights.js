export function sessionOwnTokens(session) {
  return finiteValue(session?.own_total_tokens ?? session?.total_tokens);
}

export function sessionOwnCost(session) {
  return finiteValue(session?.own_cost_usd ?? session?.cost_usd);
}

function finiteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function sessionModels(session) {
  const observed = Array.isArray(session?.model_usage)
    ? session.model_usage.filter((row) => row && typeof row.model === "string" && row.model)
    : [];
  if (observed.length) return observed;
  return [{
    model: session?.model || "",
    total_tokens: sessionOwnTokens(session),
    cost_usd: sessionOwnCost(session),
    performance: session?.performance,
  }];
}

export function aggregateSessionPerformance(sessions) {
  const total = {
    estimated_output_tokens: 0,
    estimated_duration_ms: 0,
    estimated_request_count: 0,
    estimated_tokens_per_second: null,
    first_response_total_ms: 0,
    first_response_sample_count: 0,
    first_response_ms: null,
  };
  for (const session of sessions) {
    const performance = session?.performance;
    if (!performance) continue;
    const duration = finiteValue(performance.estimated_duration_ms);
    const output = finiteValue(performance.estimated_output_tokens);
    const count = finiteValue(performance.estimated_request_count);
    if (duration > 0 && output > 0 && count > 0) {
      total.estimated_output_tokens += output;
      total.estimated_duration_ms += duration;
      total.estimated_request_count += count;
    }
    const firstCount = finiteValue(performance.first_response_sample_count);
    const firstTotal = finiteValue(performance.first_response_total_ms);
    if (firstCount > 0 && firstTotal > 0) {
      total.first_response_total_ms += firstTotal;
      total.first_response_sample_count += firstCount;
    }
  }
  if (total.estimated_duration_ms > 0) {
    total.estimated_tokens_per_second = total.estimated_output_tokens * 1000 / total.estimated_duration_ms;
  }
  if (total.first_response_sample_count > 0) {
    total.first_response_ms = total.first_response_total_ms / total.first_response_sample_count;
  }
  return total;
}

export function summarizeSessions(sessions) {
  const seen = new Set();
  const distinct = sessions.filter((session) => {
    if (seen.has(session.session_hash)) return false;
    seen.add(session.session_hash);
    return true;
  });
  return {
    count: distinct.length,
    tokens: distinct.reduce((sum, session) => sum + sessionOwnTokens(session), 0),
    cost: distinct.reduce((sum, session) => sum + sessionOwnCost(session), 0),
    costIsPartial: distinct.some((session) => session.cost_is_partial),
    performance: aggregateSessionPerformance(distinct),
  };
}

export function sessionDateMs(session) {
  const date = Date.parse(session?.ended_at || session?.started_at || "");
  return Number.isFinite(date) ? date : 0;
}

export function sortSessions(sessions, sort) {
  return [...sessions].sort((a, b) => {
    const difference = sort === "cost"
      ? sessionOwnCost(b) - sessionOwnCost(a)
      : sort === "tokens"
        ? sessionOwnTokens(b) - sessionOwnTokens(a)
        : 0;
    return difference || sessionDateMs(b) - sessionDateMs(a);
  });
}

export function sessionDayKey(session) {
  const time = sessionDateMs(session);
  if (!time) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function groupSessions(sessions, mode) {
  const groups = new Map();
  for (const session of sessions) {
    const key = mode === "project" ? session.project_key || "" : sessionDayKey(session);
    const group = groups.get(key) || { key, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function parseSessionFilters(search) {
  const params = new URLSearchParams(search);
  const source = params.get("source");
  const dateValue = (key) => {
    const value = params.get(key) || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) && sessionDayKey({ ended_at: date.toISOString() }) === value ? value : "";
  };
  const from = dateValue("from");
  const to = dateValue("to");
  return {
    source: ["claude", "codex", "grok"].includes(source) ? source : "all",
    model: params.get("model") || "all",
    from,
    to,
  };
}

export function overlapsSessionDates(session, from, to) {
  let startMs = from ? new Date(`${from}T00:00:00`).getTime() : 0;
  let endMs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  if (startMs > endMs) {
    startMs = new Date(`${to}T00:00:00`).getTime();
    endMs = new Date(`${from}T23:59:59.999`).getTime();
  }
  const ended = Date.parse(session.ended_at || session.started_at || "");
  const started = Date.parse(session.started_at || session.ended_at || "");
  return (!Number.isFinite(ended) || ended >= startMs)
    && (!Number.isFinite(started) || started <= endMs);
}
