import ts from 'typescript';

// ai-gateway wraps unparseable upstream text in {raw}, then forwards its HTML
// content type with an object payload. Fastify throws after asynchronous onSend
// hooks, escaping the request handler and terminating the gateway process.
export function patchGatewayNonJsonResponse(source) {
  const ast = ts.createSourceFile('gateway.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body && node.parameters.length === 4) {
      const body = node.body.getText(ast);
      if (body.includes('.headers.forEach') && body.includes('.removeHeaders') && body.includes('.send(')) matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (matches.length !== 1) throw new Error(`Gateway non-JSON patch: expected one passthrough response sender, found ${matches.length}. Review the upstream change.`);
  const fn = matches[0];
  const [reply, upstream, payload] = fn.parameters.map(p => p.name.getText(ast));
  const original = fn.body.getText(ast);
  const send = `${reply}.send(${payload})`;
  if (!original.includes(send)) throw new Error('Gateway non-JSON patch: response send changed.');
  const body = original.replace(send, `(() => {
    const value = ${payload};
    const structured = value !== null && typeof value === 'object' && !Buffer.isBuffer(value)
      && typeof value.pipe !== 'function' && typeof value.getReader !== 'function';
    if (structured) {
      // The response has already been parsed into an object, so its content
      // type must describe JSON even when a response hook retained text/html.
      ${reply}.header('content-type', 'application/json; charset=utf-8');
      if (Object.keys(value).length === 1 && typeof value.raw === 'string'
          && !/application\\/(?:[\\w.+-]*\\+)?json/i.test(${upstream}.headers.get('content-type') || '')) {
        return ${reply}.code(502).send({error: {
          code: 'invalid_upstream_response',
          message: 'Upstream returned a non-JSON response. Check the provider API endpoint.'
        }});
      }
    }
    return ${reply}.send(value);
  })()`);
  return source.slice(0, fn.body.getStart(ast)) + body + source.slice(fn.body.end);
}
