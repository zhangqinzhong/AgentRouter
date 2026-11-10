import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { startServer, type ServerHandle } from "../support/server.js";

it("starts when another listener takes a port before the server binds", {
  // Windows kill('SIGTERM') terminates the wrapper without forwarding to its child.
  skip: process.platform === "win32" && "the competing-listener wrapper forwards POSIX termination signals",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-memory-ts-bind-race-"));
  const wrapper = join(root, "competing-listener.mjs");
  const occupied = join(root, "occupied.json");
  // Interpose after the harness chooses its bind address, but before the real
  // binary starts. A preselected nonzero port is now deterministically busy;
  // binding port zero lets the real server choose its own available listener.
  await writeFile(wrapper, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const [binary, ...args] = process.argv.slice(2);
const address = args[args.indexOf("--bind") + 1];
const requested = Number(address.split(":").at(-1));
const competitor = createServer((socket) => socket.destroy());
competitor.listen(requested, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(occupied)}, JSON.stringify({ port: competitor.address().port }));
  const child = spawn(binary, args, { stdio: "inherit" });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
  child.once("error", (error) => {
    console.error(error);
    competitor.close(() => process.exit(1));
  });
  child.once("exit", (code) => competitor.close(() => process.exit(code ?? 1)));
});
`);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (binary: string, args: readonly string[], options: SpawnOptions) =>
    spawn(process.execPath, [wrapper, binary, ...args], options),
  );
  syncBuiltinESMExports();
  let server: ServerHandle | undefined;
  try {
    server = await startServer({ basePath: "/port-probe" });
    const { port } = JSON.parse(await readFile(occupied, "utf8")) as { port: number };
    assert.notEqual(Number(new URL(server.url).port), port);
    assert.equal(new URL(server.url).pathname, "/port-probe");
    const response = await fetch(`${server.url}/identity`, {
      headers: { Authorization: `Bearer ${server.rootToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { level: string }).level, "root");
  } finally {
    await server?.stop();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an early startup failure without restarting the server", async (t) => {
  const spawn = childProcess.spawn;
  const mocked = t.mock.method(
    childProcess,
    "spawn",
    (_binary: string, _args: readonly string[], options: SpawnOptions) =>
      spawn(process.execPath, ["-e", "console.error('synthetic startup failure'); process.exit(7)"], options),
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(startServer(), /ai-memory exited before it was ready:\nsynthetic startup failure/);
    assert.equal(mocked.mock.callCount(), 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
