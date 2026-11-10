import assert from "node:assert/strict";
import { it } from "node:test";

import { serverAddress } from "../support/server.js";

it("discovers only a complete ready line with a bound loopback port", () => {
  const startup = "INFO starting server bind=127.0.0.1:49374\n";
  const ready = "INFO MCP HTTP server ready (POST /mcp) local_addr=127.0.0.1:54321 auth=true";
  assert.equal(serverAddress(startup), undefined);
  assert.equal(serverAddress(`${startup}${ready}`), undefined, "a log write may be incomplete");
  assert.equal(serverAddress(`${startup}${ready}\n`), "127.0.0.1:54321");
  assert.equal(serverAddress(`${ready}\r\n`), "127.0.0.1:54321");
  assert.equal(serverAddress("INFO other log local_addr=127.0.0.1:54321\n"), undefined);
  for (const address of ["127.0.0.1:0", "127.0.0.1:65536", "0.0.0.0:54321"]) {
    assert.equal(serverAddress(`INFO MCP HTTP server ready local_addr=${address}\n`), undefined);
  }
});
