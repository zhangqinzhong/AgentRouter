const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const{createCollector}=require('../../packages/core/src/vendor/tokentracker/collector.cjs');
const{getCategoryBreakdown}=require('../../packages/core/src/vendor/tokentracker/context.cjs');
test('Grok passive discovery is read-only and repeat scans/restarts do not duplicate buckets',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-grok-discovery-'));try{
 const dir=path.join(home,'.grok/sessions/project/session-1');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'signals.json');const text=JSON.stringify({contextTokensUsed:100,assistantMessageCount:2,primaryModelId:'grok-build',lastActiveAt:'2026-09-15T14:10:00Z'});await fs.writeFile(file,text);
 const c=createCollector({home,fetchImpl:async()=>{throw Error('offline')}});await c.sync(true);const q={from:'2026-09-15',to:'2026-09-15',tz:'UTC'};const first=await c.query('/functions/tokentracker-usage-model-breakdown',q);assert.equal(first.sources[0].source,'grok');assert(Number(first.sources[0].totals.total_tokens)>0);
 for(let i=0;i<3;i++){await c.sync(true);assert.deepEqual(await c.query('/functions/tokentracker-usage-model-breakdown',q),first)}
 const restarted=createCollector({home,fetchImpl:async()=>{throw Error('offline')}});await restarted.sync(true);assert.deepEqual(await restarted.query('/functions/tokentracker-usage-model-breakdown',q),first);assert.equal(await fs.readFile(file,'utf8'),text);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
test('Claude detail includes managed profiles, deduplicates mirrors and respects local midnight',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-context-roots-'));try{
 const personal=path.join(home,'.claude/projects/p'),managed=path.join(home,'.agentrouter/profiles/company/custom/claude/projects/p');await fs.mkdir(personal,{recursive:true});await fs.mkdir(managed,{recursive:true});
 const row=(id,ts)=>({type:'assistant',timestamp:ts,requestId:id,message:{id,model:'claude-sonnet-4',content:[{type:'text',text:'test'}],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:20}}});
 const inside=row('same-message','2026-09-14T16:30:00Z'),outside=row('outside','2026-09-14T15:30:00Z');await fs.writeFile(path.join(personal,'personal.jsonl'),[inside,outside].map(JSON.stringify).join('\n')+'\n');await fs.writeFile(path.join(managed,'managed.jsonl'),JSON.stringify(inside)+'\n');
 const result=await getCategoryBreakdown({home,source:'claude',from:'2026-09-15',to:'2026-09-15',tz:'Asia/Shanghai'});assert.equal(result.message_count,1);assert.equal(result.totals.total_tokens,35);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
