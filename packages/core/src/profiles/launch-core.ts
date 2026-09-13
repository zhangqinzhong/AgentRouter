import { profileCliArgs } from "@agentrouter/core/profiles/launch-options";
import path from "node:path";
import type { AppConfig, ProfileConfig, ProfileOpenSurface } from "@agentrouter/core/contracts/app";
import { claudeCodeModelEnv as claudeCodeProfileModelEnv, claudeCodeUtcTimezoneEnvOverride } from "@agentrouter/core/agents/claude-code/environment";
import { resolveKiloConfigFile as resolveKiloProfileConfigFile } from "@agentrouter/core/agents/kilo/profile-config";
import { resolveOpenCodeConfigFile as resolveOpenCodeProfileConfigFile } from "@agentrouter/core/agents/opencode/profile-config";
import { piWrapperFilename, resolvePiAgentDir, resolvePiSessionDir } from "@agentrouter/core/agents/pi/profile-config";
import { resolveZcodeConfigFile } from "@agentrouter/core/agents/zcode/profile-config";

export type ProfileLaunchPlan = {
  args: string[];
  command: string;
  env: Record<string, string>;
  profile: ProfileConfig;
  surface: ProfileOpenSurface;
};

export type ProfileLaunchSpawnCommand = {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
};

export function findProfileForOpen(config: Pick<AppConfig, "profile">, profileRef: string): ProfileConfig {
  const needle = profileRef.trim();
  if (!needle) {
    throw new Error("Profile name is required.");
  }

  const profiles = config.profile.profiles.filter((profile) => profile.enabled);
  const exactId = profiles.find((profile) => profile.id === needle);
  if (exactId) {
    return exactId;
  }

  const normalizedNeedle = normalizeLookupValue(needle);
  const matches = profiles.filter((profile) =>
    (Boolean(profile.launchAlias) && normalizeLookupValue(profile.launchAlias!) === normalizedNeedle) ||
    normalizeLookupValue(profile.name) === normalizedNeedle ||
    normalizeLookupValue(profile.id) === normalizedNeedle ||
    sanitizePathSegment(profile.name) === normalizedNeedle ||
    sanitizePathSegment(profile.id) === normalizedNeedle
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Profile "${needle}" is ambiguous. Use the profile ID instead.`);
  }
  throw new Error(`Profile "${needle}" was not found or is disabled.`);
}

export function profileOpenSurfaces(profile: ProfileConfig): ProfileOpenSurface[] {
  if (profile.agent === "workbuddy" || profile.agent === "zcode" || profile.agent === "claude-design") {
    return ["app"];
  }
  if (profile.agent === "grok" || profile.agent === "kimi" || profile.agent === "pi" || profile.agent === "kilo") {
    return ["cli"];
  }
  const surface = normalizeProfileSurface(profile.surface);
  if (surface === "cli") {
    return ["cli"];
  }
  if (surface === "app") {
    return ["app"];
  }
  return ["cli", "app"];
}

export function resolveProfileOpenSurface(profile: ProfileConfig, surface?: ProfileOpenSurface): ProfileOpenSurface {
  const surfaces = profileOpenSurfaces(profile);
  if (surface) {
    if (!surfaces.includes(surface)) {
      throw new Error(`${profile.name || profile.id} does not support ${surface.toUpperCase()} opening.`);
    }
    return surface;
  }
  return surfaces[0];
}

export function defaultProfileOpenSurface(profile: Pick<ProfileConfig, "agent">): ProfileOpenSurface {
  return profile.agent === "workbuddy" || profile.agent === "zcode" || profile.agent === "claude-design" ? "app" : "cli";
}

export function shouldAutoStartProfileGateway(
  profile: Pick<ProfileConfig, "agent">,
  surface: ProfileOpenSurface
): boolean {
  return (profile.agent === "grok" || profile.agent === "kimi" || profile.agent === "pi") && surface === "cli";
}

export function profileOpenCommand(
  profile: ProfileConfig,
  surface: ProfileOpenSurface = defaultProfileOpenSurface(profile),
  // Mirrors desktopCliCommandName in launch-service.ts, which cannot be
  // imported here without a cycle.
  command = "agentrouter",
  profileRef = profile.name?.trim() || profile.id
): string {
  const quote = process.platform === "win32" ? windowsCommandQuote : shellQuote;
  const parts = profile.launchAlias && command === "agentrouter"
    ? [quote(profile.launchAlias)]
    : [quote(command), quote(profileRef)];
  if (surface === "app") {
    parts.push(surface);
  }
  return parts.join(" ");
}

export function buildProfileLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[] = []
): ProfileLaunchPlan {
  const resolvedSurface = resolveProfileOpenSurface(profile, surface);
  if (resolvedSurface === "cli") extraArgs = profileCliArgs(profile, extraArgs);
  if (profile.agent === "claude-design") {
    throw new Error("Claude Design profiles can only be opened from AgentRouter Desktop.");
  }
  if (profile.agent === "grok") {
    return buildGrokLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  if (profile.agent === "kimi") {
    return buildKimiLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  if (profile.agent === "pi") {
    return buildPiLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  if (profile.agent === "opencode") {
    return buildOpenCodeLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  if (profile.agent === "kilo") {
    return buildKiloLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  if (isCodexCompatibleAgent(profile.agent)) {
    return buildCodexLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
  }
  return buildClaudeCodeLaunchPlan(configDir, profile, resolvedSurface, extraArgs);
}

function buildOpenCodeLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface !== "cli") {
    throw new Error("OpenCode App profiles must be opened through AgentRouter Desktop.");
  }
  return {
    args: extraArgs,
    command: path.join(configDir, "bin", openCodeWrapperFilename(profile)),
    env: {
      AR_PROFILE_SURFACE: "cli",
      OPENCODE_CONFIG: resolveOpenCodeProfileConfigFile(configDir, profile)
    },
    profile,
    surface
  };
}

function buildKiloLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface !== "cli") {
    throw new Error("Kilo CLI profiles only support CLI opening.");
  }
  return {
    args: extraArgs,
    command: path.join(configDir, "bin", kiloWrapperFilename(profile)),
    env: {
      AR_PROFILE_SURFACE: "cli",
      KILO_CONFIG: resolveKiloProfileConfigFile(configDir, profile)
    },
    profile,
    surface
  };
}

function buildGrokLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface !== "cli") {
    throw new Error("Grok CLI profiles only support CLI opening.");
  }
  return {
    args: extraArgs,
    command: path.join(configDir, "bin", grokWrapperFilename(profile)),
    env: {
      AR_PROFILE_SURFACE: "cli"
    },
    profile,
    surface
  };
}

function buildKimiLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface !== "cli") {
    throw new Error("Kimi CLI profiles only support CLI opening.");
  }
  return {
    args: extraArgs,
    command: path.join(configDir, "bin", kimiWrapperFilename(profile)),
    env: {
      AR_PROFILE_SURFACE: "cli"
    },
    profile,
    surface
  };
}

function buildPiLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface !== "cli") {
    throw new Error("Pi profiles only support CLI opening.");
  }
  return {
    args: extraArgs,
    command: path.join(configDir, "bin", piWrapperFilename(profile)),
    env: {
      AR_PROFILE_SURFACE: "cli",
      PI_CODING_AGENT_DIR: resolvePiAgentDir(configDir, profile),
      PI_CODING_AGENT_SESSION_DIR: resolvePiSessionDir(configDir, profile)
    },
    profile,
    surface
  };
}

export function profileLaunchSpawnCommand(plan: Pick<ProfileLaunchPlan, "args" | "command">): ProfileLaunchSpawnCommand {
  if (!isWindowsCommandScript(plan.command)) {
    return {
      args: plan.args,
      command: plan.command
    };
  }
  let cmdLine = `"${plan.command}"`;
  if (plan.args && plan.args.length > 0) {
    cmdLine += " " + plan.args.join(" ");
  }
  return {
    args: ["/d", "/v:off", "/c", cmdLine],
    command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    windowsVerbatimArguments: true
  };
}

export function arManagedProfileDir(configDir: string, profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent);
  const baseDir = path.join(configDir, "profiles", slug || "profile");
  return profile.scope === "custom" ? path.join(baseDir, "custom") : baseDir;
}

export function resolveClaudeCodeSettingsFile(configDir: string, profile: ProfileConfig): string {
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(arManagedProfileDir(configDir, profile), "claude", "settings.json");
  }
  return resolveUserPath(profile.settingsFile || "~/.claude/settings.json");
}

export function resolveCodexConfigFile(configDir: string, profile: ProfileConfig): string {
  if (profile.agent === "zcode") {
    return resolveZcodeConfigFile(profile);
  }
  if (isGeneratedProfileScope(profile.scope)) {
    return path.join(arManagedProfileDir(configDir, profile), codexConfigSubdir(profile.agent), "config.toml");
  }
  const codexHome = profile.codexHome?.trim();
  if (codexHome) {
    return path.join(resolveUserPath(codexHome), "config.toml");
  }
  return resolveUserPath(profile.configFile || defaultCodexConfigFile(profile.agent));
}

export function resolveOpenCodeConfigFile(configDir: string, profile: ProfileConfig): string {
  return resolveOpenCodeProfileConfigFile(configDir, profile);
}

export function resolveKiloConfigFile(configDir: string, profile: ProfileConfig): string {
  return resolveKiloProfileConfigFile(configDir, profile);
}

function buildCodexLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  const providerId = sanitizeCodexProviderId(profile.providerId || "") || "claude-code-router";
  const launcher = path.join(configDir, "bin", codexMiddlewareFilename(profile, providerId));
  return {
    args: surface === "app" && extraArgs.length === 0 ? ["app"] : extraArgs,
    command: launcher,
    env: {
      AR_PROFILE_SURFACE: surface
    },
    profile,
    surface
  };
}

function buildClaudeCodeLaunchPlan(
  configDir: string,
  profile: ProfileConfig,
  surface: ProfileOpenSurface,
  extraArgs: string[]
): ProfileLaunchPlan {
  if (surface === "app") {
    throw new Error("Claude App opening is available from the AgentRouter desktop app.");
  }
  const settingsFile = resolveClaudeCodeSettingsFile(configDir, profile);
  const launcher = path.join(configDir, "bin", claudeCodeWrapperFilename(profile));
  return {
    args: extraArgs,
    command: launcher,
    env: {
      CLAUDE_CONFIG_DIR: path.dirname(settingsFile),
      AR_PROFILE_SURFACE: surface,
      ...claudeCodeProfileModelEnv(profile),
      ...claudeCodeUtcTimezoneEnvOverride()
    },
    profile,
    surface
  };
}

function isCodexCompatibleAgent(agent: ProfileConfig["agent"]): boolean {
  return agent === "codex" || agent === "workbuddy" || agent === "zcode";
}

function defaultCodexConfigFile(agent: ProfileConfig["agent"]): string {
  return agent === "zcode"
    ? "~/.zcode/cli/config.json"
    : agent === "workbuddy"
      ? "~/.workbuddy/config.toml"
    : agent === "pi"
      ? "~/.pi/agent"
      : agent === "claude-design"
        ? "~/.claude-code-router/claude-design"
        : "~/.codex/config.toml";
}

function codexConfigSubdir(agent: ProfileConfig["agent"]): string {
  return agent === "zcode" ? "zcode" : agent === "workbuddy" ? "workbuddy" : "codex";
}

function claudeCodeWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "claude-code";
  return process.platform === "win32"
    ? `ar-claude-code-wrapper-${slug}.cmd`
    : `ar-claude-code-wrapper-${slug}`;
}

function grokWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "grok";
  return process.platform === "win32"
    ? `ar-grok-cli-wrapper-${slug}.cmd`
    : `ar-grok-cli-wrapper-${slug}`;
}

function kimiWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "kimi";
  return process.platform === "win32"
    ? `ar-kimi-cli-wrapper-${slug}.cmd`
    : `ar-kimi-cli-wrapper-${slug}`;
}

function openCodeWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "opencode";
  return process.platform === "win32"
    ? `ar-opencode-wrapper-${slug}.cmd`
    : `ar-opencode-wrapper-${slug}`;
}

function kiloWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "kilo";
  return process.platform === "win32"
    ? `ar-kilo-wrapper-${slug}.cmd`
    : `ar-kilo-wrapper-${slug}`;
}

function codexMiddlewareFilename(profile: ProfileConfig, providerId: string): string {
  const slug = sanitizeCodexProviderId(profile.id || profile.name || providerId) || "codex";
  return process.platform === "win32"
    ? `ar-codex-cli-stdio-${slug}.cmd`
    : `ar-codex-cli-stdio-${slug}`;
}

function normalizeProfileSurface(value: ProfileConfig["surface"]): "auto" | "cli" | "app" {
  return value === "cli" || value === "app" ? value : "auto";
}

function isGeneratedProfileScope(value: unknown): boolean {
  return value === "agentrouter" || value === "ccr" || value === "custom";
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir(), trimmed.slice(2));
  }
  return path.resolve(trimmed || ".");
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function sanitizeCodexProviderId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsCommandQuote(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ");
  return /^[A-Za-z0-9_.:/\\-]+$/.test(normalized)
    ? normalized
    : `"${normalized.replace(/"/g, '\\"')}"`;
}

function isWindowsCommandScript(command: string): boolean {
  return process.platform === "win32" && /\.(?:bat|cmd)$/i.test(path.basename(command));
}
