'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {clientSource}=require('./usage-instances.cjs');
const tracked=s=>['claude','codex'].includes(clientSource(s));
const fields=['input_tokens','output_tokens','cached_input_tokens','cache_creation_input_tokens','reasoning_output_tokens','total_tokens','billable_total_tokens','conversation_count','total_cost_usd'];
async function rows(file){try{return (await fs.readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code==='ENOENT')return [];throw e}}
function latest(data){const m=new Map();for(const r of data)m.set(JSON.stringify([r.project_key||null,r.source,r.model,r.hour_start]),r);return [...m.values()]}
// Raw snapshots are repartitioned once, using the same parser and shared event
// identities. Missing original history remains explicitly unattributed.
function preserveHistory(old,fresh){
 const key=r=>JSON.stringify([r.project_key||null,clientSource(r.source),r.model,r.hour_start]);
 const sums=new Map();for(const r of fresh){const k=key(r),a=sums.get(k)||{};for(const f of fields)a[f]=(a[f]||0)+Number(r[f]||0);sums.set(k,a)}
 const historical=new Map();for(const r of old.filter(r=>tracked(r.source))){const k=key(r),a=historical.get(k)||{...r,source:clientSource(r.source),...Object.fromEntries(fields.map(f=>[f,0]))};for(const f of fields)a[f]+=Number(r[f]||0);historical.set(k,a)}
 const hourKey=r=>JSON.stringify([r.project_key||null,clientSource(r.source),r.hour_start]);
 const budgets=new Map();
 for(const [sign,records] of [[1,[...historical.values()]],[-1,fresh]])for(const r of records){const k=hourKey(r),a=budgets.get(k)||{};for(const f of fields)a[f]=(a[f]||0)+sign*Number(r[f]||0);budgets.set(k,a)}
 const residual=[];for(const[k,r]of historical){const a=sums.get(k)||{};for(const f of fields){const b=budgets.get(hourKey(r));r[f]=Math.min(Math.max(0,r[f]-(a[f]||0)),Math.max(0,b[f]||0));b[f]-=r[f];}if(fields.some(f=>r[f]>0))residual.push(r)}
 return [...old.filter(r=>!tracked(r.source)),...residual,...fresh];
}
async function rebuildInstances({dataDir,cursors,codexFiles,claudeFiles}) {
 if(cursors.arInstanceSchema===1)return;
 const stage=await fs.mkdtemp(path.join(dataDir,'.instance-rebuild-')),fresh={};
 try {
  const rollout=require('./lib/rollout');
  const queuePath=path.join(stage,'queue.jsonl'),projectQueuePath=path.join(stage,'project.queue.jsonl');
  await rollout.parseRolloutIncremental({rolloutFiles:codexFiles,cursors:fresh,queuePath,projectQueuePath,source:'codex'});
  await rollout.parseClaudeIncremental({projectFiles:claudeFiles,cursors:fresh,queuePath,projectQueuePath,source:'claude'});
  for(const name of ['queue.jsonl','project.queue.jsonl']){
   const combined=preserveHistory(latest(await rows(path.join(dataDir,name))),latest(await rows(path.join(stage,name))));
   await fs.writeFile(path.join(stage,'new-'+name),combined.map(r=>JSON.stringify(r)+'\n').join(''),{mode:0o600});
  }
  // Cursors commit last. An interrupted migration rebuilds and replaces the
  // same source buckets instead of appending a second copy.
  for(const name of ['queue.jsonl','project.queue.jsonl'])await fs.rename(path.join(stage,'new-'+name),path.join(dataDir,name));
  cursors.files={...cursors.files,...fresh.files};
  for(const name of ['hourly','projectHourly']) {
   const target=cursors[name]||={buckets:{}};
   target.version=fresh[name]?.version || 3;
   for(const key of Object.keys(target.buckets||{})){
    const source=name==='hourly'?key.split('|')[0]:key.split('|')[1];
    if(tracked(source))delete target.buckets[key];
   }
   Object.assign(target.buckets,fresh[name]?.buckets||{});
   if(name==='projectHourly')target.projects={...target.projects,...fresh[name]?.projects};
  }
  for(const name of ['codexHashes','codexCompactionResponseIds','claudeHashes','claudeForkAliases'])if(fresh[name])cursors[name]=fresh[name];
  cursors.arInstanceSchema=1;
 }finally{await fs.rm(stage,{recursive:true,force:true})}
}
module.exports={rebuildInstances,preserveHistory};
