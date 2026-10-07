import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {patchGatewayNonJsonResponse} from '../../build/patches/gateway-non-json.mjs';
const require = createRequire(import.meta.url);
const original = readFileSync(require.resolve('@the-next-ai/ai-gateway'), 'utf8');
const ast = ts.createSourceFile('patched.js', patchGatewayNonJsonResponse(original), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(fn => [fn.name.text, fn]));
const sender = [...functions.values()].find(fn => fn.body.getText(ast).includes("code: 'invalid_upstream_response'"));
const selected = new Set();
function include(name) {
  if (selected.has(name)) return;
  selected.add(name);
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && functions.has(node.expression.text)) include(node.expression.text);
    ts.forEachChild(node, walk);
  }
  walk(functions.get(name).body);
}
include(sender.name.text);
const blockedHeaders = sender.body.getText(ast).match(/!([\w$]+)\.has\(/)[1];
const send = vm.runInNewContext([...selected].map(name => functions.get(name).getText(ast)).join('\n') + '\n' + sender.name.text, {Buffer, [blockedHeaders]: new Set()});

test('real Fastify async send: HTML wrapper returns 502 and the next JSON request succeeds', async () => {
  const app = require('fastify')();
  app.addHook('onSend', async (_request, _reply, payload) => payload);
  app.get('/bad', async (_request, reply) => send(reply, new Response('<html>login</html>', {headers:{'content-type':'text/html'}}), {raw:'<html>login</html>'}, {headers:{'content-type':'text/html'}}));
  app.get('/good', async (_request, reply) => send(reply, new Response('{}', {headers:{'content-type':'application/json'}}), {choices:[{message:{content:'OK'}}]}, {headers:{'content-type':'application/json'}}));
  app.get('/structured', async (_request, reply) => send(reply, new Response('{}', {headers:{'content-type':'text/plain'}}), {answer:'OK'}, {headers:{'content-type':'text/plain'}}));
  try {
    for (let i=0;i<3;i++) {
      const bad = await app.inject('/bad');
      assert.equal(bad.statusCode,502);
      assert.equal(bad.json().error.code,'invalid_upstream_response');
      assert.match(bad.headers['content-type'], /application\/json/);
      const good = await app.inject('/good');
      assert.equal(good.statusCode,200);
      assert.equal(good.json().choices[0].message.content,'OK');
    }
    assert.deepEqual((await app.inject('/structured')).json(),{answer:'OK'});
  } finally { await app.close(); }
});
test('unrecognized upstream sender fails the build', () => {
  assert.throws(() => patchGatewayNonJsonResponse('export const changed = true'), /Review the upstream change/);
});
