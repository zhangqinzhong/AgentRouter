// Standalone build for running the gateway outside the AgentRouter bundle.
// The desktop/CLI builds compile src/index.ts directly through esbuild.
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "src", "index.ts")],
  external: ["diff", "fastify", "glob", "openai", "undici", "ws"],
  format: "cjs",
  logLevel: "info",
  outfile: path.join(root, "dist", "index.js"),
  platform: "node",
  sourcemap: true,
  target: "node20"
});
