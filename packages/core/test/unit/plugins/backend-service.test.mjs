import assert from "node:assert/strict";
import test from "node:test";
import { backendService } from "@agentrouter/core/plugins/backend-service.ts";

test("HTTP backend catches synchronous throws and remains available for later requests", async () => {
  let calls = 0;
  const owner = "sync-error-regression";
  const backend = await backendService.registerHttpBackend(owner, {
    handler(_request, response) {
      if (++calls === 1) throw new Error("sync failure");
      response.end("ok");
    }
  });
  try {
    const failed = await fetch(backend.url);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: { message: "sync failure" } });
    const next = await fetch(backend.url);
    assert.equal(next.status, 200);
    assert.equal(await next.text(), "ok");
  } finally {
    await backendService.stopOwner(owner);
  }
});
