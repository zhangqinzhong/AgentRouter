const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {createCollector}=require('../../packages/core/src/vendor/tokentracker/collector.cjs');
test('Codex cumulative counters and cache tokens are counted once across personal and managed homes',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-codex-test-'));
 try{
  const personal=path.join(home,'.codex/sessions/2026/09/14');const managed=path.join(home,'.agentrouter/profiles/company/codex/sessions/2026/09/14');await fs.mkdir(personal,{recursive:true});await fs.mkdir(managed,{recursive:true});
  const usage={input_tokens:100,cached_input_tokens:60,output_tokens:20,reasoning_output_tokens:5,total_tokens:120};
  const meta={type:'session_meta',payload:{id:'session-shared',model:'gpt-5'}};
  const event={type:'event_msg',timestamp:'2026-09-14T01:00:00Z',payload:{type:'token_count',info:{last_token_usage:usage,total_token_usage:usage}}};
  const data=[meta,event].map(JSON.stringify).join('\n')+'\n';const filename='rollout-2026-09-14T01-00-00-00000000-0000-0000-0000-000000000001.jsonl';await fs.writeFile(path.join(personal,filename),data);await fs.writeFile(path.join(managed,filename),data);
  const collector=createCollector({home,fetchImpl:async()=>{throw Error('offline')}});await collector.sync(true);const query={from:'2026-09-14',to:'2026-09-14'};const first=await collector.query('/functions/tokentracker-usage-summary',query);
  assert.equal(first.totals.total_tokens,120);assert.equal(first.totals.cached_input_tokens,60);
  const cumulative=Object.fromEntries(Object.entries(usage).map(([k,v])=>[k,v*2]));const next={...event,timestamp:'2026-09-14T01:01:00Z',payload:{type:'token_count',info:{last_token_usage:usage,total_token_usage:cumulative}}};await fs.appendFile(path.join(personal,filename),JSON.stringify(next)+'\n');await collector.sync(true);const second=await collector.query('/functions/tokentracker-usage-summary',query);assert.equal(second.totals.total_tokens,240);
  await collector.sync(true);assert.deepEqual((await collector.query('/functions/tokentracker-usage-summary',query)).totals,second.totals);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
