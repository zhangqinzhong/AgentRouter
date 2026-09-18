/** Fictional order-status examples for the interactive documentation. */
import { useState } from "react";
import { AgentAnalysisView } from "@/pages/home/components/agent-analysis";
import { BaseUiProvider } from "@/lib/baseui-provider";
import { AppI18nContext, appCopy } from "@/pages/home/shared/i18n";
import { getAgentAnalysisData } from "./mockData";
import { DemoShell, readDemoLocale } from "./demoRuntime";
import type { AgentFilterValue } from "@/pages/home/shared/options";
import type { AgentAnalysisSessionSelection, AgentAnalysisSnapshot } from "@agentrouter/core/contracts/app";

const noop = () => {};

// Split the fixture once: base snapshot (no detail) + the session detail data
const FULL_SNAPSHOT = getAgentAnalysisData();
const SESSION_DETAIL = FULL_SNAPSHOT.selectedSession;
const BASE_SNAPSHOT: AgentAnalysisSnapshot = { ...FULL_SNAPSHOT, selectedSession: undefined };

export default function ObservabilityViewDemo() {
  const locale = readDemoLocale();
  const [selectedSession, setSelectedSession] = useState<AgentAnalysisSessionSelection | undefined>(undefined);

  // Inject the session detail only when the user has selected a session
  const snapshot: AgentAnalysisSnapshot = selectedSession
    ? { ...BASE_SNAPSHOT, selectedSession: SESSION_DETAIL }
    : BASE_SNAPSHOT;

  return (
    <AppI18nContext.Provider value={locale === "zh" ? appCopy.zh : appCopy.en}>
      <DemoShell
        locale={locale}
        title={{
          zh: "Agent 观测 — 查看执行轨迹、工具调用与结果",
          en: "Agent observability — inspect execution traces, tool calls, and results",
        }}
        contentClassName="docs-demo-content--data"
      >
        <BaseUiProvider>
          <div className="docs-demo-app-surface docs-demo-app-surface--observability">
            <AgentAnalysisView
              agentFilter={"all" as AgentFilterValue}
              error=""
              loading={false}
              range="today"
              refreshAnalysis={noop}
              setAgentFilter={noop}
              setRange={noop}
              selectedSession={selectedSession}
              setSelectedSession={setSelectedSession}
              snapshot={snapshot}
            />
          </div>
        </BaseUiProvider>
      </DemoShell>
    </AppI18nContext.Provider>
  );
}
