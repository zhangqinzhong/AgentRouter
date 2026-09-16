'use strict';
const fs=require('node:fs');const readline=require('node:readline');
const cache=new Map();
function concrete(value){return typeof value==='string'&&value.trim()&&!['unknown','auto','default'].includes(value.trim().toLowerCase())?value.trim():null;}
function eventModels(obj){
 const p=obj?.payload||obj?.params||obj;
 const containers=[obj,p,p?.thread_settings,p?.turn_context,p?.session_meta,p?.settings,p?.thread_settings?.collaboration_mode?.settings];
 return [...new Set(containers.flatMap(v=>[concrete(v?.model),concrete(v?.model_id)]).filter(Boolean))];
}
function turnId(obj){const p=obj?.payload||obj?.params||obj;return p?.turn_id||p?.turnId||null;}
async function scanCodexModelEvidence(paths){
 const models=new Set(),turns=new Map();
 for(const file of Array.isArray(paths)?paths:[paths]){
  const st=await fs.promises.stat(file);const key=`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;let entry=cache.get(file);
  if(entry?.key!==key){
   const fileModels=new Set(),fileTurns=new Map();let task=null;
   const input=fs.createReadStream(file,{encoding:'utf8'});const lines=readline.createInterface({input,crlfDelay:Infinity});
   try{for await(const line of lines){
    if(!/"(?:model|model_id|task_started|task_complete|turn_context)"/.test(line))continue;
    let obj;try{obj=JSON.parse(line)}catch{continue}
    const p=obj?.payload||{},type=p.type||obj.type;
    if(type==='task_started')task=turnId(obj);
    const found=eventModels(obj);const id=turnId(obj)||task;
    for(const model of found){fileModels.add(model);if(id){if(!fileTurns.has(id))fileTurns.set(id,new Set());fileTurns.get(id).add(model)}}
    if(type==='task_complete')task=null;
   }}finally{lines.close();input.destroy()}
   entry={key,models:fileModels,turns:fileTurns};cache.delete(file);cache.set(file,entry);while(cache.size>1024)cache.delete(cache.keys().next().value);
  }
  for(const m of entry.models)models.add(m);for(const[id,values]of entry.turns){if(!turns.has(id))turns.set(id,new Set());for(const m of values)turns.get(id).add(m)}
 }
 return{models,turns};
}
function modelForUsage(state,obj,evidence){
 const id=turnId(obj)||state.turnId;const candidates=id&&evidence.turns.get(id);
 // A turn-specific model beats a UI selection made while that turn streams.
 if(!state.rerouted&&candidates?.size===1)return [...candidates][0];
 const current=concrete(state.effectiveModel)||concrete(state.selectedModel);if(current)return current;
 if(candidates?.size>1)return null;
 return evidence.models.size===1?[...evidence.models][0]:null;
}
module.exports={scanCodexModelEvidence,modelForUsage,eventModels};
