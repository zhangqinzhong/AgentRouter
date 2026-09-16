const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {createCollector}=require('../../packages/core/src/vendor/tokentracker/collector.cjs');
const {getUsageLimits,resetUsageLimitsCache}=require('../../packages/core/src/vendor/tokentracker/lib/usage-limits');

test('local collection deduplicates mirrored Claude responses and survives repeat scans/restarts',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-collector-test-'));
 try {
  const root=path.join(home,'.claude','projects','fixture');await fs.mkdir(root,{recursive:true});
  const record={type:'assistant',timestamp:'2026-09-14T01:00:00Z',requestId:'request-1',message:{id:'message-1',model:'claude-sonnet-4',usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:50}}};
  const file=path.join(root,'main.jsonl');await fs.writeFile(file,JSON.stringify(record)+'\n');await fs.writeFile(path.join(root,'mirror.jsonl'),JSON.stringify(record)+'\n');
  const c=createCollector({home,fetchImpl:async()=>{throw new Error("offline test")}});await c.sync(true);
  const query={from:'2026-09-14',to:'2026-09-14',tz:'UTC'};
  const first=await c.query('/functions/tokentracker-usage-summary',query);
  assert.equal(first.totals.total_tokens,170);
  for(let i=0;i<3;i++) {await c.sync(true);assert.deepEqual((await c.query('/functions/tokentracker-usage-summary',query)).totals,first.totals);}
  const queue=path.join(home,'.agentrouter/collector/queue.jsonl');const size=(await fs.stat(queue)).size;
  const restarted=createCollector({home,fetchImpl:async()=>{throw new Error("offline test")}});await restarted.sync(true);assert.equal((await fs.stat(queue)).size,size);
  await fs.appendFile(file,JSON.stringify({...record,requestId:'request-2',message:{...record.message,id:'message-2'}})+'\n');await restarted.sync(true);
  assert.equal((await restarted.query('/functions/tokentracker-usage-summary',query)).totals.total_tokens,340);
  const rows=(await fs.readFile(queue,'utf8')).trim().split('\n');assert.equal(rows.length,1,'one latest bucket, not one appended snapshot per sync');
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('manual renewal records are read from TokenTracker without changing its store',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-subscription-test-'));
 try{const dir=path.join(home,'.tokentracker/tracker');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'subscription-manager.json');const text=JSON.stringify({version:1,items:[{id:'manual',service:'Codex',autoRenew:true,nextBillingAt:'2026-10-01T00:00:00Z'}]});await fs.writeFile(file,text);const result=await createCollector({home,fetchImpl:async()=>{throw new Error("offline test")}}).query('/functions/tokentracker-subscription-manager');assert.equal(result.subscriptions[0].id,'manual');assert.equal(await fs.readFile(file,'utf8'),text);}finally{await fs.rm(home,{recursive:true,force:true})}
});

test('hourly heatmap and session routes stay on the local collector contract',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-collector-trend-'));
 try {
  const root=path.join(home,'.claude','projects','fixture');await fs.mkdir(root,{recursive:true});
  const record={type:'assistant',timestamp:'2026-09-14T01:00:00Z',requestId:'request-1',message:{id:'message-1',model:'claude-sonnet-4',usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:50}}};
  await fs.writeFile(path.join(root,'main.jsonl'),JSON.stringify(record)+'\n');
  const c=createCollector({home,fetchImpl:async()=>{throw new Error("offline test")}});await c.sync(true);
  const hourly=await c.query('/functions/tokentracker-usage-hourly',{day:'2026-09-14',tz:'UTC'});
  assert.ok(Array.isArray(hourly.data));
  assert.ok(hourly.data.some(row=>Number(row.total_tokens)>0));
  const heatmap=await c.query('/functions/tokentracker-usage-heatmap',{weeks:'8',tz:'UTC'});
  assert.ok(Array.isArray(heatmap.weeks));
  const sessions=await c.query('/functions/tokentracker-sessions',{tz:'UTC'});
  assert.equal(typeof sessions.available,'boolean');
  assert.ok(Array.isArray(sessions.sessions));
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('quota observer cannot rotate active CLI credentials',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-credentials-test-'));
 try {const dir=path.join(home,'.codex');await fs.mkdir(dir);const file=path.join(dir,'auth.json');const original=JSON.stringify({tokens:{access_token:'expired-access',refresh_token:'private-refresh'}});await fs.writeFile(file,original);resetUsageLimitsCache();let refreshed=false;
 await getUsageLimits({home,platform:'linux',env:{},allowCodexTokenRefresh:false,providerTimeoutMs:30,securityRunner:()=>({status:1,stdout:''}),commandRunner:()=>({status:1,stdout:''}),fetchImpl:async url=>{if(String(url).includes('/oauth/token'))refreshed=true;return {ok:false,status:401,json:async()=>({})}}});assert.equal(refreshed,false);assert.equal(await fs.readFile(file,'utf8'),original);
 }finally{resetUsageLimitsCache();await fs.rm(home,{recursive:true,force:true})}
});
