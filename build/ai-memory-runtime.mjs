import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const memoryVersion = "2.5.2";
// Release assets are pinned independently of the release API. Downloading a
// replacement under the same tag cannot silently replace the bundled runtime.
const assets = {
  "darwin-arm64": ["ai-memory-macos-aarch64.tar.gz", "160881fab2be3d2e9cf64f656da517c961c1e14ff4987d75a70ee1c71e17e9ef"],
  "darwin-x64": ["ai-memory-macos-x86_64.tar.gz", "35fe9b036707c587cfe75e21bbe4a49b00eac2018a047352970fd53d787e9c4a"],
  "linux-arm64": ["ai-memory-linux-aarch64.tar.gz", "813e962b10b51877948805a3dc73bcbae512c143e18772e8ca170f1f83fd2ce7"],
  "linux-x64": ["ai-memory-linux-x86_64.tar.gz", "acbf6ee84e744a9ab0a8e133a3eefbbb77811d6b4d0ca9a281e664358c1a1fc8"],
  "win32-x64": ["ai-memory-windows-x86_64.zip", "7bc4dab235feb7a26496338feb756515bf6e47ef5f0eaa4fe0e5dcaabead32d3"]
};

export async function prepareMemoryRuntime({ platform = process.platform, arch = process.arch, fromSource = process.env.AR_MEMORY_BUILD_FROM_SOURCE === "1" } = {}) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`Memory runtime is not available for ${platform}/${arch}`);
  const destination = path.join(root, ".cache", "ai-memory", memoryVersion, `${platform}-${arch}${fromSource ? "-source" : ""}`);
  const executable = platform === "win32" ? "ai-memory.exe" : "ai-memory";
  if (!existsSync(path.join(destination, "manifest.json"))) {
    mkdirSync(path.dirname(destination), { recursive: true });
    const stage = mkdtempSync(path.join(path.dirname(destination), ".stage-"));
    try {
      if (fromSource) {
        if (platform !== process.platform || arch !== process.arch) throw new Error("Source builds currently require a native target.");
        const source = path.join(root, "vendor", "ai-memory");
        const target = path.join(root, ".cache", "ai-memory-target");
        execFileSync("cargo", ["build", "--locked", "--release", "-p", "ai-memory-cli", "--target-dir", target], { cwd: source, stdio: "inherit" });
        cpSync(path.join(target, "release", executable), path.join(stage, executable));
        cpSync(path.join(source, "hooks"), path.join(stage, "hooks"), { recursive: true });
      } else {
        const response = await fetch(`https://github.com/akitaonrails/ai-memory/releases/download/v${memoryVersion}/${asset[0]}`, { signal: AbortSignal.timeout(180_000) });
        if (!response.ok) throw new Error(`Memory runtime download failed (${response.status})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash("sha256").update(bytes).digest("hex") !== asset[1]) throw new Error("Memory runtime checksum mismatch");
        const archive = path.join(stage, asset[0]);
        writeFileSync(archive, bytes);
        const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n");
        for (const member of members) {
          if (!member || path.posix.isAbsolute(member) || /^[a-z]:/i.test(member) || member.includes("\\") || member.split("/").includes("..")) {
            throw new Error("Unsafe path in memory runtime archive");
          }
        }
        const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" });
        if (listing.split("\n").filter(Boolean).some((line) => !["-", "d"].includes(line[0]))) throw new Error("Links are not allowed in memory runtime archive");
        execFileSync("tar", ["-xf", archive, "-C", stage]);
        rmSync(archive);
        // Upstream publishes a flat archive; refuse an unexpected shape.
        if (!statSync(path.join(stage, executable)).isFile() || !statSync(path.join(stage, "hooks")).isDirectory()) throw new Error("Incomplete memory runtime archive");
      }
      cpSync(path.join(root, "vendor", "ai-memory", "LICENSE"), path.join(stage, "LICENSE"));
      if (platform !== "win32") chmodSync(path.join(stage, executable), 0o755);
      const binarySha256 = createHash("sha256").update(readFileSync(path.join(stage, executable))).digest("hex");
      writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ version: memoryVersion, platform, arch, binarySha256, sourceCommit: "7580b74d0fb9d14a6d949dc92f5ea8bb7feb3c83", archiveSha256: fromSource ? null : asset[1] }, null, 2));
      renameSync(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  const manifest = JSON.parse(readFileSync(path.join(destination, "manifest.json"), "utf8"));
  if (manifest.version !== memoryVersion || manifest.platform !== platform || manifest.arch !== arch ||
      manifest.binarySha256 !== createHash("sha256").update(readFileSync(path.join(destination, executable))).digest("hex")) {
    throw new Error("Cached memory runtime failed verification; remove its cache directory and rebuild.");
  }
  return destination;
}

export async function bundleMemoryRuntime(options) {
  const runtime = await prepareMemoryRuntime(options);
  for (const pkg of ["electron", "cli", "core"]) {
    const output = path.join(root, "packages", pkg, "dist", "ai-memory");
    rmSync(output, { recursive: true, force: true });
    cpSync(runtime, output, { recursive: true });
  }
  console.log(`Bundled memory runtime ${memoryVersion}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundleMemoryRuntime({ platform: process.env.AR_BUILD_PLATFORM || process.platform, arch: process.env.AR_BUILD_ARCH || process.arch, fromSource: process.argv.includes("--source") });
}
