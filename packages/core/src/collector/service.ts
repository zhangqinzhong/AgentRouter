import { Worker } from "node:worker_threads";
import path from "node:path";
import { fetchWithSystemProxy } from "@agentrouter/core/proxy/system-proxy-fetch";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Lane = { worker: Worker; pending: Map<number, Pending> };
const lanes = new Map<"usage" | "analysis", Lane>();
let nextId = 0;

function collectorLane(name: "usage" | "analysis"): Lane {
  const existing = lanes.get(name);
  if (existing) return existing;
  // Context categorization parses raw transcripts and can take tens of seconds.
  // Give it a separate event loop so saved usage queries remain responsive.
  // Only the usage lane runs collection and writes aggregate queues.
  const worker = new Worker(path.join(__dirname, "local-collector-worker.js"));
  const lane: Lane = { worker, pending: new Map() };
  lanes.set(name, lane);
  worker.unref();
  const requests = new Map<number, AbortController>();
  worker.on("message", async (message) => {
    if (message.abortFetchId) { requests.get(message.abortFetchId)?.abort(); return; }
    if (message.fetchId) {
      const controller = new AbortController();
      requests.set(message.fetchId, controller);
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetchWithSystemProxy(message.url, { ...message.init, signal: controller.signal });
        const body = new Uint8Array(await response.arrayBuffer());
        if (lanes.get(name) === lane) worker.postMessage({ fetchId: message.fetchId, status: response.status, headers: Object.fromEntries(response.headers), body });
      } catch (error) {
        if (lanes.get(name) === lane) worker.postMessage({ fetchId: message.fetchId, error: error instanceof Error ? error.message : "Provider request failed" });
      } finally { clearTimeout(timeout); requests.delete(message.fetchId); }
      return;
    }
    const request = lane.pending.get(message.id);
    if (!request) return;
    lane.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.data);
    if (!lane.pending.size) worker.unref();
  });
  const fail = (error: Error) => {
    if (lanes.get(name) !== lane) return;
    lanes.delete(name);
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    for (const request of lane.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    lane.pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`Local collector exited (${code})`)));
  return lane;
}

export function queryLocalCollector(endpoint: string, query: Record<string, string> = {}): Promise<unknown> {
  const lane = collectorLane(endpoint.endsWith("usage-category-breakdown") ? "analysis" : "usage");
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      lane.pending.delete(id);
      if (!lane.pending.size) lane.worker.unref();
      reject(new Error("Local collection timed out"));
    }, 180_000);
    lane.pending.set(id, { resolve, reject, timer });
    lane.worker.ref();
    lane.worker.postMessage({ id, path: endpoint, query });
  });
}
