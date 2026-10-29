const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const {build}=require('esbuild');
const {createCollector,compactQueue}=require('../../packages/core/src/vendor/tokentracker/collector.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('blocked transcript analysis cannot block usage queries or reject another worker lane', {timeout:15000}, async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ar-collector-lanes-'));
 const gate=path.join(root,'gate'),started=path.join(root,'started');
 try{
  const stub=path.join(root,'fetch.cjs');await fs.writeFile(stub,'exports.fetchWithSystemProxy=async()=>{throw Error("unexpected network")};');
  const service=path.join(root,'service.cjs');
  await build({entryPoints:['packages/core/src/collector/service.ts'],outfile:service,bundle:true,platform:'node',format:'cjs',alias:{'@agentrouter/core/proxy/system-proxy-fetch':stub}});
  await fs.writeFile(path.join(root,'local-collector-worker.js'),`
const fs=require('node:fs'),{parentPort}=require('node:worker_threads');
parentPort.on('message',m=>{if(m.query.crash)process.exit(2);if(m.path.endsWith('usage-category-breakdown')){fs.writeFileSync(m.query.started,'ready');const end=Date.now()+8000;while(!fs.existsSync(m.query.gate)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}parentPort.postMessage({id:m.id,data:{ok:true}});});`);
  const {queryLocalCollector}=createRequire(__filename)(service);
  const analysis=queryLocalCollector('/functions/tokentracker-usage-category-breakdown',{gate,started});
  for(let i=0;i<200;i++){try{await fs.access(started);break}catch{}await delay(10)}
  await fs.access(started);
  try {
   const response=await Promise.race([queryLocalCollector('/functions/tokentracker-usage-summary'),delay(1000).then(()=>{throw Error('Usage was blocked by transcript parsing')})]);
   assert.equal(response.ok,true);
  } finally {await fs.writeFile(gate,'release');await analysis;}
  const results=await Promise.allSettled([
   queryLocalCollector('/functions/tokentracker-usage-category-breakdown',{crash:'1'}),
   queryLocalCollector('/functions/tokentracker-usage-summary')
  ]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
 }finally{await fs.writeFile(gate,'release').catch(()=>{});await fs.rm(root,{recursive:true,force:true})}
});

test('usage, trend and heatmap return saved data while collection/pricing are pending', {timeout:15000}, async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ar-statistics-snapshot-'));
 let release;const gate=new Promise(resolve=>{release=resolve});
 const pricing=require('../../packages/core/src/vendor/tokentracker/lib/pricing');
 try{
  pricing.resetPricingForTests();
  const home=path.join(root,'home'),dataDir=path.join(home,'.agentrouter/collector');await fs.mkdir(dataDir,{recursive:true});
  await fs.writeFile(path.join(dataDir,'queue.jsonl'),JSON.stringify({source:'claude',model:'fixture',hour_start:new Date().toISOString(),input_tokens:100,total_tokens:100})+'\n');
  const collector=createCollector({home,fetchImpl:async()=>{await gate;throw Error('offline fixture')}});
  const stub=path.join(root,'service.cjs');await fs.writeFile(stub,'exports.queryLocalCollector=(...args)=>globalThis.__snapshotCollector.query(...args);');
  const apiFile=path.join(root,'api.cjs');
  await build({entryPoints:['packages/core/src/collector/usage-page.ts'],outfile:apiFile,bundle:true,platform:'node',format:'cjs',plugins:[{name:'fixture-collector',setup(b){b.onResolve({filter:/^\.\/service$/},()=>({path:stub}));}}],define:{'process.platform':'"linux"'}});
  globalThis.__snapshotCollector=collector;
  const api=createRequire(__filename)(apiFile),to=new Date().toISOString().slice(0,10),query={from:'',to,tz:'UTC'};
  const responses=await Promise.race([
   Promise.all([api.getLocalUsagePage(query),api.getLocalUsageTrend({...query,period:'total'}),api.getLocalUsageHeatmap({weeks:53,tz:'UTC'})]),
   delay(1500).then(()=>{throw Error('Saved statistics waited for collection or pricing')})
  ]);
  assert.equal(responses[0].totals.total_tokens,100);
  assert.equal(responses[1].data.reduce((n,r)=>n+r.total_tokens,0),100);
  assert.ok(responses[2].weeks.flat().some(cell=>cell?.total_tokens===100));
  assert.ok(responses.every(response=>response.collectionState==='loading'));
  release();await collector.sync();
  for(let i=0;i<100;i++){const r=await api.getLocalUsagePage(query);if(r.collectionState==='ready'){assert.equal(r.totals.total_tokens,100);return;}await delay(5)}
  assert.fail('Background collection did not settle');
 }finally{release();delete globalThis.__snapshotCollector;pricing.resetPricingForTests();await delay(20);await fs.rm(root,{recursive:true,force:true})}
});

test('unchanged compaction preserves file identity; changed snapshots still replace older totals',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ar-compact-cache-'));
 try{
  const file=path.join(root,'queue.jsonl'),row={source:'claude',model:'fixture',hour_start:'2026-10-27T10:00:00Z',total_tokens:100};
  await fs.writeFile(file,JSON.stringify(row)+'\n');const before=await fs.stat(file,{bigint:true});
  await compactQueue(file);await compactQueue(file);const after=await fs.stat(file,{bigint:true});
  assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);
  await fs.appendFile(file,JSON.stringify({...row,total_tokens:200})+'\n');await compactQueue(file);
  assert.equal((await fs.readFile(file,'utf8')).trim().split('\n').length,1);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).total_tokens,200);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
