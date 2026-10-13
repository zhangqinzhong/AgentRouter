import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ProviderIcon } from "@/vendor/tokentracker/ui/dashboard/components/ProviderIcon";
type Tally = {
  name: string;
  sessions: number;
  prompts: number;
  tokens: number;
};
export function SessionActivity({
  zh,
  agents,
}: {
  zh: boolean;
  agents: { id: string; name: string }[];
}) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [metric, setMetric] = useState<"sessions" | "prompts">("sessions");
  const say = (cn: string, en: string) => (zh ? cn : en);
  useEffect(() => {
    let active = true;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    void window
      .agentrouter!.sessionWorkspace({ op: "insights", today })
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const days = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>(data.daily);
    const end = new Date(`${data.asOf}T12:00:00`);
    const start = new Date(end);
    start.setDate(start.getDate() - 370 - start.getDay());
    const rows = [];
    for (
      const date = new Date(start);
      date <= end;
      date.setDate(date.getDate() + 1)
    ) {
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      rows.push({ day, count: counts.get(day) || 0 });
    }
    return rows;
  }, [data]);
  const weekly = useMemo(
    () =>
      Array.from({ length: 53 }, (_, i) => ({
        week: i + 1,
        prompts: (data?.weekly || []).reduce(
          (n: number, s: any) => n + (s.weekly[i] || 0),
          0,
        ),
      })),
    [data],
  );
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {say("正在读取会话活动…", "Loading session activity…")}
      </p>
    );
  const name = (key: string) => agents.find((a) => a.id === key)?.name || key;
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-auto pb-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          [say("会话", "Sessions"), data.sessions],
          [say("提问", "Prompts"), data.prompts],
          [say("项目", "Projects"), data.projectsCount],
          [
            say("连续活跃", "Current streak"),
            `${data.currentStreak} ${say("天", "days")}`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <section className="rounded-xl border border-border p-5">
        <div className="mb-4 flex flex-wrap justify-between gap-2">
          <h2 className="font-semibold">
            {say("会话活跃日", "Session activity")}
          </h2>
          <span className="text-xs text-muted-foreground">
            {say("最长连续", "Longest streak")} {data.longestStreak}{" "}
            {say("天", "days")}
          </span>
        </div>
        <div className="overflow-auto">
          <div className="grid w-max grid-flow-col grid-rows-7 gap-1">
            {days.map((d) => (
              <div
                key={d.day}
                tabIndex={0}
                aria-label={`${d.day}: ${d.count} ${say("次提问", "prompts")}`}
                title={`${d.day}: ${d.count} ${say("次提问", "prompts")}`}
                className={`h-3 w-3 rounded-sm ${d.count === 0 ? "bg-muted" : d.count < 5 ? "bg-emerald-200 dark:bg-emerald-900" : d.count < 20 ? "bg-emerald-400" : d.count < 50 ? "bg-emerald-500" : "bg-emerald-700"}`}
              />
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {say(
            "主会话中的用户提问 · 不含子代理派发消息",
            "User prompts in main sessions · Subagent assignments excluded",
          )}
        </p>
      </section>
      <section className="rounded-xl border border-border p-5">
        <h2 className="mb-3 font-semibold">
          {say("每周提问", "Weekly prompts")}
        </h2>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={weekly}
              margin={{ left: 8, right: 20, top: 10, bottom: 8 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="week"
                minTickGap={40}
                tickFormatter={(w) =>
                  `${53 - Number(w)} ${say("周前", "weeks ago")}`
                }
              />
              <YAxis width={55} allowDecimals={false} />
              <Tooltip
                labelFormatter={(w) =>
                  `${53 - Number(w)} ${say("周前", "weeks ago")}`
                }
              />
              <Area
                type="monotone"
                dataKey="prompts"
                name={say("提问", "Prompts")}
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.12}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {say("最近 7 天", "Last 7 days")}: {data.thisWeek.prompts} ·{" "}
          {say("前 7 天", "Previous 7 days")}: {data.lastWeek.prompts}
        </p>
      </section>
      <div className="flex justify-end">
        <select
          className="rounded-lg border border-border bg-background p-2 text-sm"
          aria-label={say("排行指标", "Ranking metric")}
          value={metric}
          onChange={(e) => setMetric(e.target.value as typeof metric)}
        >
          <option value="sessions">{say("会话数", "Sessions")}</option>
          <option value="prompts">{say("提问数", "Prompts")}</option>
        </select>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {(
          [
            ["agents", say("客户端", "Clients")],
            ["projects", say("项目", "Projects")],
            ["models", say("模型", "Models")],
          ] as const
        ).map(([kind, title]) => (
          <section
            key={kind}
            className="min-w-0 rounded-xl border border-border p-5"
          >
            <h2 className="mb-4 font-semibold">{title}</h2>
            {[...(data[kind] || [])]
              .sort((a: Tally, b: Tally) => b[metric] - a[metric])
              .slice(0, 10)
              .map((r: Tally) => (
                <div
                  key={r.name}
                  className="mb-3 flex min-w-0 items-center gap-2 text-sm"
                >
                  {kind === "agents" && (
                    <ProviderIcon provider={r.name} size={16} />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={r.name}>
                    {kind === "agents" ? name(r.name) : r.name}
                  </span>
                  <span className="tabular-nums">{r[metric]}</span>
                </div>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
