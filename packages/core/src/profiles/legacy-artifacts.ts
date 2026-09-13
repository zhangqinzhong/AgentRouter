import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

const backupMarker = ".ar-backup-";
const legacyBackupMarker = ".ccr-backup-";
const originalSuffixes = [".ar-original", ".ar-original-missing"] as const;
const legacyOriginalSuffixes = [".ccr-original", ".ccr-original-missing"] as const;
// Named so a future rename sweep cannot collapse the two into one and turn the
// adoption below into a no-op.
const binArtifactPrefix = "ar-";
const legacyBinArtifactPrefix = "ccr-";

/**
 * Adopt artifacts written before the AgentRouter rename by renaming them in
 * place, so the rest of the code only ever deals with the current names. Runs
 * next to the config file it belongs to and leaves existing new-name files
 * untouched. A failed rename leaves the legacy name behind; callers treat that
 * the same as a missing artifact.
 */
export function adoptLegacyArtifacts(file: string): void {
  const dir = path.dirname(file);
  const basename = path.basename(file);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const renamed = renamedLegacyEntry(entry, basename);
    if (!renamed) {
      continue;
    }
    const to = path.join(dir, renamed);
    if (existsSync(to)) {
      continue;
    }
    try {
      renameSync(path.join(dir, entry), to);
    } catch {
      // Keep the legacy name; the caller simply will not see the artifact.
    }
  }
}

/**
 * True when a pre-rename original snapshot sits next to `file`. Used only where
 * overwriting it would destroy the user's original config beyond recovery.
 */
export function hasLegacyOriginalArtifact(file: string): boolean {
  const dir = path.dirname(file);
  const basename = path.basename(file);
  return legacyOriginalSuffixes.some((suffix) => existsSync(path.join(dir, `${basename}${suffix}`)));
}

function renamedLegacyEntry(entry: string, basename: string): string | undefined {
  const legacyPrefix = `${basename}${legacyBackupMarker}`;
  if (entry.startsWith(legacyPrefix)) {
    return `${basename}${backupMarker}${entry.slice(legacyPrefix.length)}`;
  }
  for (let index = 0; index < legacyOriginalSuffixes.length; index += 1) {
    if (entry === `${basename}${legacyOriginalSuffixes[index]}`) {
      return `${basename}${originalSuffixes[index]}`;
    }
  }
  return undefined;
}

/**
 * Adopt generated launcher and runtime files in `<configDir>/bin` that were
 * written before the AgentRouter rename. The desktop launcher moved to the CLI
 * command name, everything else just moved from the `ccr-` prefix to `ar-`.
 */
export function adoptLegacyBinArtifacts(configDir: string): void {
  const binDir = path.join(configDir, "bin");
  let entries: string[];
  try {
    entries = readdirSync(binDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const renamed = renamedLegacyBinEntry(entry);
    if (!renamed) {
      continue;
    }
    const to = path.join(binDir, renamed);
    if (existsSync(to)) {
      continue;
    }
    try {
      renameSync(path.join(binDir, entry), to);
    } catch {
      // Keep the legacy name; the launcher regenerates it on the next apply.
    }
  }
}

function renamedLegacyBinEntry(entry: string): string | undefined {
  // Mirrors desktopCliCommandName, which cannot be imported here without a cycle.
  if (entry === "ccr-app") {
    return "agentrouter";
  }
  if (entry === "ccr-app.cmd") {
    return "agentrouter.cmd";
  }
  if (entry.startsWith(legacyBinArtifactPrefix)) {
    return `${binArtifactPrefix}${entry.slice(legacyBinArtifactPrefix.length)}`;
  }
  // Bin artifacts carry the same backup suffixes as config files.
  for (let index = 0; index < legacyOriginalSuffixes.length; index += 1) {
    const legacySuffix = legacyOriginalSuffixes[index];
    if (entry.endsWith(legacySuffix)) {
      return `${entry.slice(0, -legacySuffix.length)}${originalSuffixes[index]}`;
    }
  }
  const backupIndex = entry.indexOf(legacyBackupMarker);
  if (backupIndex !== -1) {
    return `${entry.slice(0, backupIndex)}${backupMarker}${entry.slice(backupIndex + legacyBackupMarker.length)}`;
  }
  return undefined;
}
