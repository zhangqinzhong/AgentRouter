import { useState, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MonitorReport } from "@agentrouter/core/contracts/monitor";
import {
  Section,
  Segments,
  Empty,
  useM,
  number,
  money,
  duration,
  stamp,
} from "./common";
export function Spark({
  values,
  color = "#3b82f6",
  labels,
  emptyLabels,
  formatValue = number,
}: {
  values: (number | null)[];
  color?: string;
  labels?: string[];
  emptyLabels?: string[];
  formatValue?: (value: number | null) => string;
}) {
  return (
    <div className="h-12 min-w-0" aria-hidden={labels ? undefined : true}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={values.map((value, i) => ({
            value,
            label: labels?.[i],
            empty: emptyLabels?.[i],
          }))}
        >
          {labels ? (
            <Tooltip
              filterNull={false}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload;
                return active && point ? (
                  <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                    <div>{point.label}</div>
                    <div>
                      {point.value == null
                        ? point.empty
                        : formatValue(point.value)}
                    </div>
                  </div>
                ) : null;
              }}
            />
          ) : null}
          <Area
            connectNulls={false}
            dot={labels ? { r: 1.5, strokeWidth: 0 } : false}
            dataKey="value"
            stroke={color}
            fill={color}
            fillOpacity={0.1}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
export function Traffic({ report: r }: { report: MonitorReport }) {
  const m = useM(),
    [view, setView] = useState<"requests" | "tokens" | "latency" | "cost">(
      "requests",
    ),
    [hidden, setHidden] = useState<string[]>([]);
  const zoomKey = `${JSON.stringify(r.query)}-${view}`;
  const [zoom, setZoom] = useState<{
    key: string;
    startIndex: number;
    endIndex: number;
  }>();
  const activeZoom = zoom?.key === zoomKey ? zoom : undefined;
  const data = useMemo(() => {
    let cumulative = 0;
    return r.series.map((p) => ({ ...p, cumulative: (cumulative += p.cost) }));
  }, [r.series]);
  const views = {
    requests: [
      ["success", m("成功", "Success"), "#3b82f6", "bar"],
      ["failed", m("失败", "Failed"), "#f43f5e", "bar"],
      ["successRate", m("成功率", "Success rate"), "#10b981", "rate"],
    ],
    tokens: [
      ["input", m("输入", "Input"), "#8b5cf6", "bar"],
      ["output", m("输出", "Output"), "#6366f1", "bar"],
      ["cached", m("缓存读写", "Cache read/write"), "#a78bfa", "bar"],
      ["cacheRate", m("缓存率", "Cache rate"), "#10b981", "rate"],
    ],
    latency: [
      ["duration", m("平均耗时", "Average latency"), "#6366f1", "line"],
      ["ttft", m("平均首字时间", "Average TTFT"), "#14b8a6", "line"],
    ],
    cost: [
      ["cost", m("费用", "Cost"), "#f59e0b", "bar"],
      ["cumulative", m("累计费用", "Cumulative cost"), "#f97316", "line"],
    ],
  };
  const fields = views[view],
    axis = (n: number) =>
      view === "cost" ? money(n) : view === "latency" ? duration(n) : number(n);
  return (
    <Section
      title={m("流量与可靠性", "Traffic & reliability")}
      subtitle={m(
        "拖动下方时间滑块缩放；点击图例显示或隐藏指标",
        "Drag the time slider to zoom; toggle series in the legend",
      )}
      actions={
        <Segments
          value={view}
          onChange={setView}
          label={m("趋势指标", "Trend metric")}
          options={[
            ["requests", m("请求", "Requests")],
            ["tokens", "Token"],
            ["latency", m("耗时", "Latency")],
            ["cost", m("费用", "Cost")],
          ]}
        />
      }
    >
      {r.current.requests ? (
        <>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                key={r.generatedAt}
                data={data}
                margin={{ top: 8, right: 55, bottom: 0, left: 15 }}
              >
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="at"
                  tickFormatter={(v) => stamp(v, r.query.timeZone)}
                  minTickGap={60}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="value"
                  tickFormatter={axis}
                  width={70}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  domain={[0, 100]}
                  hide={
                    !fields.some(
                      (x) => x[3] === "rate" && !hidden.includes(x[0]),
                    )
                  }
                  width={42}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  labelFormatter={(v) => stamp(String(v), r.query.timeZone)}
                  formatter={(value, name) => [
                    String(name).includes("率") ||
                    ["Success rate", "Cache rate"].includes(String(name))
                      ? `${Number(value).toFixed(2)}%`
                      : axis(Number(value)),
                    name,
                  ]}
                />
                {fields
                  .filter((x) => !hidden.includes(x[0]))
                  .map(([key, label, color, kind]) =>
                    kind === "bar" ? (
                      <Bar
                        key={key}
                        dataKey={key}
                        name={label}
                        fill={color}
                        yAxisId="value"
                        stackId={view === "cost" ? undefined : "stack"}
                        isAnimationActive={false}
                      />
                    ) : (
                      <Line
                        key={key}
                        dataKey={key}
                        name={label}
                        stroke={color}
                        dot={false}
                        strokeWidth={2}
                        yAxisId={kind === "rate" ? "rate" : "value"}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    ),
                  )}
                <Brush
                  key={zoomKey}
                  startIndex={
                    activeZoom
                      ? Math.min(activeZoom.startIndex, data.length - 1)
                      : undefined
                  }
                  endIndex={
                    activeZoom
                      ? Math.min(activeZoom.endIndex, data.length - 1)
                      : undefined
                  }
                  onChange={({ startIndex, endIndex }) => {
                    if (startIndex != null && endIndex != null)
                      setZoom({ key: zoomKey, startIndex, endIndex });
                  }}
                  ariaLabel={m("趋势时间范围", "Trend time range")}
                  dataKey="at"
                  height={24}
                  stroke="#94a3b8"
                  tickFormatter={(v) => stamp(v, r.query.timeZone)}
                  travellerWidth={10}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-4">
            {fields.map(([key, label, color]) => (
              <button
                key={key}
                aria-pressed={!hidden.includes(key)}
                className={`flex items-center gap-2 text-xs ${hidden.includes(key) ? "opacity-40" : ""}`}
                onClick={() =>
                  setHidden((old) =>
                    old.includes(key)
                      ? old.filter((x) => x !== key)
                      : [...old, key],
                  )
                }
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: color }}
                />
                {label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <Empty />
      )}
    </Section>
  );
}
export function Latency({ report: r }: { report: MonitorReport }) {
  const m = useM(),
    [metric, setMetric] = useState<"total" | "firstToken">("total"),
    stats = r.latency[metric];
  const data = stats.histogram.map((count, i) => ({
    count,
    label:
      i === 0
        ? `<${duration(r.latency.bounds[0])}`
        : i === r.latency.bounds.length
          ? `≥${duration(r.latency.bounds[i - 1])}`
          : `${r.latency.bounds[i - 1] / 1000}–${r.latency.bounds[i] / 1000}s`,
  }));
  return (
    <Section
      title={m("耗时分布", "Latency distribution")}
      subtitle={m(
        "成功请求 · 实测样本",
        "Successful requests · measured samples",
      )}
      actions={
        <Segments
          value={metric}
          onChange={setMetric}
          label={m("耗时类型", "Latency measurement")}
          options={[
            ["total", m("总耗时", "Total latency")],
            ["firstToken", m("首字时间", "First token")],
          ]}
        />
      }
    >
      {stats.samples ? (
        <>
          <div className="grid grid-cols-4 gap-2">
            {(["p50", "p90", "p95", "p99"] as const).map((key) => (
              <div key={key}>
                <span className="text-xs uppercase text-muted-foreground">
                  {key}
                </span>
                <strong className="mt-1 block text-lg tabular-nums">
                  {duration(stats[key])}
                </strong>
              </div>
            ))}
          </div>
          <div className="mt-5 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9 }}
                  interval={0}
                  angle={-25}
                  height={44}
                  textAnchor="end"
                />
                <YAxis
                  width={35}
                  tick={{ fontSize: 10 }}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={(value) => [
                    `${value} · ${((Number(value) / stats.samples) * 100).toFixed(1)}%`,
                    m("请求", "Requests"),
                  ]}
                />
                <Bar
                  dataKey="count"
                  fill="#6366f1"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {stats.samples} {m("个样本", "samples")} · {m("平均", "Average")}{" "}
            {duration(stats.average)} · {m("最大", "Max")} {duration(stats.max)}
          </p>
        </>
      ) : (
        <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
          {m("该时段没有可用的实测样本", "No measured samples in this period")}
        </div>
      )}
      {metric === "firstToken" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {m(
            "仅统计保留日志中已记录首字时间的成功流式请求",
            "Only successful streaming requests with retained TTFT measurements",
          )}
          {r.latency.coverageStart
            ? ` · ${m("最早样本", "Earliest sample")} ${stamp(r.latency.coverageStart, r.query.timeZone)}`
            : ""}
        </p>
      ) : null}
    </Section>
  );
}
