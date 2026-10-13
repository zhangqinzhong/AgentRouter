// Compatibility bridge for legacy usage-detail routes. Parsing is owned by
// AgentRouter session-core; the session workspace uses its indexed identity API.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
function binaryPath() {
  const name =
    "agentrouter-session-reader" + (process.platform === "win32" ? ".exe" : "");
  const runtime = path
    .resolve(__dirname, "../..", name)
    .replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  if (fs.existsSync(runtime)) return runtime;
  // Source checkout tests only. Installed packages never consult Wake.app.
  const dev = path.resolve(
    __dirname,
    "../../../../../../native/session-reader/target/release",
    name,
  );
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    "Bundled session reader is missing. Rebuild AgentRouter.",
  );
}
async function readTranscript(files, source, offset = 0) {
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      settled = false;
    const child = spawn(binaryPath(), [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Session parsing timed out"));
    }, 30000);
    child.on("error", finish);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 12 * 1024 * 1024) {
        child.kill();
        finish(new Error("Session response exceeds size limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("close", (code) => {
      if (code !== 0)
        return finish(new Error(stderr.trim() || "Session parsing failed"));
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error("Invalid session reader response"));
      }
    });
    child.stdin.end(JSON.stringify({ source, files, offset }));
  });
}
module.exports = { readTranscript };
