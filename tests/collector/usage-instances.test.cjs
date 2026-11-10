const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createCollector}=require('../../packages/core/src/vendor/tokentracker/collector.cjs');
const {preserveHistory}=require('../../packages/core/src/vendor/tokentracker/rebuild-instances.cjs');
const {queryOffline}=require('../../packages/core/src/vendor/tokentracker/lib/offline-api');
const {setInstanceName}=require('../../packages/core/src/vendor/tokentracker/usage-instances.cjs');
const base={from:'2026-10-27',to:'2026-10-27',tz:'UTC'};
const event=(id,n)=>JSON.stringify({type:'assistant',timestamp:'2026-10-27T10:00:00Z',requestId:id,message:{id,model:'claude-sonnet-4',usage:{input_tokens:n,output_tokens:20}}})+'\n';
test('instances split custom and default usage, preserve totals across repeats and deduplicate overlapping roots and copies',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ar-instances-')),dataDir=path.join(home,'.agentrouter/collector');
 const a=path.join(home,'.claude/projects/work'),b=path.join(home,'isolated/code/projects/work'),index=path.join(home,'.agentrouter/sessions/index.sqlite');
 fs.mkdirSync(a,{recursive:true});fs.mkdirSync(b,{recursive:true});fs.mkdirSync(path.dirname(index),{recursive:true});
 const db=new DatabaseSync(index);db.exec('CREATE TABLE custom_roots(agent TEXT,path TEXT,added_at INTEGER)');
 db.prepare('INSERT INTO custom_roots VALUES (?,?,0)').run('claude-code',path.dirname(path.dirname(b)));
 const alias=path.join(home,'alias');fs.symlinkSync(path.dirname(path.dirname(b)),alias,'dir');db.prepare('INSERT INTO custom_roots VALUES (?,?,1)').run('claude-code',alias);
 fs.writeFileSync(path.join(a,'one.jsonl'),event('one',100));fs.writeFileSync(path.join(b,'two.jsonl'),event('two',200));fs.writeFileSync(path.join(b,'copy.jsonl'),event('one',100));
 try{
  const collector=createCollector({home,fetchImpl:async()=>{throw Error('offline')}});await collector.sync(true);
  const instances=(await collector.query('/functions/tokentracker-usage-instances')).instances;assert.equal(instances.length,2);
  const totals=async instance=>(await queryOffline(path.join(dataDir,'queue.jsonl'),'/functions/tokentracker-usage-summary',{...base,source:'claude',...(instance?{instance}:{})})).totals;
  assert.equal((await totals()).total_tokens,340);
  const counts=await Promise.all(instances.map(i=>totals(i.id)));assert.deepEqual(counts.map(t=>t.total_tokens).sort((a,b)=>a-b),[120,220]);
  await collector.sync(true);assert.equal((await totals()).total_tokens,340);
  // A crash after queue replacement but before cursor commit retries without duplication.
  const cursorFile=path.join(dataDir,'cursors.json');
  const cursors=JSON.parse(fs.readFileSync(cursorFile,'utf8'));delete cursors.arInstanceSchema;
  fs.writeFileSync(cursorFile,JSON.stringify(cursors));
  await createCollector({home,fetchImpl:async()=>{throw Error('offline')}}).sync(true);
  assert.equal((await totals()).total_tokens,340);
  await setInstanceName(dataDir,'claude',path.dirname(path.dirname(b)),'Official fixture');
  assert.ok((await collector.query('/functions/tokentracker-usage-instances')).instances.some(i=>i.name==='Official fixture'));
  fs.appendFileSync(path.join(b,'two.jsonl'),event('three',300));await collector.sync(true);assert.equal((await totals()).total_tokens,660);
  const after=await Promise.all(instances.map(i=>totals(i.id)));assert.equal(after.reduce((s,t)=>s+t.total_tokens,0),660);
 }finally{db.close();fs.rmSync(home,{recursive:true,force:true})}
});
test('migration retains missing history without double-counting model reassignment',()=>{
 const row=(source,model,tokens,turns)=>({source,model,hour_start:'2026-10-27T10:00:00Z',total_tokens:tokens,conversation_count:turns});
 const result=preserveHistory([row('claude','a',100,4),row('claude','b',50,0)],[row('claude@ar-instance:one','a',100,0),row('claude@ar-instance:two','b',20,4)]);
 assert.equal(result.reduce((s,r)=>s+r.total_tokens,0),150);
 assert.equal(result.reduce((s,r)=>s+r.conversation_count,0),4);
 assert.equal(result.find(r=>r.source==='claude').total_tokens,30);
});
