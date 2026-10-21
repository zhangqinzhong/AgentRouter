import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useState, useRef } from "react";
import type {
  MonitorDimension,
  MonitorRank,
  MonitorReport,
  MonitorFailure,
} from "@agentrouter/core/contracts/monitor";
import type { RequestLogEntry } from "@agentrouter/core/contracts/app";
import {
  useMonitorLabel,
  Section,
  Empty,
  useM,
  number,
  money,
  duration,
  percent,
  stamp,
  control,
  Segments,
} from "./common";
import { Spark } from "./charts";
export type SelectFilter = (dimension: MonitorDimension, key: string) => void;
export function Ranking({
  report: r,
  dimension,
  onSelect,
}: {
  report: MonitorReport;
  dimension: MonitorDimension;
  onSelect: SelectFilter;
}) {
  const displayLabel = useMonitorLabel();
  const m = useM(),
    [sort, setSort] = useState<keyof MonitorRank>("requests"),
    [ascending, setAscending] = useState(false),
    [all, setAll] = useState(false);
  const rows = [...r.rankings[dimension]].sort(
    (a, b) =>
      ((Number(a[sort]) || 0) - (Number(b[sort]) || 0)) * (ascending ? 1 : -1),
  );
  const title =
    dimension === "models"
      ? m("模型性能", "Model performance")
      : dimension === "providers"
        ? m("渠道健康", "Channel health")
        : m("调用方排行", "Client ranking");
  const columns: [keyof MonitorRank, string, (v: number | null) => string][] = [
    ["requests", m("请求", "Requests"), number],
    ["successRate", m("成功率", "Success rate"), percent],
    ["duration", m("平均耗时", "Avg latency"), duration],
    ...(dimension === "models"
      ? ([
          ["latencyP95", "P95", duration],
          ["ttftP50", m("首字 P50", "TTFT P50"), duration],
          [
            "outputSpeed",
            "tok/s",
            (n: number | null) => (n == null ? "—" : n.toFixed(1)),
          ],
        ] as [keyof MonitorRank, string, (v: number | null) => string][])
      : []),
    ["tokens", "Token", number],
    ["cost", m("费用", "Cost"), money],
  ];
  return (
    <Section
      title={title}
      subtitle={`${rows.length} ${m("项 · 点击名称筛选整页", "items · click a name to filter")}`}
    >
      {rows.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-right text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pb-3 text-left font-normal">
                    {m("名称", "Name")}
                  </th>
                  {columns.map(([key, label]) => (
                    <th key={key} className="px-2 pb-3 font-normal">
                      <button
                        onClick={() => {
                          if (sort === key) setAscending(!ascending);
                          else {
                            setSort(key);
                            setAscending(false);
                          }
                        }}
                      >
                        {label}
                        {sort === key ? (ascending ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                  <th className="pb-3 font-normal">{m("趋势", "Trend")}</th>
                </tr>
              </thead>
              <tbody>
                {(all ? rows : rows.slice(0, 8)).map((row) => (
                  <tr
                    key={row.key}
                    className="border-t border-border/60"
                  >
                    <td className="max-w-48 py-3 pr-3 text-left">
                      <button
                        aria-pressed={r.query[dimension]?.includes(row.key)}
                        onClick={() => onSelect(dimension, row.key)}
                        title={row.key}
                        className="max-w-48 truncate text-left font-medium hover:text-primary"
                      >
                        {dimension === "providers" ? (
                          <span
                            className={`mr-2 inline-block h-2 w-2 rounded-full ${row.requests < 5 ? "bg-slate-400" : (row.successRate ?? 100) < 95 ? "bg-rose-500" : (row.successRate ?? 100) < 99 ? "bg-amber-500" : "bg-emerald-500"}`}
                          />
                        ) : null}
                        {displayLabel(dimension, row.key)}
                      </button>
                      <div className="mt-1 h-1 w-full rounded bg-muted">
                        <div
                          className="h-1 rounded bg-blue-500"
                          style={{
                            width: `${(row.requests / r.current.requests) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                    {columns.map(([key, , format]) => (
                      <td key={key} className="px-2 tabular-nums">
                        {key === "cost" && !row.priced
                          ? "—"
                          : format(row[key] as number | null)}
                      </td>
                    ))}
                    <td className="w-24">
                      <Spark values={row.trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 8 ? (
            <button
              className="mt-3 text-xs text-primary"
              onClick={() => setAll(!all)}
            >
              {all
                ? m("收起", "Show less")
                : `${m("查看全部", "Show all")} ${rows.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <Empty />
      )}
      {dimension === "providers" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {m(
            "请求不足 5 次不评级；成功率低于 95% 为异常，低于 99% 为需关注。",
            "Fewer than 5 requests: unrated. Below 95%: unhealthy. Below 99%: watch.",
          )}
        </p>
      ) : null}
    </Section>
  );
}
export function Failures({
  report: r,
  onSelect,
}: {
  report: MonitorReport;
  onSelect: SelectFilter;
}) {
  const displayLabel = useMonitorLabel();
  const m = useM(),
    [dimension, setDimension] = useState<MonitorDimension | "status">(
      "providers",
    ),
    [expanded, setExpanded] = useState(false),
    [selected, setSelected] = useState<MonitorFailure>(),
    [detail, setDetail] = useState<RequestLogEntry>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const detailRequest = useRef(0);
  const close = () => {
    detailRequest.current++;
    setSelected(undefined);
  };
  const rows =
    dimension === "status"
      ? r.failureStatuses.map((s) => ({
          key: String(s.status),
          count: s.count,
        }))
      : r.rankings[dimension]
          .filter((x) => x.failed)
          .map((x) => ({ key: x.key, count: x.failed }))
          .sort((a, b) => b.count - a.count);
  const open = async (failure: MonitorFailure) => {
    const request = ++detailRequest.current;
    setSelected(failure);
    setLoading(false);
    setDetail(undefined);
    setError("");
    if (failure.logId == null) return;
    setLoading(true);
    try {
      const next = await window.agentrouter?.getRequestLogDetail({
        id: failure.logId,
      });
      if (request !== detailRequest.current) return;
      setDetail(next);
      if (!next)
        setError(m("日志明细已过保留期", "Log detail is no longer retained"));
    } catch (e) {
      if (request === detailRequest.current) setError(String(e));
    } finally {
      if (request === detailRequest.current) setLoading(false);
    }
  };
  return (
    <Section
      title={m("失败分析", "Failure analysis")}
      subtitle={`${number(r.current.failed)} ${m("次失败", "failures")} · ${percent(r.current.requests ? (r.current.failed / r.current.requests) * 100 : null)}`}
      actions={
        <Segments
          value={dimension}
          onChange={setDimension}
          label={m("失败分类", "Failure grouping")}
          options={[
            ["providers", m("渠道", "Channel")],
            ["models", m("模型", "Model")],
            ["clients", m("调用方", "Client")],
            ["status", m("状态码", "Status")],
          ]}
        />
      }
    >
      {r.current.failed ? (
        <>
          <div className="max-h-40 space-y-2 overflow-y-auto">
            {rows.map((row) => (
              <button
                disabled={dimension === "status"}
                key={row.key}
                className="block w-full rounded-lg p-2 text-left hover:bg-muted disabled:cursor-default"
                onClick={() =>
                  dimension !== "status" && onSelect(dimension, row.key)
                }
              >
                <div className="flex justify-between gap-2 text-xs">
                  <span className="truncate">
                    {row.key === "0" ? m("连接中断", "Interrupted") : displayLabel(dimension, row.key)}
                  </span>
                  <b>
                    {row.count} ·{" "}
                    {((row.count / r.current.failed) * 100).toFixed(1)}%
                  </b>
                </div>
                <div className="mt-1 h-1 rounded bg-muted">
                  <div
                    className="h-1 rounded bg-rose-400"
                    style={{
                      width: `${(row.count / r.current.failed) * 100}%`,
                    }}
                  />
                </div>
              </button>
            ))}
          </div>
          <h3 className="mb-2 mt-4 text-xs font-medium text-muted-foreground">
            {m("最近失败请求", "Recent failures")}
          </h3>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {(expanded ? r.failures : r.failures.slice(0, 5)).map((row) => (
              <button
                key={row.id + row.at}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted"
                onClick={() => void open(row)}
              >
                <time className="shrink-0 text-muted-foreground">
                  {stamp(row.at, r.query.timeZone, true)}
                </time>
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{row.model}</b>
                  <span className="block truncate text-muted-foreground">
                    {displayLabel("providers", row.provider)} · {row.client}
                  </span>
                </span>
                <span className="text-rose-500">{row.status || "—"}</span>
                <span>{m("详情", "Details")}</span>
              </button>
            ))}
          </div>
          {r.failures.length > 5 ? (
            <button
              className="mt-2 text-xs text-primary"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? m("收起", "Show less")
                : `${m("查看最近", "Show recent")} ${r.failures.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          {r.current.requests
            ? m("该时段没有失败请求", "No failed requests in this period")
            : m("该时段暂无请求", "No requests in this period")}
        </div>
      )}
      {selected ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <DialogContent className="max-h-[85vh] w-full max-w-xl overflow-auto p-6">
            <div className="flex justify-between">
              <DialogTitle>{m("失败请求详情", "Failure details")}</DialogTitle>
              <button className={control} onClick={close}>
                {m("关闭", "Close")}
              </button>
            </div>
            <dl className="mt-4 grid grid-cols-[90px_1fr] gap-3 break-all text-sm">
              {[
                [m("时间", "Time"), stamp(selected.at, r.query.timeZone)],
                [m("请求 ID", "Request ID"), selected.id],
                [
                  m("状态码", "Status"),
                  selected.status || m("连接中断", "Interrupted"),
                ],
                [m("模型", "Model"), selected.model],
                [
                  m("渠道", "Channel"),
                  displayLabel("providers", selected.provider),
                ],
                [m("调用方", "Client"), selected.client],
                [m("路径", "Path"), selected.path],
                [m("耗时", "Duration"), duration(selected.duration)],
              ].map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {loading ? (
              <p className="mt-4 animate-pulse">
                {m("加载日志明细…", "Loading log detail…")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-4 text-sm text-amber-600">
                {error}
              </p>
            ) : null}
            {failureMessage(detail) ? (
              <pre className="mt-4 whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                {failureMessage(detail)}
              </pre>
            ) : null}
            {selected.logId == null ? (
              <p className="mt-4 text-xs text-muted-foreground">
                {m("没有保留的日志明细", "No retained log detail")}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </Section>
  );
}

export function failureMessage(detail?: RequestLogEntry): string | undefined {
  if (detail?.error) return detail.error;
  if (detail?.responseBody?.encoding !== "utf8") return undefined;
  try {
    const body = JSON.parse(detail.responseBody.text);
    const message = typeof body?.error === "string" ? body.error : body?.error?.message || body?.message;
    return typeof message === "string" ? message.slice(0, 4000) : undefined;
  } catch { return undefined; }
}
