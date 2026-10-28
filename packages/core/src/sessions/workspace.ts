import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { queryLocalCollector } from "../collector/service";
import { resolveRuntimeAppPath, resolveRuntimeConfigDir } from "../runtime/app-paths";

const allowed = new Set([
  "list",
  "search",
  "projects",
  "insights",
  "children",
  "state",
  "transcript",
  "export",
  "handoff",
  "memories",
  "memory",
  "settings",
  "location-add",
  "location-remove",
  "location-state",
  "remote-add",
  "remote-remove",
  "remote-sync",
  "remote-state",
  "resume-targets",
  "resume",
  "cleanup",
  "cleanup-review",
  "cleanup-execute",
  "cleanup-history",
  "hide",
  "hidden",
  "unhide",
  "memory-sources",
  "memory-source-add",
  "memory-source-remove",
  "memory-source-state",
  "cleanup-restore",
]);
let watcher: ChildProcessWithoutNullStreams | undefined;
let scanning = false;
let refreshQueued = false;
let lastStart = 0;
let shared = false;
let scannedAt = 0;
let scanError = "";
function binary() {
  const name =
    "agentrouter-session-reader" + (process.platform === "win32" ? ".exe" : "");
  const candidates = [
    path
      .join(__dirname, name)
      .replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
    path.resolve(process.cwd(), "native/session-reader/target/release", name),
  ];
  const found = candidates.find(existsSync);
  if (!found)
    throw new Error("Session engine is missing; rebuild AgentRouter.");
  return found;
}
function invoke(
  request: Record<string, unknown>,
  timeout = 60_000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let output = "",
      error = "",
      settled = false;
    const child = spawn(binary(), [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AR_SESSION_INDEX: path.join(
          resolveRuntimeConfigDir(),
          "sessions",
          "index.sqlite",
        ),
      },
    });
    const finish = (err?: Error, value?: Record<string, any>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Session operation timed out"));
    }, timeout);
    child.on("error", finish);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 24 * 1024 * 1024) {
        child.kill();
        finish(new Error("Session response exceeds size limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-4096);
    });
    child.on("close", (code) => {
      if (code !== 0)
        return finish(new Error(error || "Session engine failed"));
      try {
        finish(undefined, JSON.parse(output));
      } catch {
        finish(new Error("Invalid session engine response"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
let remoteSync: Promise<void> | undefined;
let remoteStarted = false;
function syncRemotes() {
  remoteStarted = true;
  if (remoteSync) return;
  remoteSync = invoke({ op: "remote-sync-enabled" }, 300_000)
    .then(() => {
      refresh();
    })
    .catch((error) => {
      scanError = String(error);
    })
    .finally(() => {
      remoteSync = undefined;
    });
}
function refresh() {
  if (watcher) {
    if (!scanning) {
      scanning = true;
      watcher.stdin.write("refresh\n");
    } else {
      refreshQueued = true;
    }
    return;
  }
  if (shared && Date.now() - lastStart < 60_000) {
    void invoke({ op: "request-refresh" }).catch((e) => {
      scanError = String(e);
    });
    return;
  }
  lastStart = Date.now();
  scanError = "";
  scanning = true;
  shared = false;
  const child = spawn(binary(), ["--watch"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AR_SESSION_INDEX: path.join(
        resolveRuntimeConfigDir(),
        "sessions",
        "index.sqlite",
      ),
    },
  });
  watcher = child;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (typeof event.scanning === "boolean") scanning = event.scanning;
        if (event.shared) shared = true;
        if (event.error) scanError = event.error;
        if (event.scanning === false && refreshQueued) {
          refreshQueued = false;
          scanning = true;
          child.stdin.write("refresh\n");
        }
        if (event.changed || event.scanning === false) scannedAt = Date.now();
      } catch {
        scanError = "Invalid watcher event";
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    scanError = (scanError + chunk).slice(-4096);
  });
  child.stdin.on("error", () => {});
  child.on("error", (e) => {
    scanError = String(e);
  });
  child.on("close", () => {
    if (watcher === child) watcher = undefined;
    scanning = false;
  });
}
process.once("exit", () => {
  watcher?.stdin.end();
});
export async function sessionWorkspace(
  value: unknown,
): Promise<Record<string, any>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid session request");
  const q = value as Record<string, unknown>;
  if (typeof q.op !== "string" || JSON.stringify(q).length > 32768)
    throw new Error("Invalid session operation");
  if (q.op === "refresh") {
    refresh();
    syncRemotes();
    return { scanning: true };
  }
  if (q.op === "integration")
    return {
      cli: path.join(
        path.dirname(binary()),
        "agentrouter-session-cli" +
          (process.platform === "win32" ? ".exe" : ""),
      ),
      mcp: path.join(
        path.dirname(binary()),
        "agentrouter-session-mcp" +
          (process.platform === "win32" ? ".exe" : ""),
      ),
      plugin: path.join(path.dirname(binary()), "session-plugin"),
      marketplace: path.join(path.dirname(binary()), "session-marketplace"),
      index: path.join(resolveRuntimeConfigDir(), "sessions", "index.sqlite"),
    };
  if (q.op === "collection-refresh") return await queryLocalCollector("/functions/tokentracker-local-sync", { sessions: "1" }) as Record<string, any>;
  if (["location-add", "location-remove", "location-state"].includes(q.op) && typeof q.path === "string") {
    q.path = q.path === "~" ? resolveRuntimeAppPath("home") : /^~[/\\]/.test(q.path) ? path.join(resolveRuntimeAppPath("home"), q.path.slice(2)) : q.path;
  }
  if (q.op === "status") return { scanning, scannedAt, error: scanError };
  if (!allowed.has(q.op)) throw new Error("Unknown session operation");
  if (q.op === "list" && !watcher && Date.now() - lastStart > 30_000) {
    refresh();
    if (!remoteStarted) syncRemotes();
  }
  const result = await invoke(q, q.op === "remote-sync" ? 300_000 : 60_000);
  if (
    [
      "location-add",
      "location-remove",
      "location-state",
      "remote-sync",
      "cleanup-execute",
      "cleanup-restore",
      "hide",
      "unhide",
      "memory-source-add",
      "memory-source-remove",
      "memory-source-state",
    ].includes(q.op)
  )
    refresh();
  const tag = (row: any) => {
    if (!row || row.host || typeof row.file_path !== "string") return;
    const relative = path.relative(
      path.join(resolveRuntimeConfigDir(), "profiles"),
      row.file_path,
    );
    if (
      relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    ) {
      row.profileId = relative.split(path.sep)[0];
    }
  };
  if (Array.isArray(result.sessions)) result.sessions.forEach(tag);
  if (Array.isArray(result.hits))
    result.hits.forEach((hit: any) => tag(hit.session));
  return { ...result, scanning, scanError };
}
