import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {patchGatewayResponsesErrors} from '../../build/patches/gateway-responses-errors.mjs';
const require=createRequire(import.meta.url);
const original=readFileSync(require.resolve('@the-next-ai/ai-gateway'),'utf8');
const patched=patchGatewayResponsesErrors(original);
const ast=ts.createSourceFile('patched.js',patched.contents,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functions=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(fn=>[fn.name.text,fn]));
const selected=new Set();
function include(name){if(selected.has(name))return;selected.add(name);const node=functions.get(name);assert.ok(node,`Missing ${name}`);const params=new Set(node.parameters.map(p=>p.name.getText(ast)));function walk(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&!params.has(n.expression.text)&&functions.has(n.expression.text))include(n.expression.text);ts.forEachChild(n,walk)}walk(node.body);}
include(patched.pumpName);
const pump=vm.runInNewContext([...selected].map(n=>functions.get(n).getText(ast)).join('\n')+'\n'+patched.pumpName,{TextEncoder,TextDecoder,ReadableStream,Response,Error,require});
const encoder=new TextEncoder();
const event=(type,fields={})=>`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`;
const created=event('response.created',{response:{id:'resp_fixture',model:'gpt-fixture',status:'in_progress',output:[]}});
const completed=event('response.completed',{response:{id:'resp_fixture',status:'completed',output:[]}});
async function relay(chunks,{open=false,fail=false}={}){
 let canceled=false;
 const input=new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(typeof chunk==='string'?encoder.encode(chunk):chunk);if(!open&&!fail)c.close();},pull(c){if(fail)c.error(new Error('fixture socket reset'));},cancel(){canceled=true;}});
 const state={completed:false,done:false,outputItems:[],pending:'',syntheticCompletionSent:false};
 const output=new ReadableStream({start(c){void pump(input.getReader(),new TextDecoder(),new TextEncoder(),c,state);}});
 const text=await new Response(output).text();return {text,canceled,state};
}
function events(text){return text.split(/\r?\n\r?\n|\r\r/).map(block=>block.split('\n').find(line=>line.startsWith('data:'))?.slice(5).trim()).filter(x=>x&&x!=='[DONE]').map(JSON.parse)}
function failure(text){const rows=events(text);assert.equal(rows.filter(e=>e.type==='response.failed').length,1);assert.equal(rows.some(e=>e.type==='response.completed'),false);assert.equal(text.includes('msg_gateway_error_'),false);return rows.find(e=>e.type==='response.failed').response;}

test('real packaged dependency overload becomes a failed response, without waiting for EOF',async()=>{
 const result=await Promise.race([relay([created,event('error',{code:'server_error',message:'Our servers are currently overloaded. Please try again later.'})],{open:true}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Failure waited for EOF')),500))]);
 const response=failure(result.text);assert.equal(response.status,'failed');assert.equal(response.error.code,'server_error');assert.match(response.error.message,/overloaded/);assert.equal(result.canceled,true);
});
test('fragmented UTF-8 and CRLF failure preserves upstream code and message',async()=>{
 const raw=(created+event('response.failed',{response:{id:'resp_fixture',status:'failed',error:{code:'rate_limit_exceeded',message:'额度已耗尽',type:'rate_limit_error'}}})).replaceAll('\n','\r\n');
 const bytes=encoder.encode(raw);const result=await relay(Array.from(bytes,b=>new Uint8Array([b])));const r=failure(result.text);assert.equal(r.error.code,'rate_limit_exceeded');assert.equal(r.error.message,'额度已耗尽');
});
test('partial output remains visible, but a later upstream failure cannot become completion',async()=>{
 const delta=event('response.output_text.delta',{delta:'partial'});const result=await relay([created+delta+event('error',{code:'server_error',message:'overloaded'})+completed]);assert.ok(result.text.includes(delta));failure(result.text);
});
test('premature EOF including bare DONE is a failure',async()=>{
 for(const ending of ['', 'data: [DONE]\n\n'])failure((await relay([created,ending])).text);
});
test('socket read failure becomes an explicit stream failure',async()=>{const r=failure((await relay([created],{fail:true})).text);assert.match(r.error.message,/socket reset/)});
test('successful streams pass through unchanged',async()=>{const input=created+event('response.output_text.delta',{delta:'正常'})+completed+'data: [DONE]\n\n';assert.equal((await relay([input])).text,input)});
test('incomplete terminal event is preserved instead of replaced with synthetic success/failure',async()=>{const input=created+event('response.incomplete',{response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}});assert.equal((await relay([input])).text,input)});
test('unknown upstream implementation fails build instead of silently dropping the fix',()=>{assert.throws(()=>patchGatewayResponsesErrors('export const changed = true'),/Review the upstream change/)});
