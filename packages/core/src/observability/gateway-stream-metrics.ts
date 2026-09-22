import type { GatewayProviderProtocol, RequestStreamMetrics, StreamSpeedSampleStatus } from "@agentrouter/core/contracts/app";
import { combineStreamExperienceMetrics, createStreamExperienceMeter } from "./stream-experience";
import { createStreamMetricsTracker } from "./stream-metrics";

// Written only after upstream streaming begins, so it is captured in the raw
// trace's client metadata without being sent to the upstream provider.
export const streamTimingHeader = "x-ar-stream-timing";
export const streamExperienceHeader = "x-ar-stream-experience";
export const responseStatusMessageType = "ar:response-log-status";
type RequestHeaders = Record<string, string | string[] | undefined>;
type GatewayStreamMetricContext = {
  protocol?: GatewayProviderProtocol;
};

const streamSpeedSampleStatuses = new Set<StreamSpeedSampleStatus>([
  "complete",
  "partial",
  "usage_missing",
  "insufficient_tokens",
  "unsupported_protocol",
  "hidden_reasoning",
  "batched_output"
]);

export function createGatewayStreamMetrics(now = () => performance.now()) {
  const starts = new WeakMap<RequestHeaders, number>();
  return {
    start(headers: RequestHeaders | undefined) {
      if (!headers) return;
      for (const key of Object.keys(headers)) {
        const normalized = key.toLowerCase();
        if (normalized === streamTimingHeader || normalized === streamExperienceHeader) delete headers[key];
      }
      starts.set(headers, now());
    },
    wrap(response: Response, headers: RequestHeaders | undefined, context: GatewayStreamMetricContext = {}): Response | undefined {
      const startedAt = headers && starts.get(headers);
      if (!headers || startedAt === undefined || !response.body) return undefined;
      delete headers[streamTimingHeader];
      delete headers[streamExperienceHeader];
      const responseHeadersAtMs = now();
      const tracker = createStreamMetricsTracker(startedAt);
      const experience = createStreamExperienceMeter({
        contentType: response.headers.get("content-type") ?? undefined,
        now,
        protocol: context.protocol
      });
      const reader = response.body.getReader();
      let finished = false;
      const finish = (sampleStatus: "complete" | "partial") => {
        if (finished) return;
        finished = true;
        const metrics = tracker.finish(now());
        if (metrics.firstTokenAtMs !== undefined && metrics.lastTokenAtMs !== undefined) {
          headers[streamTimingHeader] = JSON.stringify([
            Math.max(0, Math.round(metrics.firstTokenAtMs)),
            Math.max(0, Math.round(metrics.lastTokenAtMs - metrics.firstTokenAtMs))
          ]);
        }
        experience.finish();
        const snapshot = experience.snapshot();
        if (!snapshot.active) return;
        const encoded = JSON.stringify(combineStreamExperienceMetrics({
          client: snapshot,
          requestStartedAtMs: startedAt,
          responseHeadersAtMs,
          sampleStatus,
          upstream: snapshot,
          upstreamAttemptStartedAtMs: responseHeadersAtMs
        }));
        if (encoded.length <= 4096) headers[streamExperienceHeader] = encoded;
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              finish("complete");
              reader.releaseLock();
              controller.close();
            } else {
              const chunk = Buffer.from(value);
              tracker.append(chunk, now());
              experience.observe(chunk);
              controller.enqueue(value);
            }
          } catch (error) {
            finish("partial");
            reader.releaseLock();
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish("partial");
          try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        }
      }, { highWaterMark: 0 });
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
    }
  };
}

export function readGatewayStreamMetrics(headers: RequestHeaders | undefined): {
  streamMetrics?: RequestStreamMetrics;
  streamOutputDurationMs?: number;
  timeToFirstTokenMs?: number;
} {
  const timing = readLegacyStreamTiming(headerString(headers, streamTimingHeader));
  const streamMetrics = readStreamExperience(headerString(headers, streamExperienceHeader));
  return {
    ...timing,
    ...(streamMetrics ? { streamMetrics } : {})
  };
}

function headerString(headers: RequestHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized && typeof value === "string") return value;
  }
  return undefined;
}

function readLegacyStreamTiming(raw: string | undefined): {
  streamOutputDurationMs?: number;
  timeToFirstTokenMs?: number;
} {
  if (!raw) return {};
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length !== 2 ||
      !values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return {};
    return { timeToFirstTokenMs: values[0], streamOutputDurationMs: values[1] };
  } catch { return {}; }
}

function readStreamExperience(raw: string | undefined): RequestStreamMetrics | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isStreamSpeedSampleStatus(parsed.sampleStatus)) return undefined;
    const estimatedOutputTokens = nonNegativeNumber(parsed.estimatedOutputTokens);
    if (estimatedOutputTokens === undefined) return undefined;
    return {
      ...optionalMetric("activeOutputMs", parsed.activeOutputMs),
      estimatedOutputTokens,
      ...optionalMetric("maxInterEventGapMs", parsed.maxInterEventGapMs),
      ...optionalMetric("p95InterEventGapMs", parsed.p95InterEventGapMs),
      reasoningObserved: parsed.reasoningObserved === true,
      ...optionalMetric("responseHeadersMs", parsed.responseHeadersMs),
      sampleStatus: parsed.sampleStatus,
      ...optionalMetric("tailMs", parsed.tailMs),
      textObserved: parsed.textObserved === true,
      ...optionalMetric("timeToFirstSignalMs", parsed.timeToFirstSignalMs),
      ...optionalMetric("timeToFirstTextMs", parsed.timeToFirstTextMs),
      toolObserved: parsed.toolObserved === true,
      ...optionalMetric("upstreamTimeToFirstSignalMs", parsed.upstreamTimeToFirstSignalMs)
    };
  } catch {
    return undefined;
  }
}

function optionalMetric<Key extends keyof RequestStreamMetrics>(
  key: Key,
  value: unknown
): Partial<Pick<RequestStreamMetrics, Key>> {
  const number = nonNegativeNumber(value);
  return number === undefined ? {} : { [key]: number } as Partial<Pick<RequestStreamMetrics, Key>>;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isStreamSpeedSampleStatus(value: unknown): value is StreamSpeedSampleStatus {
  return typeof value === "string" && streamSpeedSampleStatuses.has(value as StreamSpeedSampleStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function recordGatewayResponseStatus(requestId: string | undefined, status: number | undefined): void {
  if (!requestId || status === undefined || !Number.isInteger(status) || status < 100 || status > 599 || !process.connected) return;
  // Non-streaming traces can be queued before response hooks. Send the known
  // outcome over the managed process channel rather than mutating a snapshot.
  try { process.send?.({ type: responseStatusMessageType, requestId, status }, () => undefined); } catch { /* Parent is shutting down. */ }
}
