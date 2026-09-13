import type { ProfileConfig } from "@agentrouter/core/contracts/app";

export function isValidLaunchAlias(alias: string): boolean {
  return !/^(ar|ccr)-/i.test(alias) && /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(alias) &&
    !/^(agentrouter|ar|ccr|help|version|serve|web|start|stop|restart|status|ui|claude|codex|node|npm|npx|sh|bash|zsh|cmd|powershell|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(alias);
}

export function assertProfileAliases(profiles: ProfileConfig[]): void {
  const used = new Set<string>();
  for (const profile of profiles) {
    const alias = profile.launchAlias?.trim();
    if (!alias) continue;
    if (!isValidLaunchAlias(alias)) throw new Error(`Invalid launch alias "${alias}". Use 1–48 letters, digits, hyphens or underscores, starting with a letter; reserved commands are not allowed.`);
    const key = alias.toLowerCase();
    if (used.has(key)) throw new Error(`Launch alias "${alias}" is already used by another profile.`);
    if (profiles.some((other) => other.id !== profile.id && [other.id, other.name].some((value) => value?.trim().toLowerCase() === key))) {
      throw new Error(`Launch alias "${alias}" conflicts with another profile name or ID.`);
    }
    used.add(key);
  }
}
