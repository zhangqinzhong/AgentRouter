import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequestLogStore } from '@agentrouter/core/observability/request-log-store.ts';

const content = (value) => JSON.stringify({input:value.repeat(200000)});
const input = (requestId) => ({requestId,eventId:requestId,method:'POST',path:'/v1/responses',url:'http://example.invalid/v1/responses',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),durationMs:1,statusCode:200,requestBody:Buffer.from(content('x')),requestHeaders:{'content-type':'application/json'},responseHeaders:{'content-type':'application/json'},responseBodyText:'{}'});
const files = (root) => {
 const dir=path.join(root,'request-log-bodies');
 return existsSync(dir) ? readdirSync(dir,{recursive:true}).filter(x=>String(x).includes(path.sep)).map(x=>path.join(dir,String(x))) : [];
};
async function fixture(run) {
 const root=mkdtempSync(path.join(tmpdir(),'ar-body-cleanup-'));const store=new RequestLogStore(path.join(root,'logs.sqlite'));
 try { await run(store,root); } finally {await store.close();rmSync(root,{recursive:true,force:true});}
}

test('replacing body references reclaims the superseded file and keeps the new body',()=>fixture(async(store,root)=>{
 await store.record(input('replace'));const old=files(root)[0];
 await store.updateFromRawTrace({requestId:'replace',requestBodyText:content('y')});
 assert.equal(existsSync(old),false);assert.equal(files(root).length,1);assert.equal(readFileSync(files(root)[0],'utf8'),content('y'));
 // INSERT OR IGNORE must not leak the duplicate record's freshly captured body.
 await store.record(input('replace'));assert.equal(files(root).length,1);
}));

test('replaying a pending bundle does not duplicate body files',()=>fixture(async(store,root)=>{
 const source=path.join(root,'source.json');writeFileSync(source,content('z'));
 const command={kind:'raw-trace-update',sequence:1,input:{requestId:'pending',bundleId:'bundle',statusCode:200},rawTraceFiles:{requestBody:{filePath:source,sizeBytes:Buffer.byteLength(content('z')),contentType:'application/json',truncated:false}}};
 for(let i=0;i<3;i++) await store.writeBatch([command]);
 assert.equal(files(root).length,1);
 await store.writeBatch([{...command,input:{...command.input,bundleId:'new-bundle'}}]);
 assert.equal(files(root).length,1);
}));

test('rollback keeps the original referenced file and removes uncommitted replacements',()=>fixture(async(store,root)=>{
 await store.record(input('rollback'));const old=files(root)[0];const record=store.record.bind(store);
 store.record=async(value)=>{if(value.requestId==='fail')throw new Error('injected failure');return record(value);};
 await assert.rejects(store.writeBatch([
  {kind:'raw-trace-update',sequence:1,input:{requestId:'rollback',requestBodyText:content('y')}},
  {kind:'record',sequence:2,eventId:'fail',input:input('fail')}
 ]),/injected failure/);
 assert.equal(files(root).length,1);assert.equal(readFileSync(old,'utf8'),content('x'));
}));

test('startup sweep removes aged orphans but preserves referenced and fresh files',()=>fixture(async(store,root)=>{
 await store.record(input('live'));const live=files(root)[0];const shard=path.join(root,'request-log-bodies','ab');mkdirSync(shard,{recursive:true});
 const orphan=path.join(shard,'ab-orphan');const fresh=path.join(shard,'ab-fresh');writeFileSync(orphan,'old');writeFileSync(fresh,'new');
 const old=new Date(Date.now()-2*60*60*1000);utimesSync(orphan,old,old);utimesSync(live,old,old);
 await store.close();const reopened=new RequestLogStore(path.join(root,'logs.sqlite'));
 try {await reopened.initialize();assert.equal(existsSync(orphan),false);assert.equal(existsSync(live),true);assert.equal(existsSync(fresh),true);}finally{await reopened.close();}
}));
