import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Compatibility fix for ai-gateway 1.0.21. Patch at bundle time, including fresh
// npm installs; never mutate node_modules or the running installed gateway.
export function patchGatewayResponsesErrors(source) {
  const ast=ts.createSourceFile('gateway.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const functions=[];
  function visit(node){if(ts.isFunctionDeclaration(node)&&node.body)functions.push(node);ts.forEachChild(node,visit);}visit(ast);
  function unique(predicate,label){const matches=functions.filter(predicate);if(matches.length!==1)throw Error(`Gateway Responses patch: expected one ${label}, found ${matches.length}. Review the upstream change.`);return matches[0];}
  const failure=unique(n=>n.body.getText(ast).includes('msg_gateway_error_'),'synthetic completion function');
  const calls=(node,name)=>{let found=false;function walk(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===name)found=true;ts.forEachChild(n,walk);}walk(node.body);return found;};
  const relay=unique(n=>calls(n,failure.name.text)&&n.body.getText(ast).includes('.suppress'),'SSE relay');
  const pump=unique(n=>calls(n,failure.name.text)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword),'stream pump');
  const inspection=relay.body.statements[0].declarationList?.declarations[0]?.initializer;
  if(!inspection || !ts.isCallExpression(inspection) || !ts.isIdentifier(inspection.expression))throw Error('Gateway SSE inspection structure changed');
  const inspector=inspection.expression.text;
  const edits=[];
  const set=(fn,body)=>edits.push({start:fn.body.getStart(ast),end:fn.body.end,text:body});
  const [encoder,controller,state]=failure.parameters.map(p=>p.name.getText(ast));
  set(failure,`{
    if (!${state}.error || ${state}.completed || ${state}.syntheticCompletionSent) return;
    ${state}.syntheticCompletionSent = true;
    const response = {
      id: ${state}.responseId || 'resp_gateway_error_' + require('node:crypto').randomUUID().replaceAll('-', ''),
      object: 'response', created_at: Math.floor(Date.now()/1000), status: 'failed',
      model: ${state}.responseModel || 'unknown',
      output: ${state}.outputItems.filter(item => item && typeof item === 'object'),
      error: { code: ${state}.error.code || 'server_error', message: ${state}.error.message, type: ${state}.error.type || 'server_error' }
    };
    ${controller}.enqueue(${encoder}.encode('event: response.failed\\ndata: ' + JSON.stringify({type:'response.failed',response}) + '\\n\\n'));
  }`);
  const [block,raw,enc,ctrl,st]=relay.parameters.map(p=>p.name.getText(ast));
  set(relay,`{
    if (${st}.syntheticCompletionSent) return;
    const action = ${inspector}(${block}, ${st});
    if (${st}.error && !${st}.completed) {
      ${failure.name.text}(${enc}, ${ctrl}, ${st});
      return;
    }
    // An incomplete response is a real terminal event, not a broken connection.
    const data = ${block}.split(/\\r?\\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\\n');
    try { if (JSON.parse(data).type === 'response.incomplete') ${st}.completed = true; } catch {}
    if (action.done) ${st}.done = true;
    if (!action.suppress) ${ctrl}.enqueue(${enc}.encode(${raw}));
  }`);
  // Retain the upstream framing/UTF-8 parser; only change terminal semantics.
  let processName,flushName;
  function findCalls(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
    const args=node.arguments;
    if(args.length===4 && ts.isCallExpression(args[0]))processName=node.expression.text;
    if(args.length===3 && node.expression.text!==failure.name.text)flushName=node.expression.text;
  }ts.forEachChild(node,findCalls);}findCalls(pump.body);
  if(!processName||!flushName)throw Error('Gateway stream parser calls changed');
  const [reader,decoder,en,ct,s]=pump.parameters.map(p=>p.name.getText(ast));
  set(pump,`{
    try {
      while (true) {
        const chunk = await ${reader}.read();
        if (chunk.done) break;
        ${processName}(${decoder}.decode(chunk.value,{stream:true}),${en},${ct},${s});
        if (${s}.syntheticCompletionSent) { ${ct}.close(); return; }
      }
      const remaining=${decoder}.decode();
      if(remaining) ${processName}(remaining,${en},${ct},${s});
      ${flushName}(${en},${ct},${s});
      if (!${s}.completed && !${s}.error) ${s}.error={code:'server_error',message:'Upstream Responses stream ended before a terminal event.'};
      ${failure.name.text}(${en},${ct},${s});
      ${ct}.close();
    } catch (error) {
      if (!${s}.completed) {
        ${s}.error ??= {code:'server_error',message:error instanceof Error?error.message:'Upstream Responses stream failed.'};
        try { ${failure.name.text}(${en},${ct},${s}); ${ct}.close(); } catch { /* Client already canceled. */ }
      } else { try { ${ct}.close(); } catch {} }
    } finally {
      if (${s}.syntheticCompletionSent) void ${reader}.cancel().catch(()=>{});
    }
  }`);
  let result=source;
  for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  return {contents:result.replace(/\/\/# sourceMappingURL=.*$/gm,''),pumpName:pump.name.text};
}

export function gatewayResponsesErrorsPlugin(packageRoot){
  const targets=new Set(['dist/index.js','src/gateway/handler.ts'].map(p=>path.resolve(packageRoot,p)));
  return {name:'gateway-responses-error-semantics',setup(build){
    build.onLoad({filter:/\.(?:js|ts)$/},async args=>{
      if(!targets.has(path.resolve(args.path)))return;
      const patched=patchGatewayResponsesErrors(await readFile(args.path,'utf8'));
      return {contents:patched.contents,loader:args.path.endsWith('.ts')?'ts':'js',resolveDir:path.dirname(args.path)};
    });
  }};
}
