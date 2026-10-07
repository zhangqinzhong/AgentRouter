import assert from "node:assert/strict";
import test from "node:test";
import { memoryReadPath, MemoryTransport } from "../../../src/memory/transport.ts";
import { createServer } from "node:http";

test("memory reads require an explicit scope and encode paths without admitting URL injection", () => {
  assert.equal(memoryReadPath({ resource: "projects" }), "/api/v1/projects");
  assert.equal(memoryReadPath({ resource: "page", scope: { workspace: "floatboat", project: "backend" }, path: "notes/hello world.md" }), "/api/v1/workspaces/floatboat/projects/backend/pages/notes/hello%20world.md");
  assert.throws(() => memoryReadPath({ resource: "pages" }), /Select/);
  assert.throws(() => memoryReadPath({ resource: "pages", scope: { workspace: "../../admin", project: "x" } }), /valid/);
  assert.throws(() => memoryReadPath({ resource: "page", scope: { workspace: "x", project: "y" }, path: "../secret" }), /Invalid/);
  assert.throws(() => memoryReadPath({ resource: "http://example.com/" }), /Unsupported/);
  assert.throws(() => memoryReadPath({ resource: "search", scope: { workspace: "x" }, query: "q" }), /together/);
  assert.match(memoryReadPath({ resource: "search", query: "a&b" }), /q=a%26b/);
});

test("memory transport carries server-only auth and parses stateless SSE responses", async () => {
  let authorization;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const transport = new MemoryTransport(`http://127.0.0.1:${server.address().port}`, () => "server-only");
    assert.deepEqual(await transport.rpc("tools/list", {}), { tools: [] });
    assert.equal(authorization, "Bearer server-only");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
