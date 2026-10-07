import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function macOSAppLauncherPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [path.join(resources, "app-launcher", "AgentRouterAppLauncher")] : []),
    path.join(__dirname, "app-launcher", "AgentRouterAppLauncher")
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("The macOS application launcher is missing. Rebuild or reinstall AgentRouter.");
  return found;
}

export function launchMacOSApplication(bundlePath: string, args: string[], env: NodeJS.ProcessEnv, helper = macOSAppLauncherPath()): Promise<number> {
  const canonicalBundle = realpathSync(bundlePath);
  return new Promise((resolve, reject) => {
    // Credentials travel over a private stdin pipe, never argv or a temp file.
    const child = spawn(helper, [], {stdio: ["pipe", "pipe", "pipe"]});
    let output = "";
    let settled = false;
    const finish = (error?: Error, pid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(pid!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("macOS application launch timed out; check the profile before retrying."));
    }, 35_000);
    child.stdout.on("data", data => {
      output += data.toString();
      if (output.length > 64 * 1024) { child.kill(); finish(new Error("Invalid macOS launcher response.")); }
    });
    // Do not forward helper diagnostics containing environment data to logs.
    child.stderr.resume();
    child.stdin.on("error", error => finish(error));
    child.once("error", error => finish(error));
    child.once("close", code => {
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.version !== 1 || result.error) throw new Error(result.error || "macOS application launch failed.");
        if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || result.pid === child.pid || typeof result.bundlePath !== "string" || realpathSync(result.bundlePath) !== canonicalBundle) throw new Error("Invalid application PID returned by macOS launcher.");
        finish(undefined, result.pid);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid macOS launcher response.")); }
    });
    child.stdin.end(JSON.stringify({version:1, bundlePath:canonicalBundle, arguments:args,
      environment:Object.fromEntries(Object.entries(env).filter((entry): entry is [string,string] => typeof entry[1] === "string"))}));
  });
}
