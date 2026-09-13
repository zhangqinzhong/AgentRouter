import { chmodSync, closeSync, openSync, readSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProfileConfig } from "@agentrouter/core/contracts/app";
import { assertProfileAliases } from "@agentrouter/core/profiles/alias-validation";

const marker = "# AgentRouter profile launch alias v1";
const windowsMarker = "@rem AgentRouter profile launch alias v1";
function isOwned(file: string): boolean {
  if (!existsSync(file) || !lstatSync(file).isFile()) return false;
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(128);
  let content: string;
  try { content = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
  finally { closeSync(fd); }
  return content.startsWith(`#!/bin/sh\n${marker}\n`) || content.startsWith(`${windowsMarker}\r\n`);
}

export function validateProfileAliasFiles(profiles: ProfileConfig[], binDir: string): void {
  assertProfileAliases(profiles);
  for (const profile of profiles) {
    const alias = profile.launchAlias?.trim();
    if (!alias) continue;
    if (process.platform !== "win32") {
      const declaration = new RegExp(`^\\s*(?:alias\\s+${alias}=|(?:function\\s+)?${alias}\\s*\\(\\s*\\)|function\\s+${alias}\\s*\\{)`, "m");
      for (const rc of [".zshrc", ".zshenv", ".bashrc", ".bash_profile"]) {
        const file = path.join(os.homedir(), rc);
        if (existsSync(file) && declaration.test(readFileSync(file, "utf8"))) {
          throw new Error(`Launch alias "${alias}" is already defined in ${rc}. Choose another alias or remove that shell definition first.`);
        }
      }
    }
    const name = process.platform === "win32" ? `${alias}.cmd` : alias;
    const target = path.join(binDir, name);
    if (lstatSync(target, { throwIfNoEntry: false }) && !isOwned(target)) throw new Error(`Launch alias "${alias}" conflicts with an existing file.`);
    for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      if (path.resolve(dir) === path.resolve(binDir)) continue;
      if (existsSync(path.join(dir, name))) throw new Error(`Launch alias "${alias}" conflicts with an existing command.`);
    }
  }
}

export function syncProfileAliases(profiles: ProfileConfig[], binDir: string): void {
  validateProfileAliasFiles(profiles, binDir);
  const desired = new Map<string, string>();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const profile of profiles) {
    const alias = profile.launchAlias?.trim();
    if (!alias || !profile.enabled) continue;
    const windows = process.platform === "win32";
    // IDs are opaque and passed as a single argument, independent of display names.
    if (windows && /["%\r\n]/.test(profile.id + binDir)) throw new Error("Profile alias path contains unsupported Windows characters.");
    desired.set(windows ? `${alias}.cmd` : alias, windows
      ? `${windowsMarker}\r\n@call "${path.join(binDir, "agentrouter.cmd")}" "${profile.id}" %*\r\n@exit /b %errorlevel%\r\n`
      : `#!/bin/sh\n${marker}\nexec ${quote(path.join(binDir, "agentrouter"))} ${quote(profile.id)} "$@"\n`);
  }
  if (!existsSync(binDir) && !desired.size) return;
  mkdirSync(binDir, { recursive: true });
  for (const [name, content] of desired) {
    const file = path.join(binDir, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content, { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(file, 0o755);
  }
  for (const name of readdirSync(binDir)) {
    const file = path.join(binDir, name);
    if (!desired.has(name) && isOwned(file)) rmSync(file);
  }
}
