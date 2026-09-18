import {
  AgentAnalysisSessionSelection, AgentAnalysisSnapshot, AgentAnalysisTracePayloadFullResult, AgentAnalysisTracePayloadRequest, AgentAnalysisTraceRun, AgentFilterValue, agentAnalysisRangeOptions,
  agentFilterOptions, agentKindLabel, Badge, Button,
  ChevronDown, ChevronRight, CircleAlert, cn, compactId, compactUserAgent,
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle,
  formatBytes, formatCompactNumber, formatDuration, formatLogDateTime, formatPercentFixed,
  formatUsdCost, LoaderCircle,
  motion, normalizeAgentFilterValue, ReactNode, RefreshCw, RequestLogEntry,
  Select, Tabs, TabsList, TabsTrigger, translateOptions, UsageStatsRange,
  useAppText, useEffect, useMemo, useState, X
} from "../shared/index";
import { LogExpandedDetails } from "./network-logs";

export function AgentAnalysisView({
  agentFilter,
  error,
  loading,
  range,
  refreshAnalysis,
  selectedSession,
  setAgentFilter,
  setRange,
  setSelectedSession,
  snapshot
}: {
  agentFilter: AgentFilterValue;
  error: string;
  loading: boolean;
  range: UsageStatsRange;
  refreshAnalysis: () => void;
  selectedSession?: AgentAnalysisSessionSelection;
  setAgentFilter: (value: AgentFilterValue) => void;
  setRange: (range: UsageStatsRange) => void;
  setSelectedSession: (value?: AgentAnalysisSessionSelection) => void;
  snapshot: AgentAnalysisSnapshot;
}) {
  const t = useAppText();

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="flex h-full min-h-0 min-w-0 flex-col gap-4 pr-1"
      initial={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">{t("Sessions")}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {formatCompactNumber(snapshot.sessions.length)} {t("Sessions")} / {formatCompactNumber(snapshot.scannedRequestCount)} {t("Requests")}
          </div>
        </div>
        <div className="min-w-0 flex-1" />
        <Select
          aria-label={t("Filter agent")}
          className="h-8 w-[160px] bg-[length:14px] px-2 pr-7 text-[12px]"
          onValueChange={(value) => setAgentFilter(normalizeAgentFilterValue(value))}
          options={translateOptions(agentFilterOptions, t)}
          value={agentFilter}
        />
        <div className="flex rounded-md border border-border bg-background p-0.5">
          {agentAnalysisRangeOptions.map((option) => (
            <Button
              className={cn(
                "h-7 rounded px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
                range === option.value && "bg-card text-foreground shadow-sm"
              )}
              key={option.value}
              onClick={() => setRange(option.value)}
              type="button"
              unstyled
            >
              {t(option.label)}
            </Button>
          ))}
        </div>
        <Button aria-label={t("Refresh observability")} className="h-8 gap-1.5 px-2.5 text-[12px]" onClick={refreshAnalysis} title={t("Refresh observability")} type="button" variant="outline">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {t("Refresh")}
        </Button>
      </div>

      {error ? (
        <div className="flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {snapshot.requestScanTruncated ? (
        <AnalysisNotice>
          {t("Analysis is limited to the newest")} {formatCompactNumber(snapshot.requestScanLimit)} {t("requests in the selected range.")}
        </AnalysisNotice>
      ) : null}

      {selectedSession || snapshot.selectedSession ? (
        <AgentSessionDetailCard
          clearSession={() => setSelectedSession(undefined)}
          detail={snapshot.selectedSession}
          loading={loading}
          selectedSession={selectedSession}
        />
      ) : null}

      <section className="min-h-0 flex-1">
        <AgentSessionsCard
          onSelectSession={setSelectedSession}
          selectedSession={selectedSession}
          sessions={snapshot.sessions}
        />
      </section>
    </motion.div>
  );
}

function AgentSessionDetailCard({
  clearSession,
  detail,
  loading,
  selectedSession
}: {
  clearSession: () => void;
  detail?: AgentAnalysisSnapshot["selectedSession"];
  loading: boolean;
  selectedSession?: AgentAnalysisSessionSelection;
}) {
  const t = useAppText();
  const session = detail?.session;
  const headerLabel = session
    ? `${t(agentKindLabel(session.agent))} / ${compactId(session.id)}`
    : selectedSession
      ? `${t(agentKindLabel(selectedSession.agent))} / ${compactId(selectedSession.id)}`
      : t("Session");
  const [detailTab, setDetailTab] = useState<AgentSessionDetailTab>("trace");

  return (
    <Dialog className="items-start" onOpenChange={(open) => !open && clearSession()} open>
      <DialogContent className="h-[calc(100dvh-1.5rem)] max-w-[1200px] origin-top sm:h-[min(900px,calc(100dvh-3rem))]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Trace Detail")}</DialogTitle>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={session?.id ?? selectedSession?.id}>
              {headerLabel}
            </div>
          </div>
          <Button aria-label={t("Close")} onClick={clearSession} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-3.5 w-3.5" />
          </Button>
        </DialogHeader>
        <DialogBody className={detailTab === "trajectory" ? "overflow-hidden" : undefined}>
        {!detail ? (
          <AnalysisEmptyState label={t(loading ? "Loading session metrics" : "Session not found or outside the selected range")} />
        ) : (
          <div className={detailTab === "trajectory" ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
            <AgentSessionDetailTabs activeTab={detailTab} setActiveTab={setDetailTab} />

            {detailTab === "trace" ? <AgentTracePanel trace={detail.trace} /> : null}
            {detailTab === "trajectory" ? <AgentSessionTrajectoryPanel detail={detail} /> : null}
            {detailTab === "requests" ? <AgentSessionRequestsPanel detail={detail} /> : null}
          </div>
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type AgentSessionDetailTab = "requests" | "trace" | "trajectory";

function AgentSessionDetailTabs({
  activeTab,
  setActiveTab
}: {
  activeTab: AgentSessionDetailTab;
  setActiveTab: (tab: AgentSessionDetailTab) => void;
}) {
  const t = useAppText();
  const tabs: Array<{ label: string; value: AgentSessionDetailTab }> = [
    { label: "Call chain", value: "trace" },
    { label: "Session Trajectory", value: "trajectory" },
    { label: "Session Records", value: "requests" }
  ];

  return (
    <Tabs
      className="inline-flex max-w-full"
      onValueChange={(value) => setActiveTab(value as AgentSessionDetailTab)}
      value={activeTab}
    >
      <TabsList aria-label={t("Trace Detail")} className="w-fit max-w-full flex-wrap items-center gap-1 rounded-md border border-border bg-background p-1">
        {tabs.map((tab) => (
          <TabsTrigger
            className="h-8 rounded px-3 text-[12px] font-medium data-[state=active]:bg-card data-[state=active]:text-foreground"
            key={tab.value}
            value={tab.value}
          >
            {t(tab.label)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function AgentSessionRequestsPanel({ detail }: { detail: AgentSessionDetail }) {
  const t = useAppText();
  const requests = useMemo(() => [...detail.requests].sort(compareSessionRequestsByTime), [detail.requests]);
  const [selectedRequestLogId, setSelectedRequestLogId] = useState<number>();

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold">{t("Session Records")}</div>
      </div>
      {requests.length === 0 ? (
        <AnalysisEmptyState label={t("No session records")} />
      ) : (
        <div className={cn("max-h-[620px]", agentListFrameClassName)}>
          <table className={cn("min-w-[1060px]", agentListTableClassName)}>
            <thead className={agentListHeadClassName}>
              <tr>
                <th className="px-3 py-2 font-semibold">{t("Time")}</th>
                <th className="px-3 py-2 font-semibold">{t("Status")}</th>
                <th className="px-3 py-2 font-semibold">{t("Route")}</th>
                <th className="px-3 py-2 font-semibold">{t("Model")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Tools")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Token")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Cost")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Duration")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Details")}</th>
              </tr>
            </thead>
            <tbody className={agentListBodyClassName}>
              {requests.map((request) => (
                <tr className={agentListRowClassName()} key={request.id}>
                  <td className="px-3 py-2 font-mono">{formatLogDateTime(request.createdAt)}</td>
                  <td className="px-3 py-2 font-semibold">{request.statusCode || "-"}</td>
                  <td className="max-w-[140px] px-3 py-2" title={formatRouteReason(request.routeReason)}>{formatRouteReason(request.routeReason)}</td>
                  <td className="max-w-[300px] px-3 py-2" title={`${request.provider}/${request.model}`}>{request.provider}/{request.model}</td>
                  <td className="px-3 py-2 text-right" title={request.tools.join(", ")}>{formatCompactNumber(request.toolCallCount)}</td>
                  <td className="px-3 py-2 text-right">{formatCompactNumber(request.totalTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatUsdCost(request.costUsd ?? 0)}</td>
                  <td className="px-3 py-2 text-right">{formatDuration(request.durationMs)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      className="h-7 px-2 text-[11px]"
                      onClick={() => setSelectedRequestLogId(request.id)}
                      type="button"
                      variant="outline"
                    >
                      {t("View details")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {typeof selectedRequestLogId === "number" ? (
        <AgentSessionRequestLogDialog
          onClose={() => setSelectedRequestLogId(undefined)}
          requestLogId={selectedRequestLogId}
        />
      ) : null}
    </div>
  );
}

function AgentSessionRequestLogDialog({
  onClose,
  requestLogId
}: {
  onClose: () => void;
  requestLogId: number;
}) {
  const t = useAppText();
  const [entry, setEntry] = useState<RequestLogEntry>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setEntry(undefined);
    setError("");
    setLoading(true);

    if (!window.agentrouter?.getRequestLogDetail) {
      setError(t("Request log detail is unavailable."));
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void window.agentrouter.getRequestLogDetail({ id: requestLogId })
      .then((detail) => {
        if (!active) {
          return;
        }
        if (detail) {
          setEntry(detail);
        } else {
          setError(t("Request log not found."));
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [requestLogId, t]);

  return (
    <Dialog className="items-start" onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="h-[calc(100dvh-1.5rem)] max-w-[1180px] origin-top sm:h-[min(820px,calc(100dvh-3rem))]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Request Log")}</DialogTitle>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={String(requestLogId)}>
              #{requestLogId}{entry ? ` · ${entry.method} ${entry.path}` : ""}
            </div>
          </div>
          <Button aria-label={t("Close")} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-3.5 w-3.5" />
          </Button>
        </DialogHeader>
        <DialogBody className="overflow-auto p-0">
          {entry ? (
            <LogExpandedDetails detailError={error} detailLoading={loading} entry={entry} />
          ) : (
            <div className="flex min-h-[360px] items-center justify-center px-4 py-8 text-center text-[12px] text-muted-foreground">
              {loading ? (
                <div className="flex items-center gap-2">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  <span>{t("Loading full payload...")}</span>
                </div>
              ) : (
                <div className={cn("rounded-md border px-4 py-3 font-semibold", error && "border-rose-200 bg-rose-50 text-rose-700")}>
                  {error || t("Request log not found.")}
                </div>
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function AgentSessionTrajectoryPanel({ detail }: { detail: AgentSessionDetail }) {
  const t = useAppText();
  const trajectory = useMemo(() => buildAgentTrajectoryTree(detail), [detail]);
  const expandableNodeIds = useMemo(() => trajectory.flat.filter(trajectoryNodeHasVisibleChildren).map((node) => node.id), [trajectory.flat]);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set(expandableNodeIds));
  const [query, setQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(true);
  const visibleRows = useMemo(() => visibleTrajectoryRows(trajectory.roots, expandedNodeIds, query), [expandedNodeIds, query, trajectory.roots]);
  const listNodes = useMemo(() => trajectory.flat.filter(isTrajectoryListNode), [trajectory.flat]);
  const defaultSelectedNode =
    listNodes.find((node) => node.kind === "assistant" && node.content.trim()) ??
    listNodes.find((node) => node.content.trim()) ??
    listNodes[0];
  const selectedNode = listNodes.find((node) => node.id === selectedNodeId) ?? defaultSelectedNode;
  const callCount = detail.trace.llmRunCount + detail.trace.toolRunCount + detail.trace.subagentRunCount;

  useEffect(() => {
    setExpandedNodeIds(new Set(expandableNodeIds));
  }, [detail.conversation.length, detail.requests.length, detail.session.id, detail.trace.runCount, expandableNodeIds]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/70 bg-card/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">{t("Session Trajectory")}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={detail.trace.sessionId}>
            {compactId(detail.trace.sessionId)} | {formatLogDateTime(detail.trace.startedAt)} - {formatLogDateTime(detail.trace.endedAt)}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Badge variant="outline">{t("Duration")} {formatDuration(detail.trace.durationMs)}</Badge>
          <Badge variant="outline">{formatCompactNumber(detail.conversation.length)} {t("Turns")}</Badge>
          <Badge variant="outline">{formatCompactNumber(callCount)} {t("Calls")}</Badge>
          <input
            aria-label={t("Search")}
            className="h-7 w-[190px] rounded-md border border-border bg-background px-2 text-[11px] outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search")}
            value={query}
          />
        </div>
      </div>

      <div className={cn(
        "grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden",
        detailDrawerOpen && "lg:grid-cols-[minmax(0,1fr)_430px]"
      )}>
        <div className={cn("min-h-0 min-w-0 overflow-auto", detailDrawerOpen && "border-b border-border/60 lg:border-b-0 lg:border-r")}>
          {listNodes.length === 0 ? (
            <AnalysisEmptyState label={t("No trajectory events")} />
          ) : visibleRows.length === 0 ? (
            <AnalysisEmptyState label={t("No matching events")} />
          ) : (
            <div className="divide-y divide-border/50">
              {visibleRows.map(({ level, node }) => (
                <AgentTrajectoryNodeRow
                  expanded={expandedNodeIds.has(node.id)}
                  key={node.id}
                  level={level}
                  node={node}
                  selected={selectedNode?.id === node.id}
                  onSelect={() => {
                    setSelectedNodeId(node.id);
                    setDetailDrawerOpen(true);
                  }}
                  onToggle={() => toggleNode(node.id)}
                />
              ))}
            </div>
          )}
        </div>
        {detailDrawerOpen ? (
          <AgentTrajectoryDetailPanel
            node={selectedNode}
            onClose={() => setDetailDrawerOpen(false)}
          />
        ) : null}
      </div>
    </section>
  );
}

export const agentListSurfaceClassName = "rounded-md border border-border/70 bg-card/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const agentListFrameClassName = cn("overflow-auto", agentListSurfaceClassName);
export const agentListTableClassName = "w-full border-collapse text-left text-[11px]";
const agentListHeadClassName = "sticky top-0 z-10 border-b border-border/70 bg-muted/80 text-muted-foreground backdrop-blur [&_th]:min-w-[64px] [&_th]:whitespace-nowrap";
export const agentListBodyClassName = "divide-y divide-border/50";

export function agentListRowClassName({
  danger,
  selected,
  warning
}: {
  danger?: boolean;
  selected?: boolean;
  warning?: boolean;
} = {}) {
  return cn(
    "bg-card/40 transition-colors hover:bg-muted/30",
    danger && "bg-rose-500/5 hover:bg-rose-500/10",
    warning && "bg-amber-500/5 hover:bg-amber-500/10",
    selected && "bg-teal-500/10 shadow-[inset_2px_0_0_rgba(20,184,166,0.7)] hover:bg-teal-500/15"
  );
}

type AgentSessionDetail = NonNullable<AgentAnalysisSnapshot["selectedSession"]>;
type AgentTraceDetail = AgentSessionDetail["trace"];
type AgentConversationTurn = AgentSessionDetail["conversation"][number];
type AgentConversationItem = NonNullable<AgentConversationTurn["messages"]>[number];
type TracePayloadPreviewValue = NonNullable<NonNullable<AgentAnalysisTraceRun["tool"]>["input"]>;
type AgentSyntheticTrajectoryNodeKind = "tool-result";
type AgentTrajectoryNodeKind = AgentAnalysisTraceRun["kind"] | AgentConversationItem["role"] | AgentSyntheticTrajectoryNodeKind;
type AgentTrajectoryDetailTab = "preview" | "raw";

type AgentTrajectoryNode = {
  children: AgentTrajectoryNode[];
  content: string;
  costUsd?: number;
  createdAt: string;
  durationMs: number;
  error?: string;
  id: string;
  kind: AgentTrajectoryNodeKind;
  model?: string;
  offsetMs: number;
  provider?: string;
  requestId?: string;
  requestLogId?: number;
  run?: AgentAnalysisTraceRun;
  message?: AgentConversationItem;
  sourcePreview?: boolean;
  sourceTruncated?: boolean;
  status: AgentAnalysisTraceRun["status"];
  statusCode?: number;
  stepIndex: number;
  title: string;
  totalTokens: number;
  truncated?: boolean;
  turn?: AgentConversationTurn;
  turnIndex?: number;
};

type AgentTrajectoryVisibleRow = {
  level: number;
  node: AgentTrajectoryNode;
};

function compareSessionRequestsByTime(left: AgentSessionDetail["requests"][number], right: AgentSessionDetail["requests"][number]): number {
  return sortableTimestamp(left.createdAt) - sortableTimestamp(right.createdAt) || left.id - right.id;
}

function compareConversationTurnsByTime(left: AgentConversationTurn, right: AgentConversationTurn): number {
  return sortableTimestamp(left.createdAt) - sortableTimestamp(right.createdAt) || left.id - right.id;
}

function compareTraceRunsByTime(left: AgentAnalysisTraceRun, right: AgentAnalysisTraceRun): number {
  return (
    sortableTimestamp(left.startedAt) - sortableTimestamp(right.startedAt) ||
    left.offsetMs - right.offsetMs ||
    left.depth - right.depth ||
    left.id.localeCompare(right.id)
  );
}

function sortableTimestamp(value: string | undefined): number {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

function buildAgentTrajectoryTree(detail: AgentSessionDetail): { flat: AgentTrajectoryNode[]; roots: AgentTrajectoryNode[] } {
  const sortedRuns = [...detail.trace.runs].sort(compareTraceRunsByTime);
  const requestRunsByRequestId = new Map<string, AgentAnalysisTraceRun[]>();
  const requestByRequestId = new Map(detail.requests.map((request) => [request.requestId, request]));
  const roots: AgentTrajectoryNode[] = [];
  const handledRunIds = new Set<string>();

  for (const run of sortedRuns) {
    if (run.requestId && !(run.kind === "agent" && run.id === detail.trace.rootRunId)) {
      const requestRuns = requestRunsByRequestId.get(run.requestId) ?? [];
      requestRuns.push(run);
      requestRunsByRequestId.set(run.requestId, requestRuns);
    }
  }

  [...detail.conversation].sort((left, right) => compareConversationTurnsByTime(left, right)).forEach((turn, index) => {
    const requestRuns = requestRunsByRequestId.get(turn.requestId) ?? [];
    const request = requestByRequestId.get(turn.requestId);
    const status = turn.statusCode >= 400 ? "error" : "success";
    const turnStartMs = sortableTimestamp(turn.createdAt);
    const traceStartMs = sortableTimestamp(detail.trace.startedAt);
    const offsetMs = Math.max(0, turnStartMs - traceStartMs);
    const messageNodes = conversationItemsForTurn(turn).map((message, messageIndex) =>
      conversationTrajectoryNode({
        content: message.content,
        id: `conversation:${turn.id}:${message.id}`,
        index,
        kind: message.role,
        message,
        offsetMs: offsetMs + messageIndex * 0.001,
        requestTokens: message.role === "assistant"
          ? request?.outputTokens ?? 0
          : message.role === "user"
            ? request?.inputTokens ?? 0
            : 0,
        sourcePreview: message.sourcePreview,
        sourceTruncated: message.sourceTruncated,
        status,
        title: trajectoryRoleTitle(message.role),
        truncated: message.truncated,
        turn
      })
    );

    roots.push(...messageNodes);

    const operationParent =
      [...messageNodes].reverse().find((node) => node.kind === "user") ??
      messageNodes.find((node) => node.kind !== "assistant") ??
      messageNodes[0];

    appendRunNodesToTrajectory({
      handledRunIds,
      parent: operationParent,
      roots,
      runs: requestRuns
    });
  });

  appendRunNodesToTrajectory({
    handledRunIds,
    roots,
    runs: sortedRuns.filter((run) => !(run.kind === "agent" && run.id === detail.trace.rootRunId) && !handledRunIds.has(run.id))
  });

  sortTrajectoryNodes(roots);
  const flat: AgentTrajectoryNode[] = [];
  let stepIndex = 1;
  const collect = (node: AgentTrajectoryNode) => {
    node.stepIndex = stepIndex;
    stepIndex += 1;
    flat.push(node);
    node.children.forEach(collect);
  };
  roots.forEach(collect);
  return { flat, roots };
}

function appendRunNodesToTrajectory({
  handledRunIds,
  parent,
  roots,
  runs
}: {
  handledRunIds: Set<string>;
  parent?: AgentTrajectoryNode;
  roots: AgentTrajectoryNode[];
  runs: AgentAnalysisTraceRun[];
}) {
  const runByRunId = new Map(runs.map((run) => [run.id, run]));
  const runNodeByRunId = new Map<string, AgentTrajectoryNode>();
  for (const run of runs) {
    if (handledRunIds.has(run.id)) {
      continue;
    }
    handledRunIds.add(run.id);
    if (!isTrajectoryTraceRunVisible(run)) {
      continue;
    }
    const node = traceRunTrajectoryNode(run);
    runNodeByRunId.set(run.id, node);
  }

  for (const run of runs) {
    const node = runNodeByRunId.get(run.id);
    if (!node) {
      continue;
    }
    const parentNode = findVisibleTrajectoryRunParent(run, runByRunId, runNodeByRunId);
    if (parentNode) {
      parentNode.children.push(node);
    } else if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
}

function findVisibleTrajectoryRunParent(
  run: AgentAnalysisTraceRun,
  runByRunId: Map<string, AgentAnalysisTraceRun>,
  runNodeByRunId: Map<string, AgentTrajectoryNode>
): AgentTrajectoryNode | undefined {
  let parentId = run.parentId;
  while (parentId) {
    const visibleParent = runNodeByRunId.get(parentId);
    if (visibleParent) {
      return visibleParent;
    }
    parentId = runByRunId.get(parentId)?.parentId;
  }
  return undefined;
}

function isTrajectoryTraceRunVisible(run: AgentAnalysisTraceRun): boolean {
  return run.kind === "subagent" || run.kind === "tool";
}

function traceRunTrajectoryNode(run: AgentAnalysisTraceRun): AgentTrajectoryNode {
  const node: AgentTrajectoryNode = {
    children: [],
    content: trajectoryRunContent(run),
    costUsd: run.costUsd,
    createdAt: run.startedAt,
    durationMs: run.durationMs,
    error: run.error,
    id: `run:${run.id}`,
    kind: run.kind,
    model: run.model,
    offsetMs: run.offsetMs,
    provider: run.provider,
    requestId: run.requestId,
    requestLogId: run.requestLogId,
    run,
    status: run.status,
    statusCode: run.statusCode,
    stepIndex: 0,
    title: run.kind === "tool" ? run.toolName || run.name : run.name,
    totalTokens: run.totalTokens
  };
  if (run.kind === "tool") {
    const resultNode = toolResultTrajectoryNode(run);
    if (resultNode) {
      node.children.push(resultNode);
    }
  }
  return node;
}

function toolResultTrajectoryNode(run: AgentAnalysisTraceRun): AgentTrajectoryNode | undefined {
  const result = run.tool?.result?.preview.trim();
  if (!result) {
    return undefined;
  }
  return {
    children: [],
    content: result,
    createdAt: run.endedAt,
    durationMs: 0,
    error: run.error,
    id: `run:${run.id}:tool-result`,
    kind: "tool-result",
    offsetMs: run.offsetMs + run.durationMs + 0.001,
    requestId: run.tool?.resultRequestId ?? run.requestId,
    requestLogId: run.tool?.resultRequestLogId ?? run.requestLogId,
    run,
    status: run.status,
    statusCode: run.statusCode,
    stepIndex: 0,
    title: "Tool result",
    totalTokens: 0
  };
}

function conversationItemsForTurn(turn: AgentConversationTurn): AgentConversationItem[] {
  const messages = turn.messages?.filter((message) => message.content.trim()) ?? [];
  if (messages.length > 0) {
    return messages;
  }

  const items: AgentConversationItem[] = [];
  if (turn.user?.content.trim()) {
    items.push({
      ...turn.user,
      id: "legacy:user",
      role: "user"
    });
  }
  if (turn.assistant?.content.trim()) {
    items.push({
      ...turn.assistant,
      id: "legacy:assistant",
      role: "assistant"
    });
  }
  return items;
}

function conversationTrajectoryNode({
  content,
  id,
  index,
  kind,
  message,
  offsetMs,
  requestTokens,
  sourcePreview,
  sourceTruncated,
  status,
  title,
  truncated,
  turn
}: {
  content: string;
  id: string;
  index: number;
  kind: AgentConversationItem["role"];
  message?: AgentConversationItem;
  offsetMs: number;
  requestTokens: number;
  sourcePreview: boolean;
  sourceTruncated: boolean;
  status: AgentAnalysisTraceRun["status"];
  title: string;
  truncated: boolean;
  turn: AgentConversationTurn;
}): AgentTrajectoryNode {
  return {
    children: [],
    content,
    createdAt: turn.createdAt,
    durationMs: kind === "assistant" ? turn.durationMs : 0,
    id,
    kind,
    message,
    model: turn.model,
    offsetMs,
    provider: turn.provider,
    requestId: turn.requestId,
    requestLogId: turn.id,
    sourcePreview,
    sourceTruncated,
    status,
    statusCode: turn.statusCode,
    stepIndex: 0,
    title,
    totalTokens: requestTokens,
    truncated,
    turn,
    turnIndex: index + 1
  };
}

function trajectoryRoleTitle(role: AgentConversationItem["role"]): string {
  if (role === "assistant") return "Assistant";
  if (role === "context") return "Context";
  if (role === "developer") return "Developer";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return "User";
}

function sortTrajectoryNodes(nodes: AgentTrajectoryNode[]): void {
  nodes.sort(compareTrajectoryNodes);
  for (const node of nodes) {
    sortTrajectoryNodes(node.children);
  }
}

function compareTrajectoryNodes(left: AgentTrajectoryNode, right: AgentTrajectoryNode): number {
  return left.offsetMs - right.offsetMs || trajectoryNodePriority(left.kind) - trajectoryNodePriority(right.kind) || left.title.localeCompare(right.title);
}

function trajectoryNodePriority(kind: AgentTrajectoryNodeKind): number {
  if (kind === "agent") return 0;
  if (kind === "user") return 1;
  if (kind === "subagent") return 2;
  if (kind === "route") return 3;
  if (kind === "llm") return 4;
  if (kind === "tool") return 5;
  if (kind === "tool-result") return 6;
  return 7;
}

function visibleTrajectoryRows(nodes: AgentTrajectoryNode[], expandedNodeIds: Set<string>, query: string): AgentTrajectoryVisibleRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const rows: AgentTrajectoryVisibleRow[] = [];
  const visit = (node: AgentTrajectoryNode, level: number) => {
    if (normalizedQuery && !trajectorySubtreeMatches(node, normalizedQuery)) {
      return;
    }
    const visible = isTrajectoryListNode(node);
    if (visible) {
      rows.push({ level, node });
    }
    if (normalizedQuery || !visible || expandedNodeIds.has(node.id)) {
      node.children.forEach((child) => visit(child, visible ? level + 1 : level));
    }
  };
  nodes.forEach((node) => visit(node, 0));
  return rows;
}

function isTrajectoryListNode(node: AgentTrajectoryNode): boolean {
  return node.kind !== "agent" && node.kind !== "llm" && node.kind !== "route";
}

function trajectoryNodeHasVisibleChildren(node: AgentTrajectoryNode): boolean {
  return node.children.some((child) => isTrajectoryListNode(child) || trajectoryNodeHasVisibleChildren(child));
}

function trajectorySubtreeMatches(node: AgentTrajectoryNode, normalizedQuery: string): boolean {
  return trajectoryNodeSearchText(node).includes(normalizedQuery) || node.children.some((child) => trajectorySubtreeMatches(child, normalizedQuery));
}

function trajectoryNodeSearchText(node: AgentTrajectoryNode): string {
  return [
    node.title,
    node.content,
    node.requestId,
    node.model,
    node.provider,
    node.error,
    trajectoryNodeKindLabel(node.kind)
  ].filter(Boolean).join(" ").toLowerCase();
}

function AgentTracePanel({ trace }: { trace: AgentTraceDetail }) {
  const t = useAppText();
  const durationMs = Math.max(trace.durationMs, 1);
  const runs = useMemo(() => [...trace.runs].sort(compareTraceRunsByTime), [trace.runs]);
  const [selectedToolRun, setSelectedToolRun] = useState<AgentAnalysisTraceRun>();

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold">{t("Call chain")}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={trace.sessionId}>
            {compactId(trace.sessionId)} - {formatLogDateTime(trace.startedAt)}{" -> "}{formatLogDateTime(trace.endedAt)}
          </div>
        </div>
        <Badge variant="outline">{formatCompactNumber(trace.runCount)} {t("Runs")}</Badge>
      </div>

      {runs.length === 0 ? (
        <AnalysisEmptyState label={t("No trace runs")} />
      ) : (
        <div className={cn("max-h-[520px]", agentListFrameClassName)}>
          <table className={cn("min-w-[1260px]", agentListTableClassName)}>
            <thead className={agentListHeadClassName}>
              <tr>
                <th className="px-3 py-2 font-semibold">{t("Run")}</th>
                <th className="px-3 py-2 font-semibold">{t("Timeline")}</th>
                <th className="px-3 py-2 font-semibold">{t("Status")}</th>
                <th className="px-3 py-2 font-semibold">{t("Target")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Token")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Cache")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Cost")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Concurrency")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Duration")}</th>
              </tr>
            </thead>
            <tbody className={agentListBodyClassName}>
              {runs.map((run) => (
                <tr className={agentListRowClassName({
                  danger: run.status === "error",
                  warning: run.status === "partial"
                })} key={run.id}>
                  <td className="max-w-[360px] px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${Math.min(run.depth, 8) * 16}px` }}>
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", traceRunDotClass(run))} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold" title={run.name}>{run.name}</div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="font-mono uppercase">{t(traceRunKindLabel(run.kind))}</span>
                          {run.requestId ? <span className="truncate font-mono" title={run.requestId}>{compactId(run.requestId)}</span> : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="relative h-5 min-w-[260px] rounded bg-muted/50">
                      <div
                        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full", traceRunBarClass(run))}
                        style={traceRunBarStyle(run, durationMs)}
                        title={`${formatDuration(run.durationMs)} | +${formatDuration(run.offsetMs)}`}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={cn("border", traceRunStatusBadgeClass(run.status))} variant="outline">
                      {t(traceRunStatusLabel(run.status))}
                    </Badge>
                  </td>
                  <td className="max-w-[260px] px-3 py-2" title={traceRunTarget(run)}>
                    <TraceRunTarget run={run} onOpenTool={() => setSelectedToolRun(run)} />
                  </td>
                  <td className="px-3 py-2 text-right">{run.totalTokens > 0 ? formatCompactNumber(run.totalTokens) : "-"}</td>
                  <td className="px-3 py-2 text-right">{run.cacheReadTokens + run.cacheWriteTokens > 0 ? formatCompactNumber(run.cacheReadTokens + run.cacheWriteTokens) : "-"}</td>
                  <td className="px-3 py-2 text-right">{run.costUsd !== undefined ? formatUsdCost(run.costUsd) : "-"}</td>
                  <td className="px-3 py-2 text-right">{formatCompactNumber(run.concurrentRequests)}</td>
                  <td className="px-3 py-2 text-right">{formatDuration(run.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedToolRun ? (
        <ToolPayloadDialog
          run={selectedToolRun}
          onClose={() => setSelectedToolRun(undefined)}
        />
      ) : null}
    </div>
  );
}

function TraceRunTarget({
  onOpenTool,
  run
}: {
  onOpenTool: () => void;
  run: AgentAnalysisTraceRun;
}) {
  const t = useAppText();
  if (run.kind !== "tool") {
    return <span>{traceRunTarget(run)}</span>;
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate" title={traceRunTarget(run)}>{traceRunTarget(run)}</span>
      {run.tool ? (
        <Button className="h-6 shrink-0 border-border bg-transparent px-2 text-[10px] shadow-none hover:bg-transparent active:bg-transparent" onClick={onOpenTool} type="button" variant="outline">
          {t("Parameters")} / {t("Result")}
        </Button>
      ) : null}
    </div>
  );
}

function AgentTrajectoryNodeRow({
  expanded,
  level,
  node,
  onSelect,
  onToggle,
  selected
}: {
  expanded: boolean;
  level: number;
  node: AgentTrajectoryNode;
  onSelect: () => void;
  onToggle: () => void;
  selected: boolean;
}) {
  const t = useAppText();
  const preview = trajectoryNodePreview(trajectoryNodeListContent(node, t));
  const hasChildren = trajectoryNodeHasVisibleChildren(node);

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-start bg-card/30 px-2.5 py-2 text-left transition-colors [contain-intrinsic-size:36px] [content-visibility:auto] hover:bg-muted/40",
        selected && "bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))] hover:bg-primary/10"
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: `${Math.min(level, 10) * 18}px` }}>
        {hasChildren ? (
          <button
            aria-label={t(expanded ? "Collapse" : "Expand")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            title={t(expanded ? "Collapse" : "Expand")}
            type="button"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}
        <span className={cn("min-w-[84px] shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[9px] font-semibold uppercase", trajectoryNodeBadgeClass(node))}>
          {trajectoryNodeRoleTag(node.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90" title={preview || trajectoryNodeTitle(node, t)}>
          {preview || trajectoryNodeTitle(node, t)}
        </span>
      </div>
    </div>
  );
}

function AgentTrajectoryDetailPanel({
  node,
  onClose
}: {
  node?: AgentTrajectoryNode;
  onClose: () => void;
}) {
  const t = useAppText();
  const [tab, setTab] = useState<AgentTrajectoryDetailTab>("preview");

  useEffect(() => {
    setTab("preview");
  }, [node?.id]);

  if (!node) {
    return <AnalysisEmptyState label={t("No trajectory events")} />;
  }

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background/80 shadow-[-8px_0_18px_rgba(15,23,42,0.04)]">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase", trajectoryNodeBadgeClass(node))}>
              {trajectoryNodeRoleTag(node.kind)}
            </span>
            <span className="truncate text-[12px] font-medium" title={trajectoryNodeTitle(node, t)}>
              {trajectoryNodeTitle(node, t)}
            </span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {node.turnIndex ? `${t("Round")} ${node.turnIndex} | ` : ""}{t("Step")} {node.stepIndex}
          </div>
        </div>
        <Button aria-label={t("Collapse details")} onClick={onClose} size="iconSm" title={t("Collapse details")} type="button" variant="ghost">
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex shrink-0 border-b border-border/60 px-3">
        {(["preview", "raw"] as AgentTrajectoryDetailTab[]).map((item) => (
          <button
            className={cn(
              "h-10 border-b-2 px-2 text-[12px] font-medium transition-colors",
              tab === item ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            key={item}
            onClick={() => setTab(item)}
            type="button"
          >
            {t(item === "preview" ? "Preview" : "Raw")}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "preview" ? <AgentTrajectoryNodePreview node={node} /> : null}
        {tab === "raw" ? <TracePayloadContent content={trajectoryNodeRawJson(node)} kind="json" /> : null}
      </div>
    </aside>
  );
}

function AgentTrajectoryNodePreview({ node }: { node: AgentTrajectoryNode }) {
  const t = useAppText();
  const run = node.run;
  const tool = run?.tool;
  const inputRequest = tool && run?.requestLogId
    ? { callId: tool.callId, part: "tool-input" as const, requestLogId: run.requestLogId }
    : undefined;
  const resultRequest = tool?.resultRequestLogId
    ? { callId: tool.callId, part: "tool-result" as const, requestLogId: tool.resultRequestLogId }
    : undefined;

  if (node.kind === "tool-result") {
    return <TracePayloadContent content={node.content} kind={node.content.trim() ? "text" : "empty"} />;
  }

  if (run?.kind === "tool") {
    return (
      <div className="space-y-3 p-3">
        <TracePayloadPane fallback={tool?.input} label={t("Tool parameters")} request={inputRequest} />
        <TracePayloadPane fallback={tool?.result} label={t("Tool result")} request={resultRequest} />
      </div>
    );
  }

  if (isConversationRoleNodeKind(node.kind)) {
    return <TracePayloadContent content={node.content} kind={node.content.trim() ? "text" : "empty"} />;
  }

  return (
    <div className="space-y-4 p-4 text-[12px]">
      <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-4 gap-y-2">
        <div className="text-muted-foreground">{t("Source")}</div>
        <div>{t(trajectoryNodeKindLabel(node.kind))}</div>
        <div className="text-muted-foreground">{t("Status")}</div>
        <div>{t(traceRunStatusLabel(node.status))}{node.statusCode ? ` (${node.statusCode})` : ""}</div>
        <div className="text-muted-foreground">{t("Target")}</div>
        <div className="truncate" title={run ? traceRunTarget(run) : undefined}>{run ? traceRunTarget(run) : "-"}</div>
        <div className="text-muted-foreground">{t("Request")}</div>
        <div className="truncate font-mono" title={node.requestId}>{node.requestId ? compactId(node.requestId) : "-"}</div>
        <div className="text-muted-foreground">{t("Model")}</div>
        <div className="truncate" title={node.provider && node.model ? `${node.provider}/${node.model}` : node.model}>
          {node.provider && node.model ? `${node.provider}/${node.model}` : node.model || "-"}
        </div>
        <div className="text-muted-foreground">{t("Tokens")}</div>
        <div>{node.totalTokens > 0 ? `${formatCompactNumber(node.totalTokens)} tok` : "-"}</div>
        <div className="text-muted-foreground">{t("Cost")}</div>
        <div>{node.costUsd !== undefined ? formatUsdCost(node.costUsd) : "-"}</div>
      </div>

      <div>
        <div className="mb-2 font-medium">{t("Request Timing")}</div>
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <div className="text-muted-foreground">{t("Started")}</div>
          <div className="font-mono">{formatLogDateTime(node.createdAt)}</div>
          <div className="text-muted-foreground">{t("Total duration")}</div>
          <div>{formatDuration(node.durationMs)}</div>
          <div className="text-muted-foreground">{t("Offset")}</div>
          <div>{formatDuration(node.offsetMs)}</div>
        </div>
      </div>

      {node.content.trim() ? (
        <div>
          <div className="mb-2 font-medium">{t("Preview")}</div>
          <TracePayloadContent content={node.content} kind="text" />
        </div>
      ) : null}
    </div>
  );
}

function ToolPayloadDialog({
  onClose,
  run
}: {
  onClose: () => void;
  run: AgentAnalysisTraceRun;
}) {
  const t = useAppText();
  const tool = run.tool;
  const inputRequest = tool && run.requestLogId
    ? { callId: tool.callId, part: "tool-input" as const, requestLogId: run.requestLogId }
    : undefined;
  const resultRequest = tool?.resultRequestLogId
    ? { callId: tool.callId, part: "tool-result" as const, requestLogId: tool.resultRequestLogId }
    : undefined;

  return (
    <Dialog className="z-[110] items-start" onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="h-[calc(100dvh-1.5rem)] max-w-[1180px] origin-top sm:h-[min(820px,calc(100dvh-3rem))]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{run.toolName || run.name}</DialogTitle>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={tool?.callId}>
              {tool?.callId ? compactId(tool.callId) : t("Tool")}
            </div>
          </div>
          <Button aria-label={t("Close")} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-3.5 w-3.5" />
          </Button>
        </DialogHeader>
        <DialogBody className="overflow-hidden">
          <div className="grid h-full min-h-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <TracePayloadPane
              fallback={tool?.input}
              label={t("Parameters")}
              request={inputRequest}
            />
            <TracePayloadPane
              fallback={tool?.result}
              label={t("Result")}
              request={resultRequest}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function TracePayloadPane({
  fallback,
  label,
  request
}: {
  fallback?: TracePayloadPreviewValue;
  label: string;
  request?: AgentAnalysisTracePayloadRequest;
}) {
  const t = useAppText();
  const requestCallId = request?.callId;
  const requestLogId = request?.requestLogId;
  const requestPart = request?.part;
  const [full, setFull] = useState<AgentAnalysisTracePayloadFullResult>();
  const [loading, setLoading] = useState(Boolean(request));
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFull(undefined);
    setLoadFailed(false);

    if (typeof requestLogId !== "number" || !requestPart || !window.agentrouter?.getAgentTracePayload) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    const payloadRequest: AgentAnalysisTracePayloadRequest = {
      callId: requestCallId,
      part: requestPart,
      requestLogId
    };
    window.agentrouter.getAgentTracePayload(payloadRequest)
      .then((result) => {
        if (!cancelled) {
          setFull(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestCallId, requestLogId, requestPart]);

  const fullPayload = full?.found ? full : undefined;
  const content = fullPayload?.content ?? fallback?.preview ?? "";
  const kind = fullPayload?.kind ?? fallback?.kind ?? "empty";
  const sizeBytes = fullPayload?.sizeBytes ?? fallback?.sizeBytes ?? 0;
  const truncated = fullPayload?.sourceTruncated ?? fallback?.truncated ?? false;
  const previewOnly = !fullPayload && Boolean(fallback);
  const unavailable = !loading && Boolean(request) && full !== undefined && !full.found;

  return (
    <section className="flex min-h-[160px] flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="text-[12px] font-semibold">{label}</div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          {loading ? <Badge variant="outline">{t("Loading")}</Badge> : null}
          {sizeBytes > 0 ? <Badge variant="outline">{formatBytes(sizeBytes)}</Badge> : null}
          {previewOnly && !loading ? <Badge variant="outline">{t("Preview")}</Badge> : null}
          {truncated ? <Badge className="border-amber-200 bg-amber-50 text-amber-700" variant="outline">{t("Source truncated")}</Badge> : null}
          {loadFailed || unavailable ? <Badge className="border-rose-200 bg-rose-50 text-rose-700" variant="outline">{t("Full content unavailable")}</Badge> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !content ? (
          <div className="px-3 py-4 text-[11px] text-muted-foreground">{t("Loading")}</div>
        ) : (
          <TracePayloadContent content={content} kind={kind} />
        )}
      </div>
    </section>
  );
}

function TracePayloadContent({
  content,
  kind
}: {
  content: string;
  kind: AgentAnalysisTracePayloadFullResult["kind"];
}) {
  const t = useAppText();
  const parsed = useMemo<{ value: unknown } | undefined>(() => {
    if (kind !== "json") {
      return undefined;
    }
    try {
      return { value: JSON.parse(content) };
    } catch {
      return undefined;
    }
  }, [content, kind]);

  if (!content.trim() || kind === "empty") {
    return <div className="px-3 py-4 text-[11px] text-muted-foreground">{t("No data")}</div>;
  }

  if (parsed) {
    return (
      <div className="min-w-max p-3 font-mono text-[11px] leading-5">
        <JsonTreeNode root value={parsed.value} />
      </div>
    );
  }

  return (
    <pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-foreground">
      <code>{content}</code>
    </pre>
  );
}

function JsonTreeNode({
  name,
  root,
  value
}: {
  name?: string;
  root?: boolean;
  value: unknown;
}) {
  if (Array.isArray(value)) {
    return <JsonComplexNode closeToken="]" entries={value.map((entry, index) => [String(index), entry])} name={name} openToken="[" root={root} />;
  }
  if (isJsonObject(value)) {
    return <JsonComplexNode closeToken="}" entries={Object.entries(value)} name={name} openToken="{" root={root} />;
  }

  return (
    <div className="flex min-w-0 items-start gap-1">
      {name !== undefined ? <JsonPropertyName name={name} /> : null}
      <JsonPrimitive value={value} />
    </div>
  );
}

function JsonComplexNode({
  closeToken,
  entries,
  name,
  openToken,
  root
}: {
  closeToken: string;
  entries: Array<[string, unknown]>;
  name?: string;
  openToken: string;
  root?: boolean;
}) {
  const t = useAppText();
  const [expanded, setExpanded] = useState(Boolean(root));
  const empty = entries.length === 0;

  return (
    <div className={cn("min-w-0", !root && "py-0.5")}>
      <div className="flex min-w-0 items-center gap-1">
        {empty ? (
          <span className="h-4 w-4 shrink-0" />
        ) : (
          <button
            aria-label={t(expanded ? "Collapse" : "Expand")}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
        {name !== undefined ? <JsonPropertyName name={name} /> : null}
        <span className="text-muted-foreground">{openToken}</span>
        {!expanded ? (
          <>
            {!empty ? <span className="text-muted-foreground/70"> ... {entries.length}</span> : null}
            <span className="text-muted-foreground">{closeToken}</span>
          </>
        ) : null}
      </div>
      {expanded ? (
        <div className="ml-4 border-l border-border/60 pl-3">
          {entries.map(([entryName, entryValue]) => (
            <JsonTreeNode key={entryName} name={entryName} value={entryValue} />
          ))}
          <div className="text-muted-foreground">{closeToken}</div>
        </div>
      ) : null}
    </div>
  );
}

function JsonPropertyName({ name }: { name: string }) {
  const displayName = /^\d+$/.test(name) ? name : JSON.stringify(name);
  return (
    <>
      <span className={cn("shrink-0", /^\d+$/.test(name) ? "text-slate-500" : "text-sky-700")}>{displayName}</span>
      <span className="text-muted-foreground">:</span>
    </>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "string") {
    return <span className="text-emerald-700">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-amber-700">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-violet-700">{String(value)}</span>;
  }
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function traceRunTarget(run: AgentAnalysisTraceRun): string {
  if (run.kind === "tool") {
    return run.toolName || run.name;
  }
  if (run.provider && run.model) {
    return `${run.provider}/${run.model}`;
  }
  if (run.routeReason) {
    return run.routeReason;
  }
  return run.path || "-";
}

function traceRunKindLabel(kind: AgentAnalysisTraceRun["kind"]): string {
  if (kind === "agent") return "Agent";
  if (kind === "llm") return "LLM";
  if (kind === "route") return "Route";
  if (kind === "subagent") return "Subagent";
  return "Tool";
}

function traceRunBarStyle(run: AgentAnalysisTraceRun, traceDurationMs: number): { left: string; width: string } {
  const left = Math.max(0, Math.min(99.2, (run.offsetMs / traceDurationMs) * 100));
  const rawWidth = (run.durationMs / traceDurationMs) * 100;
  const minWidth = run.kind === "tool" ? 0.7 : 1.2;
  const width = Math.max(minWidth, Math.min(100 - left, rawWidth));
  return {
    left: `${left}%`,
    width: `${width}%`
  };
}

function traceRunDotClass(run: AgentAnalysisTraceRun): string {
  if (run.status === "error") return "bg-rose-500";
  if (run.status === "partial") return "bg-amber-500";
  if (run.kind === "agent") return "bg-teal-500";
  if (run.kind === "route") return "bg-cyan-500";
  if (run.kind === "subagent") return "bg-amber-500";
  if (run.kind === "tool") return "bg-emerald-500";
  return "bg-blue-500";
}

function traceRunBarClass(run: AgentAnalysisTraceRun): string {
  if (run.status === "error") return "bg-rose-500";
  if (run.status === "partial") return "bg-amber-500";
  if (run.kind === "agent") return "bg-teal-500";
  if (run.kind === "route") return "bg-cyan-500";
  if (run.kind === "subagent") return "bg-amber-500";
  if (run.kind === "tool") return "bg-emerald-500";
  return "bg-blue-500";
}

function traceRunStatusBadgeClass(status: AgentAnalysisTraceRun["status"]): string {
  if (status === "error") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function traceRunStatusLabel(status: AgentAnalysisTraceRun["status"]): string {
  if (status === "error") return "Error";
  if (status === "partial") return "Partial failure";
  return "Success";
}

function trajectoryNodeTitle(node: AgentTrajectoryNode, t: (value: string) => string): string {
  if (node.kind === "user") return t("User sent");
  if (node.kind === "assistant") return t("Model reply");
  if (node.kind === "context") return t("Context");
  if (node.kind === "developer") return t("Developer");
  if (node.kind === "system") return t("System");
  if (node.kind === "tool-result") return t("Tool result");
  return node.title;
}

function trajectoryNodeListContent(node: AgentTrajectoryNode, t: (value: string) => string): string {
  const content = node.content.trim();
  if (node.kind === "tool-result") {
    return content;
  }
  if (node.run?.kind === "tool") {
    const input = trajectoryNodePreview(node.run.tool?.input?.preview ?? "");
    return [
      node.run.toolName || node.run.name,
      input
    ].filter(Boolean).join(" ");
  }
  if (isConversationRoleNodeKind(node.kind)) {
    return content;
  }
  if (node.kind === "llm") {
    return node.error ? node.error : t("Request");
  }
  if (node.kind === "route") {
    return content || node.run?.routeReason || node.title;
  }
  return content || node.title;
}

function isConversationRoleNodeKind(kind: AgentTrajectoryNodeKind): kind is AgentConversationItem["role"] {
  return kind === "assistant" || kind === "context" || kind === "developer" || kind === "system" || kind === "tool" || kind === "user";
}

function trajectoryNodeKindLabel(kind: AgentTrajectoryNodeKind): string {
  if (kind === "user") return "User";
  if (kind === "assistant") return "Assistant";
  if (kind === "context") return "Context";
  if (kind === "developer") return "Developer";
  if (kind === "system") return "System";
  if (kind === "tool-result") return "Tool Result";
  return traceRunKindLabel(kind);
}

function trajectoryNodeRoleTag(kind: AgentTrajectoryNodeKind): string {
  return trajectoryNodeKindLabel(kind).toUpperCase();
}

function trajectoryNodeBadgeClass(node: AgentTrajectoryNode): string {
  if (node.status === "error") return "bg-rose-100 text-rose-700";
  if (node.kind === "system") return "bg-slate-100 text-slate-700";
  if (node.kind === "context") return "bg-emerald-100 text-emerald-700";
  if (node.kind === "developer") return "bg-indigo-100 text-indigo-700";
  if (node.kind === "user") return "bg-blue-100 text-blue-700";
  if (node.kind === "assistant") return "bg-violet-100 text-violet-700";
  if (node.kind === "tool-result") return "bg-emerald-100 text-emerald-700";
  if (node.kind === "tool") return "bg-amber-100 text-amber-700";
  if (node.kind === "route") return "bg-cyan-100 text-cyan-700";
  if (node.kind === "subagent") return "bg-emerald-100 text-emerald-700";
  if (node.kind === "agent") return "bg-teal-100 text-teal-700";
  return "bg-slate-100 text-slate-700";
}

function trajectoryNodePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

function trajectoryRunContent(run: AgentAnalysisTraceRun): string {
  if (run.kind === "tool") {
    const input = run.tool?.input?.preview.trim();
    const result = run.tool?.result?.preview.trim();
    return [
      input ? `Input\n${input}` : "",
      result ? `Result\n${result}` : "",
      run.error ? `Error\n${run.error}` : ""
    ].filter(Boolean).join("\n\n");
  }
  return [
    run.routeReason ? `Route: ${run.routeReason}` : "",
    run.error ? `Error: ${run.error}` : ""
  ].filter(Boolean).join("\n");
}

function trajectoryNodeRawJson(node: AgentTrajectoryNode): string {
  return JSON.stringify({
    content: node.content,
    costUsd: node.costUsd,
    durationMs: node.durationMs,
    error: node.error,
    kind: node.kind,
    model: node.model,
    offsetMs: node.offsetMs,
    provider: node.provider,
    requestId: node.requestId,
    requestLogId: node.requestLogId,
    sourcePreview: node.sourcePreview,
    sourceTruncated: node.sourceTruncated,
    status: node.status,
    statusCode: node.statusCode,
    stepIndex: node.stepIndex,
    title: node.title,
    totalTokens: node.totalTokens,
    truncated: node.truncated,
    turnIndex: node.turnIndex
  }, null, 2);
}

function formatRouteReason(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "-";
  }
  return trimmed.toLowerCase() === "inline-model" ? "none" : trimmed;
}

function AgentSessionsCard({
  onSelectSession,
  selectedSession,
  sessions
}: {
  onSelectSession: (value: AgentAnalysisSessionSelection) => void;
  selectedSession?: AgentAnalysisSessionSelection;
  sessions: AgentAnalysisSnapshot["sessions"];
}) {
  const t = useAppText();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {sessions.length === 0 ? (
        <AnalysisEmptyState label={t("No session activity")} />
      ) : (
        <div className={cn("h-full", agentListFrameClassName)}>
          <table className={cn("min-w-[1420px]", agentListTableClassName)}>
            <thead className={agentListHeadClassName}>
              <tr>
                <th className="px-3 py-2 font-semibold">{t("Session")}</th>
                <th className="px-3 py-2 font-semibold">{t("Agent")}</th>
                <th className="px-3 py-2 font-semibold">{t("Client")}</th>
                <th className="px-3 py-2 font-semibold">{t("Started")}</th>
                <th className="px-3 py-2 font-semibold">{t("Last seen")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Duration")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Requests")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Tools")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Subagents")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Errors")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Cache rate")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Cost")}</th>
                <th className="px-3 py-2 font-semibold">{t("Models")}</th>
                <th className="px-3 py-2 font-semibold">{t("Providers")}</th>
                <th className="px-3 py-2 font-semibold">{t("UA")}</th>
                <th className="px-3 py-2 text-right font-semibold">{t("Action")}</th>
              </tr>
            </thead>
            <tbody className={agentListBodyClassName}>
              {sessions.map((session) => {
                const selected = selectedSession?.agent === session.agent && selectedSession.id === session.id;
                return (
                  <tr className={agentListRowClassName({ selected })} key={`${session.agent}:${session.id}`}>
                    <td className="max-w-[180px] px-3 py-2" title={session.id}>
                      <span className="block truncate font-mono font-semibold">{compactId(session.id)}</span>
                    </td>
                    <td className="px-3 py-2">{t(agentKindLabel(session.agent))}</td>
                    <td className="max-w-[150px] px-3 py-2" title={session.client}>{session.client}</td>
                    <td className="px-3 py-2 font-mono">{formatLogDateTime(session.startedAt)}</td>
                    <td className="px-3 py-2 font-mono">{formatLogDateTime(session.lastSeenAt)}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(session.durationMs)}</td>
                    <td className="px-3 py-2 text-right">{formatCompactNumber(session.requestCount)}</td>
                    <td className="px-3 py-2 text-right">{formatCompactNumber(session.toolCallCount)}</td>
                    <td className="px-3 py-2 text-right">{formatCompactNumber(session.subagentCallCount)}</td>
                    <td className="px-3 py-2 text-right">{formatCompactNumber(session.errorCount)}</td>
                    <td className="px-3 py-2 text-right">{formatPercentFixed(session.cacheRatio)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatUsdCost(session.costUsd)}</td>
                    <td className="max-w-[240px] px-3 py-2" title={session.models.join(", ")}>{session.models.join(", ") || "-"}</td>
                    <td className="max-w-[220px] px-3 py-2" title={session.providers.join(", ")}>{session.providers.join(", ") || "-"}</td>
                    <td className="max-w-[220px] px-3 py-2 font-mono" title={session.userAgent}>{compactUserAgent(session.userAgent)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button className="h-7 border-border bg-transparent px-2 text-[11px] shadow-none hover:bg-transparent active:bg-transparent" onClick={() => onSelectSession({ agent: session.agent, id: session.id })} type="button" variant="outline">
                        {t("Details")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AnalysisEmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-8 text-center text-[12px] text-muted-foreground">
      {label}
    </div>
  );
}

function AnalysisNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
