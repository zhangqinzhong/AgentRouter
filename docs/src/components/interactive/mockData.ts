/** Fictional order-status examples for the interactive documentation. */
import type { AgentAnalysisSnapshot, RequestLogPage } from "@agentrouter/core/contracts/app";

import requestLogsFixture from "./fixtures-request-logs.json";
import agentAnalysisFixture from "./fixtures-agent-analysis.json";

export function getRequestLogData(): RequestLogPage {
  return requestLogsFixture as unknown as RequestLogPage;
}

export function getAgentAnalysisData(): AgentAnalysisSnapshot {
  return agentAnalysisFixture as unknown as AgentAnalysisSnapshot;
}
