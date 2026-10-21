import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  Clock3,
  Coins,
  HeartPulse,
  Radio,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  MonitorQuery,
  MonitorReport,
  MonitorDimension,
} from "@agentrouter/core/contracts/monitor";
import {
  MonitorProviderNames,
  useMonitorLabel,
  card,
  control,
  Section,
  Segments,
  useM,
  number,
  money,
  duration,
  percent,
  stamp,
} from "./monitor/common";
import { health, initialQuery, saveQuery, ranges } from "./monitor/state";
import { Spark, Traffic, Latency } from "./monitor/charts";
import { Ranking, Failures } from "./monitor/rankings";
import { Flow, Heatmap } from "./monitor/flow";

export function MonitorCenter() {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    void window.agentrouter
      ?.getConfig()
      .then((config) => {
        if (disposed) return;
        const labels: Record<string, string> = {};
        for (const provider of config.Providers ?? []) {
          if (provider.id) labels[provider.id] = provider.name;
          labels[provider.name] = provider.name;
        }
        setNames(labels);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <MonitorProviderNames.Provider value={names}>
      <MonitorCenterContent />
    </MonitorProviderNames.Provider>
  );
}
function MonitorCenterContent() {
  const displayLabel = useMonitorLabel();
  const m = useM(),
    [query, setQuery] = useState<MonitorQuery>(initialQuery),
    [seconds, setSeconds] = useState(() => {
      try {
        const n = Number(localStorage.getItem("ar.monitor.refresh") ?? 30);
        return [0, 15, 30, 60, 300].includes(n) ? n : 30;
      } catch {
        return 30;
      }
    }),
    [nonce, setNonce] = useState(0),
    [data, setData] = useState<MonitorReport>(),
    [options, setOptions] = useState<MonitorReport["options"]>({
      models: [],
      providers: [],
      clients: [],
    }),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false);
  const queryKey = JSON.stringify(query),
    lastQuery = useRef(queryKey);
  useEffect(() => {
    saveQuery(query);
    try {
      localStorage.setItem("ar.monitor.refresh", String(seconds));
    } catch {}
    let disposed = false,
      busy = false;
    const changed = lastQuery.current !== queryKey;
    lastQuery.current = queryKey;
    // Keep mounted charts while loading the next window. Only initial load uses a skeleton.
    setRefreshing(true);
    const refresh = async () => {
      if (busy) return;
      busy = true;
      setRefreshing(true);
      try {
        const response = await window.agentrouter?.getUsageStats("24h", {
          scope: "gateway",
          includeProxy: true,
          monitorQuery: query,
        });
        if (!response?.monitorReport)
          throw new Error(
            m("监控接口没有返回数据", "Monitoring data unavailable"),
          );
        if (!disposed) {
          setData(response.monitorReport);
          setOptions(response.monitorReport.options);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
        if (!disposed) setRefreshing(false);
      }
    };
    // Coalesce rapid range/filter changes before starting another database query.
    const pending = window.setTimeout(() => { void refresh(); }, changed ? 120 : 0);
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = seconds
      ? window.setInterval(tick, seconds * 1000)
      : undefined;
    const visible = () => {
      if (seconds) tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      window.clearTimeout(pending);
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [queryKey, seconds, nonce]);
  const toggle = (dimension: MonitorDimension, key: string) =>
    setQuery((q) => ({
      ...q,
      [dimension]: q[dimension]?.includes(key)
        ? q[dimension]!.filter((x) => x !== key)
        : [...(q[dimension] ?? []), key],
    }));
  const zones = useMemo(() => [
    ...new Set([
      query.timeZone,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      "UTC",
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Asia/Kolkata",
      "Europe/London",
      "Europe/Berlin",
      "America/New_York",
      "America/Los_Angeles",
      "Australia/Sydney",
      ...((
        Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
      ).supportedValuesOf?.("timeZone") ?? []),
    ]),
  ], [query.timeZone]);
  const names = {
    models: m("模型", "Models"),
    providers: m("渠道", "Channels"),
    clients: m("调用方", "Clients"),
  };
  const labels = [
    m("1 小时", "1 hour"),
    m("6 小时", "6 hours"),
    m("24 小时", "24 hours"),
    m("今天", "Today"),
    m("7 天", "7 days"),
    m("14 天", "14 days"),
    m("30 天", "30 days"),
  ];
  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-5 py-7 sm:px-9">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold">
                {m("监控中心", "Monitor center")}
              </h1>
              <span
                role="status"
                className={`rounded-full px-2.5 py-1 text-xs ${error ? "bg-rose-500/10 text-rose-600" : "bg-emerald-500/10 text-emerald-600"}`}
              >
                {refreshing
                  ? m("正在更新…", "Updating…")
                  : error
                    ? m("更新失败", "Update failed")
                    : seconds
                      ? m("实时更新", "Live")
                      : m("自动刷新已暂停", "Auto refresh paused")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data
                ? `${stamp(data.from, data.query.timeZone)} – ${stamp(data.to, data.query.timeZone)} · ${data.query.timeZone} · ${m("更新于", "Updated")} ${stamp(data.generatedAt, data.query.timeZone, true)}`
                : m("网关请求监控", "Gateway request monitoring")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="monitor-zone">
              {m("时区", "Time zone")}
            </label>
            <div className="relative">
              <select
                id="monitor-zone"
                className={`${control} max-w-56 appearance-none pr-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
                value={query.timeZone}
                onChange={(e) =>
                  setQuery({ ...query, timeZone: e.target.value })
                }
              >
                {zones.map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
            <div className="relative">
              <select
                aria-label={m("刷新间隔", "Refresh interval")}
                className={`${control} appearance-none pr-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              >
                {[0, 15, 30, 60, 300].map((n) => (
                  <option value={n} key={n}>
                    {n === 0
                      ? m("关闭自动刷新", "Auto refresh off")
                      : n < 60
                        ? `${n} ${m("秒刷新", "seconds")}`
                        : `${n / 60} ${m("分钟刷新", "minutes")}`}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
            <button
              className={`${control} flex items-center gap-2`}
              disabled={refreshing}
              onClick={() => setNonce((x) => x + 1)}
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              {m("刷新", "Refresh")}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segments
            value={query.range}
            onChange={(range) => setQuery({ ...query, range })}
            label={m("监控时间范围", "Monitoring time range")}
            options={ranges.map((r, i) => [r, labels[i]])}
          />
          <div className="flex flex-wrap gap-2">
            {(["models", "providers", "clients"] as const).map((d) => (
              <details key={d} className="relative">
                <summary className={`${control} cursor-pointer list-none`}>
                  {names[d]}
                  {query[d]?.length ? ` (${query[d]!.length})` : " ▾"}
                </summary>
                <div className="absolute right-0 z-30 mt-2 max-h-72 w-64 overflow-y-auto rounded-xl border bg-background p-3 shadow-xl">
                  {options[d].length ? (
                    options[d].map((value) => (
                      <label
                        key={value}
                        className="flex cursor-pointer items-center gap-2 rounded p-2 text-xs hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={query[d]?.includes(value) ?? false}
                          onChange={() => toggle(d, value)}
                        />
                        <span className="truncate" title={value}>
                          {displayLabel(d, value)}
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {m("暂无选项", "No options")}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
        {(["models", "providers", "clients"] as const).some(
          (d) => query[d]?.length,
        ) ? (
          <div className="flex flex-wrap gap-2">
            {(["models", "providers", "clients"] as const).flatMap((d) =>
              (query[d] ?? []).map((value) => (
                <button
                  key={`${d}:${value}`}
                  className="rounded-full bg-blue-500/10 px-3 py-1 text-xs text-blue-600"
                  onClick={() => toggle(d, value)}
                >
                  {names[d]}: {displayLabel(d, value)} ×
                </button>
              )),
            )}
            <button
              className="text-xs text-muted-foreground"
              onClick={() =>
                setQuery({
                  range: query.range,
                  timeZone: query.timeZone,
                  models: [],
                  providers: [],
                  clients: [],
                })
              }
            >
              {m("清除筛选", "Clear filters")}
            </button>
          </div>
        ) : null}
      </header>
      {error ? (
        <div
          role="alert"
          className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600"
        >
          {error}
          {data
            ? ` · ${m("显示上次成功更新的数据", "Showing the last successful update")}`
            : ""}
        </div>
      ) : null}
      {!data ? (
        <div role="status" className="grid gap-5 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={`${card} h-44 animate-pulse bg-muted/30`}>
              {i === 0
                ? error
                  ? m("暂时无法加载", "Unable to load")
                  : m("正在加载监控数据…", "Loading monitoring data…")
                : null}
            </div>
          ))}
        </div>
      ) : (
        <div aria-busy={refreshing} className="space-y-5">
          <Summary report={data} />
          <Traffic report={data} />
          <div className="grid items-stretch gap-5 xl:grid-cols-2">
            <Latency report={data} />
            <Failures report={data} onSelect={toggle} />
          </div>
          <Ranking report={data} dimension="models" onSelect={toggle} />
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <Ranking report={data} dimension="providers" onSelect={toggle} />
            <Ranking report={data} dimension="clients" onSelect={toggle} />
          </div>
          <div className="grid items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
            <Flow report={data} onSelect={toggle} />
            <Heatmap report={data} />
          </div>
        </div>
      )}
    </div>
  );
}
function Summary({ report: r }: { report: MonitorReport }) {
  const m = useM(),
    h = health(r),
    c = r.current,
    p = r.previous,
    live = r.minutes,
    last = live.at(-1),
    recent = live.slice(-5),
    n = recent.reduce((s, x) => s + x.requests, 0),
    failed = recent.reduce((s, x) => s + x.failed, 0);
  const measured = recent.filter((x) => x.duration != null),
    success = measured.reduce((s, x) => s + x.success, 0),
    average = success
      ? measured.reduce((s, x) => s + (x.duration ?? 0) * x.success, 0) /
        success
      : null;
  const delta = (now: number | null, before: number | null, points = false) =>
    now == null || before == null || (!points && !before)
      ? null
      : points
        ? now - before
        : (now / before - 1) * 100;
  const tiles = [
    {
      label: m("请求数", "Requests"),
      value: number(c.requests),
      sub: `${number(c.requests / Math.max(1, (Date.parse(r.to) - Date.parse(r.from)) / 60000))} ${m("次/分", "requests/min")} · ${m("流式", "Streaming")} ${c.logSamples ? percent((c.streaming / c.logSamples) * 100) : "—"}`,
      values: r.series.map((x) => x.requests),
      change: delta(c.requests, p.requests),
      color: "#3b82f6",
      Icon: Activity,
      bad: false,
    },
    {
      label: m("成功率", "Success rate"),
      value: percent(c.successRate),
      sub: `${c.failed} ${m("次失败", "failed")}`,
      values: r.series.map((x) => x.successRate),
      change: delta(c.successRate, p.successRate, true),
      color: "#10b981",
      Icon: ShieldCheck,
      bad: false,
      points: true,
    },
    {
      label: m("P95 耗时", "P95 latency"),
      value: duration(r.latency.total.p95),
      sub: `${m("平均", "Average")} ${duration(c.duration)} · P50 ${duration(r.latency.total.p50)}`,
      values: r.series.map((x) => x.latencyP95),
      change: delta(r.latency.total.p95, r.latency.previousTotal.p95),
      color: "#6366f1",
      Icon: Clock3,
      bad: true,
    },
    {
      label: m("首字时间 P50", "TTFT P50"),
      value: duration(r.latency.firstToken.p50),
      sub: `P95 ${duration(r.latency.firstToken.p95)} · ${c.ttftSamples} ${m("个样本", "samples")}`,
      values: r.series.map((x) => x.ttftP50),
      change: delta(r.latency.firstToken.p50, r.latency.previousFirstToken.p50),
      color: "#8b5cf6",
      Icon: Zap,
      bad: true,
    },
    {
      label: m("Token 用量", "Token usage"),
      value: number(c.tokens),
      sub: `${m("缓存命中", "Cache")} ${percent(c.cacheRate)} · ${m("输出", "Output")} ${number(c.output)}`,
      values: r.series.map((x) => x.tokens),
      change: delta(c.tokens, p.tokens),
      color: "#a855f7",
      Icon: Zap,
      bad: false,
    },
    {
      label: m("费用", "Cost"),
      value: c.priced ? money(c.cost) : "—",
      sub: `${m("每千次请求", "Per 1K requests")} ${c.priced ? money((c.cost / Math.max(1, c.requests)) * 1000) : "—"} · ${m("计价覆盖", "Priced")} ${c.requests ? percent((c.priced / c.requests) * 100) : "—"}`,
      values: r.series.map((x) => (x.priced ? x.cost : null)),
      change: delta(c.priced ? c.cost : null, p.priced ? p.cost : null),
      color: "#f59e0b",
      Icon: Coins,
      bad: true,
    },
  ];
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <Section
          title={m("健康评分", "Health score")}
          actions={<HeartPulse className="h-5 w-5 text-teal-500" />}
        >
          <div className="relative mx-auto my-4 h-36 w-36">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
              <circle
                cx="60"
                cy="60"
                r="50"
                fill="none"
                className="text-muted"
                stroke="currentColor"
                strokeWidth="9"
              />
              <circle
                cx="60"
                cy="60"
                r="50"
                fill="none"
                stroke={h.score != null && h.score < 70 ? "#f59e0b" : "#14b8a6"}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={`${(h.score ?? 0) * Math.PI} 314.16`}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <strong className="text-4xl tabular-nums">
                {h.score ?? "—"}
              </strong>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
          </div>
          <div className="space-y-2 text-xs">
            <p>
              {m("成功率", "Success")}{" "}
              <b className="float-right">{percent(c.successRate)}</b>
            </p>
            <p>
              {m("需关注渠道", "Channels to watch")}{" "}
              <b className="float-right">{c.requests ? h.abnormal : "—"}</b>
            </p>
            <p>
              {m("平均耗时变化", "Avg latency change")}{" "}
              <b className="float-right">
                {h.latencyChange == null
                  ? "—"
                  : `${h.latencyChange > 0 ? "+" : ""}${h.latencyChange.toFixed(1)}%`}
              </b>
            </p>
          </div>
          <details className="mt-3 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">
              {m("评分规则", "Scoring rules")}
            </summary>
            <p className="mt-2">
              {m(
                "成功率 50%，渠道健康 25%，相对上期耗时 25%。缺少数据的项不参与评分；渠道至少 5 次请求才评级。",
                "Success 50%, channel health 25%, latency change 25%. Missing components are excluded; channels require 5 requests.",
              )}
            </p>
          </details>
        </Section>
        <Section
          title={m("实时流量", "Live traffic")}
          subtitle={m(
            "最近 60 分钟 · 受当前筛选影响",
            "Last 60 minutes · current filters",
          )}
          actions={<Radio className="h-5 w-5 text-blue-500" />}
        >
          <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              [m("当前 RPM", "Current RPM"), number(last?.requests)],
              [
                m("峰值 RPM", "Peak RPM"),
                number(Math.max(0, ...live.map((x) => x.requests))),
              ],
              [m("当前 TPM", "Current TPM"), number(last?.tokens)],
              [
                m("5 分钟成功率", "5-min success"),
                percent(n ? ((n - failed) / n) * 100 : null),
              ],
              [m("5 分钟平均耗时", "5-min avg latency"), duration(average)],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <strong className="mt-1 block text-xl tabular-nums">
                  {value}
                </strong>
              </div>
            ))}
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={live}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="at"
                  tickFormatter={(v) => stamp(v, r.query.timeZone, true)}
                  minTickGap={40}
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  width={30}
                  tick={{ fontSize: 10 }}
                  allowDecimals={false}
                />
                <Tooltip
                  labelFormatter={(v) => stamp(String(v), r.query.timeZone)}
                />
                <Bar
                  dataKey="requests"
                  name={m("请求数", "Requests")}
                  fill="#3b82f6"
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {m("当前分钟尚未结束", "Current minute is incomplete")}
          </p>
        </Section>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <section className={card} key={tile.label}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-3 text-sm text-muted-foreground">
                <span
                  className="rounded-xl p-2.5"
                  style={{
                    backgroundColor: tile.color + "15",
                    color: tile.color,
                  }}
                >
                  <tile.Icon className="h-5 w-5" />
                </span>
                {tile.label}
              </h2>
              <span
                title={`${m("比较时段", "Previous period")}: ${stamp(r.previousFrom, r.query.timeZone)} – ${stamp(r.previousTo, r.query.timeZone)}`}
                className={`rounded-full px-2 py-1 text-xs ${tile.change != null && tile.bad && tile.change > 0 ? "bg-rose-500/10 text-rose-600" : "bg-muted text-muted-foreground"}`}
              >
                {tile.change == null
                  ? "—"
                  : `${tile.change > 0 ? "↑ +" : tile.change < 0 ? "↓ " : ""}${tile.change.toFixed(1)}${tile.points ? "pt" : "%"}`}
              </span>
            </div>
            <strong className="mt-4 block text-3xl font-semibold tabular-nums">
              {tile.value}
            </strong>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">
              {tile.sub}
            </p>
            <Spark
              values={tile.values}
              color={tile.color}
              labels={r.series.map((x) => stamp(x.at, r.query.timeZone))}
              emptyLabels={r.series.map((x) =>
                x.requests
                  ? m("无有效样本", "No measured samples")
                  : m("无请求", "No requests"),
              )}
              formatValue={
                tile.label === m("成功率", "Success rate")
                  ? percent
                  : tile.label === m("P95 耗时", "P95 latency") ||
                      tile.label === m("首字时间 P50", "TTFT P50")
                    ? duration
                    : tile.label === m("费用", "Cost")
                      ? money
                      : number
              }
            />
            {tile.values.some((value) => value == null) ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {tile.label === m("成功率", "Success rate")
                  ? m("空白时段无请求", "Gaps indicate no requests")
                  : m(
                      "空白时段无请求或有效样本",
                      "Gaps indicate no requests or measured samples",
                    )}
              </p>
            ) : null}
          </section>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {m(
          "环比：上一等长时段；“今天”对比昨日同时间段。流式与首字指标仅统计保留的日志样本。",
          "Comparison: previous equal-length period; today compares the same elapsed period yesterday. Streaming and TTFT use retained log samples.",
        )}
      </p>
    </>
  );
}
