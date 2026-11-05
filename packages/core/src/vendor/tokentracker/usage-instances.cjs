'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const marker = '@ar-instance:';
function clientSource(source) { return String(source || '').split(marker)[0]; }
function instanceId(source, root) { return createHash('sha256').update(source + '\0' + path.resolve(root)).digest('hex').slice(0,24); }
function decodeSource(source) {
 const [client,instance] = String(source || '').split(marker);
 return {source:client,...(instance ? {instance} : {})};
}
async function canonical(root) { return fs.realpath(root).catch(()=>path.resolve(root)); }
function ownerRoot(source, root) {
 return source === 'claude' && path.basename(root) === 'projects' || source === 'codex' && ['sessions','archived_sessions'].includes(path.basename(root)) ? path.dirname(root) : root;
}
async function readNames(dataDir) {
 try { return JSON.parse(await fs.readFile(path.join(dataDir,'instance-names.json'),'utf8')); }
 catch(e) { if(e.code==='ENOENT')return {};throw e; }
}
async function setInstanceName(dataDir, source, root, name) {
 if(!['claude','codex'].includes(source)||typeof name!=='string'||name.length>100)throw Error('Invalid instance name');
 const names=await readNames(dataDir);const id=instanceId(source,await canonical(ownerRoot(source,root)));
 if(name.trim())names[id]=name.trim();else delete names[id];
 await fs.mkdir(dataDir,{recursive:true});const file=path.join(dataDir,'instance-names.json');
 await fs.writeFile(file+'.tmp',JSON.stringify(names),{mode:0o600});await fs.rename(file+'.tmp',file);
}
async function collectionInstances({home,dataDir,roots}) {
 const configDir=roots.configDir || path.join(home,'.agentrouter');
 const names=await readNames(dataDir),items=new Map();
 try {for(const item of JSON.parse(await fs.readFile(path.join(dataDir,'instances.json'),'utf8')))items.set(item.id,{...item,name:names[item.id]||item.name});}catch(e){if(e.code!=='ENOENT')throw e;}
 let profiles=[];
 try {
  const {readSqliteJsonRowsAsync}=require('./lib/sqlite-reader');
  const rows=await readSqliteJsonRowsAsync(path.join(configDir,'config.sqlite'),"SELECT value_json FROM app_config WHERE key='default'",{readOnly:true});
  profiles=JSON.parse(rows[0]?.value_json || '{}').profile?.profiles || [];
 }catch {/* Profile names are optional; root identity is not. */}
 for(const [source,locations] of [['claude',roots.claudeProjects],['codex',roots.codexStores]]) {
  for(const location of locations) {
   if(!(await fs.stat(location).catch(()=>null))?.isDirectory())continue;
   const scan=await canonical(location),root=await canonical(ownerRoot(source,scan));const id=instanceId(source,root);
   const relative=path.relative(path.join(configDir,'profiles'),root);
   const profileId=relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?relative.split(path.sep)[0]:null;
   const isDefault=root===await canonical(path.join(home,source==='claude'?'.claude':'.codex'));
   const fallback=isDefault?(source==='claude'?'Default Claude Code':'Default Codex'):profileId?(profiles.find(p=>p.id===profileId)?.name||profileId):path.basename(root)==='code'?path.basename(path.dirname(root)):path.basename(root);
   if(!items.has(id))items.set(id,{id,source,name:names[id]||fallback,root,paths:[]});
   const item=items.get(id);item.name=names[id]||fallback;if(!item.paths.includes(scan))item.paths.push(scan);
  }
 }
 return [...items.values()];
}
async function attributeFiles(files,source,instances) {
 const unique=new Map();
 for(const file of files) {
  const resolved=await canonical(file);
  if(unique.has(resolved))continue;
  const matches=instances.filter(i=>i.source===source&&i.paths.some(root=>resolved===root||resolved.startsWith(root+path.sep)));
  matches.sort((a,b)=>b.root.length-a.root.length);
  unique.set(resolved,{path:resolved,source:matches[0]?source+marker+matches[0].id:source});
 }
 return [...unique.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
module.exports={clientSource,decodeSource,instanceId,collectionInstances,attributeFiles,setInstanceName,readNames,ownerRoot};
