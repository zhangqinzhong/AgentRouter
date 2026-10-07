import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MemoryProjectSetup, MemoryProjectPlan } from "../contracts/memory";

const families = { agents: ["AGENTS.md", ".agents/skills"], "claude-code": ["CLAUDE.md", ".claude/skills"], grok: ["AGENTS.md", ".grok/skills"], devin: ["AGENTS.md", ".devin/skills"] } as const;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Change = { path: string; before: string | null; after: string };
type Plan = MemoryProjectPlan & { changes: Change[]; expires: number };
type Receipt = { directory: string; workspace: string; project: string; family: string; changes: Change[]; appliedAt: string };

// Project writes are prepared in a private staging directory using the bundled
// upstream installer, then applied only if every previewed preimage still matches.
export class MemoryProjects {
  private plans = new Map<string, Plan>();
  constructor(private dataDir: string, private run: (args: string[]) => Promise<string>) {}
  private guarded(root: string, relative: string) {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error("Project directory changed.");
    const parts = relative.split(/[\\/]/);
    if (path.isAbsolute(relative) || parts.some((part) => !part || part === ".." || part === ".")) throw new Error("Invalid project file path.");
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
    return current;
  }
  private read(file: string): string | null {
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Unsupported project file: ${file}`);
    return readFileSync(file, "utf8");
  }
  private write(file: string, text: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, text, { mode: existsSync(file) ? lstatSync(file).mode & 0o777 : 0o600, flag: "wx" }); renameSync(tmp, file); }
    finally { rmSync(tmp, { force: true }); }
  }
  private receiptFile(root: string, family: string) { return path.join(this.dataDir, "project-receipts", `${hash(root)}-${family}.json`); }
  list() {
    const dir = path.join(this.dataDir, "project-receipts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
      const receipt = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Receipt;
      const configured = receipt.changes.every((c) => {
        try { return this.read(this.guarded(receipt.directory, c.path)) === c.after; } catch { return false; }
      });
      return { directory: receipt.directory, workspace: receipt.workspace, project: receipt.project, family: receipt.family, appliedAt: receipt.appliedAt, configured };
    });
  }
  async preview(input: MemoryProjectSetup): Promise<MemoryProjectPlan> {
    if (!input || typeof input.directory !== "string" || !path.isAbsolute(input.directory)) throw new Error("Choose an absolute project directory.");
    if (!Object.hasOwn(families, input.family)) throw new Error("Unsupported instruction family.");
    for (const name of [input.workspace, input.project]) if (typeof name !== "string" || !/^[a-z0-9_][a-z0-9._-]{0,99}$/.test(name) || name === "." || name === "..") throw new Error("Use a workspace/project name containing lowercase letters, numbers, dots, underscores or hyphens.");
    const root = realpathSync(input.directory);
    if (!lstatSync(root).isDirectory() || root === path.parse(root).root) throw new Error("Choose a project directory.");
    const [instructions, skills] = families[input.family];
    const stagingRoot = path.join(this.dataDir, "project-staging"); mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(path.join(stagingRoot, "plan-"));
    const changes: Change[] = [];
    const copy = (relative: string) => {
      const before = this.read(this.guarded(root, relative));
      if (before !== null) this.write(path.join(stage, relative), before);
      return before;
    };
    try {
      copy(instructions);
      const skillRoot = this.guarded(root, skills);
      if (existsSync(skillRoot)) for (const name of readdirSync(skillRoot)) {
        if (name.startsWith("ai-memory-")) copy(`${skills}/${name}/SKILL.md`);
      }
      await this.run(["install-instructions", "--target", path.join(stage, instructions), "--skills-target-dir", path.join(stage, skills), "--compact"]);
      const files = [instructions, ...readdirSync(path.join(stage, skills)).filter((name) => name.startsWith("ai-memory-")).map((name) => `${skills}/${name}/SKILL.md`)];
      for (const relative of files) changes.push({ path: relative, before: this.read(this.guarded(root, relative)), after: readFileSync(path.join(stage, relative), "utf8") });
      const markerBefore = this.read(this.guarded(root, ".ai-memory.toml"));
      let marker = `workspace = ${JSON.stringify(input.workspace)}\nproject = ${JSON.stringify(input.project)}\n\n[briefing]\ninject_on_session_start = true\nmax_chars = 6000\n`;
      if (markerBefore !== null) {
        // Preserve all existing capture exclusions and routing settings. Refuse
        // ambiguous TOML instead of guessing or replacing someone else's scope.
        const top = markerBefore.split(/^\s*\[/m)[0];
        const field = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]+)["']\\s*(?:#.*)?$`, "m"))?.[1];
        if (field("workspace") !== input.workspace || field("project") !== input.project) throw new Error("Existing .ai-memory.toml has a different or unsupported scope. Use its existing workspace/project or edit it explicitly first.");
        marker = markerBefore;
        if (!/^\s*\[briefing\]\s*(?:#.*)?$/m.test(marker)) marker += "\n[briefing]\ninject_on_session_start = true\nmax_chars = 6000\n";
      }
      changes.push({ path: ".ai-memory.toml", before: markerBefore, after: marker });
      // A CLAUDE.md import is an explicit project convention; do not rewrite
      // arbitrary canonical instructions. The selected client gets its own
      // upstream-managed routing block without deleting existing instructions.
      const plan: Plan = { id: randomUUID(), directory: root, workspace: input.workspace, project: input.project, family: input.family,
        files: changes.map((c) => ({ path: c.path, content: c.after, changed: c.before !== c.after })), changes, expires: Date.now() + 10 * 60_000 };
      for (const [id, p] of this.plans) if (p.expires < Date.now()) this.plans.delete(id);
      if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(plan.id, plan);
      const { changes: _, expires: __, ...result } = plan; return result;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  apply(id: string) {
    const plan = this.plans.get(id);
    if (!plan || plan.expires < Date.now()) throw new Error("Project preview expired. Preview again.");
    for (const c of plan.changes) if (this.read(this.guarded(plan.directory, c.path)) !== c.before) throw new Error("Project files changed after preview. Preview again.");
    const receiptFile = this.receiptFile(plan.directory, plan.family);
    const receipt: Receipt = { directory: plan.directory, workspace: plan.workspace, project: plan.project, family: plan.family, changes: plan.changes, appliedAt: new Date().toISOString() };
    // Keep each applied preimage independently, including updates, for recovery.
    const backup = path.join(this.dataDir, "backups", `project-${plan.id}.json`);
    this.write(backup, JSON.stringify(receipt, null, 2));
    const written: Change[] = [];
    try {
      for (const c of plan.changes) { const file = this.guarded(plan.directory, c.path); if (c.before !== c.after) { this.write(file, c.after); written.push(c); } }
      this.write(receiptFile, JSON.stringify(receipt, null, 2));
      this.plans.delete(id);
      return { ...this.list().find((p) => p.directory === plan.directory && p.family === plan.family), backup };
    } catch (error) {
      for (const c of written.reverse()) { const file = this.guarded(plan.directory, c.path); if (this.read(file) === c.after) c.before === null ? rmSync(file) : this.write(file, c.before); }
      throw error;
    }
  }
}
