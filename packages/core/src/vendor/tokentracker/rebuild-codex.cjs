'use strict';
const fs=require('node:fs/promises'),path=require('node:path');const rollout=require('./lib/rollout');
const MODEL_SCHEMA=3;
async function readRows(file){try{return(await fs.readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}}
function latest(rows){const m=new Map();for(const r of rows)m.set(JSON.stringify([r.project_key||null,r.source,r.model,r.hour_start]),r);return [...m.values()]}
async function rebuildCodex({dataDir,cursors,files}){
 if(cursors.arModelSchema===MODEL_SCHEMA)return false;
 if(!Object.keys(cursors.files||{}).length){cursors.arModelSchema=MODEL_SCHEMA;return false}
 const stage=await fs.mkdtemp(path.join(dataDir,'.model-rebuild-'));const fresh={};
 try{
  await rollout.parseRolloutIncremental({rolloutFiles:files,cursors:fresh,queuePath:path.join(stage,'queue.jsonl'),projectQueuePath:path.join(stage,'project.queue.jsonl'),source:'codex'});
  const old=latest(await readRows(path.join(dataDir,'queue.jsonl'))),replacement=latest(await readRows(path.join(stage,'queue.jsonl')));
  const hours=rows=>{const m=new Map();for(const r of rows)if(r.source==='codex')m.set(r.hour_start,(m.get(r.hour_start)||0)+Number(r.total_tokens||0));return m};
  const nextHours=hours(replacement);
  // Never silently drop previously collected history whose original files vanished.
  for(const[hour,tokens]of hours(old))if((nextHours.get(hour)||0)<tokens)throw Error(`Codex model rebuild would lose usage at ${hour}; original history must be recovered first`);
  for(const filename of ['queue.jsonl','project.queue.jsonl']){
   const rows=filename==='queue.jsonl'?old:latest(await readRows(path.join(dataDir,filename)));
   const freshRows=filename==='queue.jsonl'?replacement:latest(await readRows(path.join(stage,filename)));
   await fs.writeFile(path.join(stage,'new-'+filename),[...rows.filter(r=>r.source!=='codex'),...freshRows].map(r=>JSON.stringify(r)+'\n').join(''),{mode:0o600});
  }
  // Commit cursors last (the coordinator persists them). A restart before that
  // reruns this replacement, rather than adding a second set of buckets.
  for(const filename of ['queue.jsonl','project.queue.jsonl'])await fs.rename(path.join(stage,'new-'+filename),path.join(dataDir,filename));
  for(const file of Object.keys(cursors.files||{}))if(file.includes('/codex/')||file.includes('/.codex/')||files.includes(file))delete cursors.files[file];
  Object.assign(cursors.files,fresh.files);cursors.codexHashes=fresh.codexHashes;
  for(const name of ['hourly','projectHourly']){
   const target=cursors[name]||={buckets:{}};for(const[k,v]of Object.entries(target.buckets||{}))if(k.startsWith('codex|')||v.source==='codex'||(name==='projectHourly'&&k.includes('|codex|')))delete target.buckets[k];
   Object.assign(target.buckets,fresh[name]?.buckets||{});
   if(name==='projectHourly')target.projects={...target.projects,...fresh[name]?.projects};
  }
  cursors.arModelSchema=MODEL_SCHEMA;return true;
 }finally{await fs.rm(stage,{recursive:true,force:true})}
}
module.exports={rebuildCodex,MODEL_SCHEMA};
