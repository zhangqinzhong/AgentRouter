export type MonitorRange = "1h" | "6h" | "24h" | "today" | "7d" | "14d" | "30d";
export type MonitorDimension = "models" | "providers" | "clients";
export type MonitorQuery = {
  range: MonitorRange;
  timeZone: string;
  models?: string[];
  providers?: string[];
  clients?: string[];
};
export type MonitorDistribution = {
  samples: number;
  average: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  histogram: number[];
};
export type MonitorMetrics = {
  requests: number;
  failed: number;
  success: number;
  successRate: number | null;
  tokens: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
  priced: number;
  cacheRate: number | null;
  duration: number | null;
  ttft: number | null;
  ttftSamples: number;
  streaming: number;
  logSamples: number;
  outputSpeed: number | null;
};
export type MonitorPoint = MonitorMetrics & {
  at: string;
  latencyP95: number | null;
  ttftP50: number | null;
};
export type MonitorRank = MonitorMetrics & {
  key: string;
  latencyP95: number | null;
  ttftP50: number | null;
  trend: number[];
};
export type MonitorFailure = {
  id: string;
  logId: number | null;
  at: string;
  model: string;
  provider: string;
  client: string;
  status: number;
  duration: number;
  path: string;
};
export type MonitorReport = {
  generatedAt: string;
  query: MonitorQuery;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  stepMs: number;
  current: MonitorMetrics;
  previous: MonitorMetrics;
  series: MonitorPoint[];
  minutes: MonitorPoint[];
  latency: {
    bounds: number[];
    total: MonitorDistribution;
    firstToken: MonitorDistribution;
    previousTotal: MonitorDistribution;
    previousFirstToken: MonitorDistribution;
    coverageStart: string | null;
  };
  rankings: Record<MonitorDimension, MonitorRank[]>;
  options: Record<MonitorDimension, string[]>;
  failures: MonitorFailure[];
  failureStatuses: { status: number; count: number }[];
  flows: {
    client: string;
    model: string;
    provider: string;
    requests: number;
    tokens: number;
  }[];
  heatmap: {
    weekday: number;
    hour: number;
    requests: number;
    failed: number;
  }[];
  logAvailable: boolean;
};
