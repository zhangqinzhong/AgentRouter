import { useMemo } from "react";
import type {
  MonitorReport,
  MonitorDimension,
} from "@agentrouter/core/contracts/monitor";
import { Section, Empty, useM, useMonitorLabel } from "./common";
import type { SelectFilter } from "./rankings";
export function Flow({
  report: r,
  onSelect,
}: {
  report: MonitorReport;
  onSelect: SelectFilter;
}) {
  const m = useM();
  const displayLabel = useMonitorLabel();
  const graph = useMemo(() => {
    const dims: MonitorDimension[] = ["clients", "models", "providers"],
      fields = ["client", "model", "provider"] as const,
      colors = ["#3b82f6", "#8b5cf6", "#10b981"];
    const nodes = new Map<
      string,
      {
        id: string;
        name: string;
        dimension: MonitorDimension;
        other: boolean;
        x: number;
        y: number;
        h: number;
        color: string;
      }
    >();
    const top = dims.map(
      (d) => new Set(r.rankings[d].slice(0, 7).map((row) => row.key)),
    );
    const key = (i: number, value: string) =>
      `${i}:${top[i].has(value) ? value : "\u0000other"}`;
    const sizes = new Map<string, number>();
    const links = new Map<
      string,
      { source: string; target: string; value: number }
    >();
    for (const row of r.flows) {
      for (let i = 0; i < 3; i++) {
        const id = key(i, row[fields[i]]);
        sizes.set(id, (sizes.get(id) || 0) + row.requests);
      }
      for (let i = 0; i < 2; i++) {
        const source = key(i, row[fields[i]]),
          target = key(i + 1, row[fields[i + 1]]),
          id = JSON.stringify([source, target]);
        const old = links.get(id);
        if (old) old.value += row.requests;
        else links.set(id, { source, target, value: row.requests });
      }
    }
    const layerCounts = dims.map(
        (_, i) => [...sizes.keys()].filter((k) => k.startsWith(`${i}:`)).length,
      ),
      scale =
        (300 - Math.max(...layerCounts) * 12) / Math.max(1, r.current.requests);
    for (let i = 0; i < 3; i++) {
      let y = 24;
      for (const [id, count] of [...sizes]
        .filter(([k]) => k.startsWith(`${i}:`))
        .sort((a, b) => b[1] - a[1])) {
        const name = id.slice(2),
          other = name === "\u0000other";
        nodes.set(id, {
          id,
          name: other ? m("其他", "Other") : name,
          dimension: dims[i],
          other,
          x: 20 + i * 280,
          y,
          h: count * scale,
          color: colors[i],
        });
        y += count * scale + 12;
      }
    }
    const outgoing = new Map<string, number>(),
      incoming = new Map<string, number>();
    const paths = [...links.values()].map((link) => {
      const a = nodes.get(link.source)!,
        b = nodes.get(link.target)!,
        h = link.value * scale,
        y1 = a.y + (outgoing.get(a.id) || 0) + h / 2,
        y2 = b.y + (incoming.get(b.id) || 0) + h / 2;
      outgoing.set(a.id, (outgoing.get(a.id) || 0) + h);
      incoming.set(b.id, (incoming.get(b.id) || 0) + h);
      return {
        ...link,
        a,
        b,
        h,
        path: `M${a.x + 9},${y1} C${a.x + 130},${y1} ${b.x - 130},${y2} ${b.x},${y2}`,
      };
    });
    return { nodes: [...nodes.values()], paths };
  }, [r, m]);
  return (
    <Section
      title={m("流量流向", "Traffic flow")}
      subtitle={m(
        "调用方 → 模型 → 渠道 · 线宽按请求数",
        "Client → model → channel · width by requests",
      )}
    >
      {r.current.requests ? (
        <div className="overflow-x-auto">
          <svg
            viewBox="0 0 610 350"
            className="min-w-[520px] w-full"
            role="img"
            aria-label={m("请求流向图", "Request flow diagram")}
          >
            {graph.paths.map((p, i) => (
              <path
                key={i}
                d={p.path}
                fill="none"
                stroke={p.a.color}
                strokeOpacity={0.2}
                strokeWidth={Math.max(0.5, p.h)}
              >
                <title>
                  {p.a.name} → {p.b.name}: {p.value} {m("次请求", "requests")}
                </title>
              </path>
            ))}
            {graph.nodes.map((n) => (
              <g
                key={n.id}
                role={n.other ? undefined : "button"}
                tabIndex={n.other ? undefined : 0}
                aria-label={n.name}
                onClick={() => !n.other && onSelect(n.dimension, n.name)}
                onKeyDown={(e) => {
                  if (!n.other && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(n.dimension, n.name);
                  }
                }}
                className={n.other ? "" : "cursor-pointer"}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={9}
                  height={Math.max(1, n.h)}
                  rx={2}
                  fill={n.color}
                />
                <text
                  x={n.x === 580 ? n.x - 5 : n.x + 15}
                  y={n.y + Math.max(7, n.h / 2)}
                  textAnchor={n.x === 580 ? "end" : "start"}
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="currentColor"
                >
                  {displayLabel(n.dimension, n.name).length > 24
                    ? displayLabel(n.dimension, n.name).slice(0, 23) + "…"
                    : displayLabel(n.dimension, n.name)}
                </text>
                <title>{n.name}</title>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <Empty />
      )}
    </Section>
  );
}
export function Heatmap({ report: r }: { report: MonitorReport }) {
  const m = useM();
  const days = [
    m("周日", "Sun"),
    m("周一", "Mon"),
    m("周二", "Tue"),
    m("周三", "Wed"),
    m("周四", "Thu"),
    m("周五", "Fri"),
    m("周六", "Sat"),
  ];
  const max = Math.max(1, ...r.heatmap.map((c) => c.requests));
  const hours = Array.from({ length: 24 }, (_, hour) =>
    r.heatmap
      .filter((c) => c.hour === hour)
      .reduce((sum, c) => sum + c.requests, 0),
  );
  const maxHour = Math.max(1, ...hours);
  const color = (level: number) =>
    level
      ? `rgba(59,130,246,${[0, 0.18, 0.38, 0.65, 1][level]})`
      : "var(--muted)";
  const intensity = (value: number) =>
    value ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4))) : 0;
  return (
    <Section
      title={m("活跃时段", "Active hours")}
      subtitle={`${m("所选时间范围", "Selected period")} · ${r.query.timeZone}`}
    >
      <div className="overflow-x-auto pb-1">
        <div
          className="grid min-w-[350px] gap-[3px]"
          style={{ gridTemplateColumns: "32px repeat(24,minmax(0,1fr))" }}
        >
          {[1, 2, 3, 4, 5, 6, 0].map((day) => (
            <div key={day} className="contents">
              <span className="self-center text-[10px] text-muted-foreground">
                {days[day]}
              </span>
              {Array.from({ length: 24 }, (_, hour) => {
                const c = r.heatmap.find(
                  (c) => c.weekday === day && c.hour === hour,
                ) ?? { requests: 0, failed: 0 };
                const label = `${days[day]} ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00 · ${c.requests} ${m("次请求", "requests")} · ${c.failed} ${m("次失败", "failures")}`;
                return (
                  <div
                    key={hour}
                    tabIndex={0}
                    className="aspect-square rounded-[2px] outline-offset-1 hover:ring-1 hover:ring-foreground/50 focus-visible:outline"
                    style={{ background: color(intensity(c.requests)) }}
                    title={label}
                    aria-label={label}
                  />
                );
              })}
            </div>
          ))}
          <span />
          {hours.map((value, hour) => (
            <div
              key={`bar-${hour}`}
              className="mt-2 flex h-12 items-end"
              title={`${hour}:00 · ${value} ${m("次请求", "requests")}`}
            >
              <div
                className="w-full rounded-t-sm"
                style={{
                  height: `${value ? Math.max(6, (value / maxHour) * 100) : 4}%`,
                  background: value ? "rgba(59,130,246,.55)" : "var(--muted)",
                }}
              />
            </div>
          ))}
          <span />
          {hours.map((_, hour) => (
            <span
              key={`hour-${hour}`}
              className="pt-1 text-center text-[10px] tabular-nums text-muted-foreground"
            >
              {[0, 6, 12, 18, 23].includes(hour)
                ? String(hour).padStart(2, "0")
                : ""}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="mr-auto">
          {m("每小时请求分布", "Hourly request distribution")}
        </span>
        <span className="mr-1">{m("少", "Less")}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: color(level) }}
            aria-hidden="true"
          />
        ))}
        <span className="ml-1">{m("多", "More")}</span>
      </div>
    </Section>
  );
}
