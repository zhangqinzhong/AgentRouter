import { createStreamMetricsTracker } from "./stream-metrics";

// Written only after upstream streaming begins, so it is captured in the raw
// trace's client metadata without being sent to the upstream provider.
export const streamTimingHeader = "x-ar-stream-timing";
export const responseStatusMessageType = "ar:response-log-status";
type RequestHeaders = Record<string, string | string[] | undefined>;

export function createGatewayStreamMetrics(now = () => performance.now()) {
  const starts = new WeakMap<RequestHeaders, number>();
  return {
    start(headers: RequestHeaders | undefined) {
      if (!headers) return;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === streamTimingHeader) delete headers[key];
      }
      starts.set(headers, now());
    },
    wrap(response: Response, headers: RequestHeaders | undefined): Response | undefined {
      const startedAt = headers && starts.get(headers);
      if (!headers || startedAt === undefined || !response.body) return undefined;
      delete headers[streamTimingHeader];
      const tracker = createStreamMetricsTracker(startedAt);
      const reader = response.body.getReader();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const metrics = tracker.finish(now());
        if (metrics.firstTokenAtMs !== undefined && metrics.lastTokenAtMs !== undefined) {
          headers[streamTimingHeader] = JSON.stringify([
            Math.max(0, Math.round(metrics.firstTokenAtMs)),
            Math.max(0, Math.round(metrics.lastTokenAtMs - metrics.firstTokenAtMs))
          ]);
        }
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              reader.releaseLock();
              controller.close();
            } else {
              tracker.append(Buffer.from(value), now());
              controller.enqueue(value);
            }
          } catch (error) {
            finish();
            reader.releaseLock();
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish();
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
  timeToFirstTokenMs?: number;
  streamOutputDurationMs?: number;
} {
  const raw = headers?.[streamTimingHeader];
  if (typeof raw !== "string") return {};
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length !== 2 ||
      !values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return {};
    return { timeToFirstTokenMs: values[0], streamOutputDurationMs: values[1] };
  } catch { return {}; }
}

export function recordGatewayResponseStatus(requestId: string | undefined, status: number | undefined): void {
  if (!requestId || status === undefined || !Number.isInteger(status) || status < 100 || status > 599 || !process.connected) return;
  // Non-streaming traces can be queued before response hooks. Send the known
  // outcome over the managed process channel rather than mutating a snapshot.
  try { process.send?.({ type: responseStatusMessageType, requestId, status }, () => undefined); } catch { /* Parent is shutting down. */ }
}
