import type { ProfileConfig } from "@agentrouter/core/contracts/app";

/** CLI arguments are data, never shell code. One argument per line in the editor. */
export function profileCliArgs(profile: ProfileConfig, extraArgs: string[]): string[] {
  const args = [...(profile.launchArgs ?? []), ...extraArgs];
  const flag = profile.agent === "claude-code" ? "--dangerously-skip-permissions"
    : profile.agent === "codex" ? "--dangerously-bypass-approvals-and-sandbox" : undefined;
  if (profile.permissionMode === "yolo" && flag && !args.includes(flag) && !(profile.agent === "codex" && args.includes("--yolo"))) {
    args.unshift(flag);
  }
  return args;
}
