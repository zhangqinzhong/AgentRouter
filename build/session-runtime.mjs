import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Replace executable inodes atomically: overwriting a previously executed Mach-O
// can leave macOS code-signature caches attached to the old bytes (SIGKILL).
function installExecutable(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, destination);
}
export function buildSessionRuntime(destinations) {
  const platform = process.env.AR_BUILD_PLATFORM || process.platform;
  const arch = process.env.AR_BUILD_ARCH || process.arch;
  if (platform !== process.platform || arch !== process.arch)
    throw new Error(
      "Build the session engine on the target platform/architecture. Cross-compilation is not configured.",
    );
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(root, "native/session-reader/Cargo.toml"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(root, "native/session-core/Cargo.toml"),
      "--bin",
      "agentrouter-session-cli",
      "--bin",
      "agentrouter-session-mcp",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const name =
    "agentrouter-session-reader" + (process.platform === "win32" ? ".exe" : "");
  for (const dir of destinations) {
    mkdirSync(dir, { recursive: true });
    cpSync(
      path.join(root, "native/session-core/marketplace"),
      path.join(dir, "session-marketplace"),
      { recursive: true },
    );
    cpSync(
      path.join(root, "native/session-core/integration"),
      path.join(dir, "session-marketplace/plugins/agentrouter-sessions"),
      { recursive: true },
    );
    cpSync(
      path.join(root, "native/session-core/integration"),
      path.join(dir, "session-plugin"),
      { recursive: true },
    );
    installExecutable(
      path.join(root, "native/session-reader/target/release", name),
      path.join(dir, name),
    );
    chmodSync(path.join(dir, name), 0o755);
    for (const bin of ["agentrouter-session-cli", "agentrouter-session-mcp"]) {
      const executable = bin + (process.platform === "win32" ? ".exe" : "");
      installExecutable(
        path.join(root, "native/session-core/target/release", executable),
        path.join(dir, executable),
      );
      chmodSync(path.join(dir, executable), 0o755);
    }
    const binaries = Object.fromEntries(
      [
        "agentrouter-session-reader",
        "agentrouter-session-cli",
        "agentrouter-session-mcp",
      ].map((stem) => {
        const name = stem + (platform === "win32" ? ".exe" : "");
        return [
          name,
          createHash("sha256")
            .update(readFileSync(path.join(dir, name)))
            .digest("hex"),
        ];
      }),
    );
    writeFileSync(
      path.join(dir, "session-runtime.json"),
      JSON.stringify({ version: 1, platform, arch, binaries }, null, 2),
    );
    copyFileSync(
      path.join(root, "native/session-core/LICENSE"),
      path.join(dir, "session-core-LICENSE"),
    );
  }
}
