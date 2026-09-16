import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import type { ProfileConfig } from "@agentrouter/core/contracts/app";
import { createHash } from "node:crypto";

export function profileTerminalLaunch(configDir: string, launcher: string, profileId: string, platform = process.platform, terminalApp: ProfileConfig["terminalApp"] = "otty", extraArgs: string[] = []): {
  command: string; args: string[]; activation?: { command: string; args: string[] }; scriptFile?: string; scriptContent?: string;
} {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const extra = extraArgs.filter((arg) => typeof arg === "string" && arg.trim()).map(quote);
  const cliLine = [quote(launcher), quote(profileId), "cli", ...extra].join(" ");
  const id = createHash("sha256").update(profileId).digest("hex").slice(0, 20);
  if (platform === "darwin" && terminalApp === "otty") {
    const command = ["/Applications/Otty.app/Contents/MacOS/otty-cli", path.join(os.homedir(), "Applications/Otty.app/Contents/MacOS/otty-cli")].find(existsSync);
    if (!command) throw new Error("Otty is not installed. Install Otty or choose another launch terminal.");
    return { command, args: ["open", os.homedir(), "--command", cliLine],
      activation: { command: "/usr/bin/open", args: ["-a", path.resolve(command, "../../..")] } };
  }
  if (platform === "darwin") {
    const scriptFile = path.join(configDir, "terminal-launchers", `${id}.command`);
    return { command: "/usr/bin/open", args: ["-a", terminalApp === "iterm" ? "iTerm" : "Terminal", scriptFile], scriptFile,
      scriptContent: `#!/bin/sh\nexec ${cliLine}\n` };
  }
  if (platform === "win32") {
    if (/["%\r\n]/.test(launcher + profileId + extraArgs.join(""))) throw new Error("Terminal launch path contains unsupported Windows characters.");
    const scriptFile = path.join(configDir, "terminal-launchers", `${id}.cmd`);
    const winExtra = extraArgs.filter((arg) => typeof arg === "string" && arg.trim()).map((arg) => `"${arg}"`).join(" ");
    return { command: "cmd.exe", args: ["/d", "/c", "start", '""', scriptFile], scriptFile,
      scriptContent: `@echo off\r\n@setlocal DisableDelayedExpansion\r\n@call "${launcher}" "${profileId}" cli${winExtra ? ` ${winExtra}` : ""}\r\n@pause\r\n` };
  }
  return { command: "x-terminal-emulator", args: ["-e", launcher, profileId, "cli", ...extraArgs.filter((arg) => typeof arg === "string" && arg.trim())] };
}
