const path=require('node:path');const fs=require('node:fs');const fsp=require('node:fs/promises');const rollout=require('./lib/rollout');const cursor=require('./lib/cursor-config');const{resolveZcodeNativeDbPath}=require('./lib/install-resolver');
async function profileHomes(home){
 const codex=new Set([path.join(home,'.codex')]),claude=new Set([path.join(home,'.claude')]);const base=path.join(home,'.agentrouter/profiles');
 for(const entry of await fsp.readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e}))if(entry.isDirectory())for(const prefix of ['','custom']){codex.add(path.join(base,entry.name,prefix,'codex'));claude.add(path.join(base,entry.name,prefix,'claude'));}
 return{codex:[...codex],claude:[...claude]};
}
const present=(value)=>Boolean(value&&fs.existsSync(value));
const presentFiles=(values)=>values.filter((value)=>present(value));
const nativeFiles=async(resolve,env)=>{try{return(await resolve(env)).filter((value)=>present(value));}catch{return[];}};
async function runOptional(results,source,task){
 try{results[source]=await task();}catch(error){
  results[source]={error:error instanceof Error?error.message:String(error)};
  if(!process.env.NODE_TEST_CONTEXT)console.warn(`[Local ${source} collection failed]`,error?.message||error);
 }
}
function simpleProgress(){}
async function parseRolloutSources({home,cursors,queuePath,projectQueuePath,source,roots}){
 const files=[];
 for(const root of roots||[]){
  if(!present(root))continue;
  for(const dir of [path.join(root,'sessions'),path.join(root,'archived_sessions')]){
   if(!present(dir))continue;
   const listed=dir.endsWith('archived_sessions')?await rollout.listRolloutFilesDeep(dir):await rollout.listRolloutFiles(dir);
   for(const filePath of listed)files.push({path:filePath,source});
  }
 }
 if(files.length===0)return{filesProcessed:0,eventsAggregated:0,bucketsQueued:0};
 return rollout.parseRolloutIncremental({rolloutFiles:files,cursors,queuePath,projectQueuePath,source,onProgress:simpleProgress});
}
async function parseOpenCodeDatabase({dbPaths,readFn,source,cursorKey,cursors,queuePath,projectQueuePath}){
 let result={messagesProcessed:0,eventsAggregated:0,bucketsQueued:0};
 for(const dbPath of dbPaths||[]){
  if(!present(dbPath))continue;
  const dbMessages=readFn(dbPath);
  if(dbMessages.length===0)continue;
  const parsed=await rollout.parseOpencodeDbIncremental({dbMessages,dbPath,source,cursorKey,cursors,queuePath,projectQueuePath});
  result={messagesProcessed:result.messagesProcessed+(parsed.messagesProcessed||0),eventsAggregated:result.eventsAggregated+(parsed.eventsAggregated||0),bucketsQueued:result.bucketsQueued+(parsed.bucketsQueued||0)};
 }
 return result;
}
async function parseQoderSource({home,env,cursors,queuePath,projectQueuePath,source,dbResolver,projectsResolver,projectsCursor}){
 const dbPaths=Object.values(dbResolver({home,env,platform:process.platform})||{}).filter(Boolean);
 const result=await parseOpenCodeDatabase({dbPaths,readFn:(dbPath)=>rollout.readQoderDbMessages(dbPath),source,cursorKey:source,cursors,queuePath,projectQueuePath});
 const projectsDir=projectsResolver({home,env});
 const sessionFiles=projectsDir?await rollout.listQoderNewSessionFiles(projectsDir):[];
 if(sessionFiles.length>0){
  const parsed=await rollout.parseQoderNewIncremental({sessionFiles,cursors,queuePath,projectQueuePath,sourceKey:source,cursorKey:projectsCursor,onProgress:simpleProgress});
  result.messagesProcessed+=(parsed.messagesProcessed||0);result.eventsAggregated+=(parsed.eventsAggregated||0);result.bucketsQueued+=(parsed.bucketsQueued||0);
 }
 return result;
}
async function collectAdditionalSources({home,cursors,queuePath,projectQueuePath,fetchImpl=fetch}){
 const native=home===require('node:os').homedir();
 const env={...(native?process.env:{}),HOME:home,USERPROFILE:home};
 env.TOKENTRACKER_GROK_HOME=env.TOKENTRACKER_GROK_HOME||env.GROK_HOME||path.join(home,'.grok');
 env.LM_STUDIO_HOME=env.LM_STUDIO_HOME||path.join(home,'.lmstudio');
 env.OPENCLAW_STATE_DIR=env.OPENCLAW_STATE_DIR||path.join(home,'.openclaw');
 const common={cursors,queuePath,projectQueuePath,env};const results={};
 async function run(source,task){try{results[source]=await task()}catch(error){throw new Error(`Local ${source} collection failed: ${error.message}`,{cause:error})}}
 await run('openclaw',async()=>rollout.parseOpenclawIncremental({...common,sessionFiles:await rollout.resolveOpenclawSessionFiles(env),source:'openclaw'}));
 await run('grok',async()=>rollout.parseGrokBuildIncremental({...common,sessions:rollout.resolveGrokBuildSessions(env)}));
 await run('lmstudio',async()=>rollout.parseLmstudioIncremental({...common,logFiles:await rollout.resolveLmstudioLogFiles(env)}));
 await run('gemini',async()=>rollout.parseGeminiIncremental({...common,sessionFiles:await rollout.listGeminiSessionFiles(path.join(env.GEMINI_HOME||path.join(home,'.gemini'),'tmp')),source:'gemini'}));
 const data=home===require('node:os').homedir()?(process.env.XDG_DATA_HOME||path.join(home,'.local/share')):path.join(home,'.local/share');
 const databases=[['opencode',path.join(data,'opencode/opencode.db'),'readOpencodeDbMessages','opencode'],['mimo',path.join(env.MIMO_HOME||path.join(data,'mimocode'),'mimocode.db'),'readMimoDbMessages','mimo'],['zcode',resolveZcodeNativeDbPath({home,env:{...env,ZCODE_HOME:env.ZCODE_HOME||path.join(home,'.zcode')}}),'readZcodeDbMessages','zcode'],['kilo-cli',path.join(env.KILO_HOME||path.join(data,'kilo'),'kilo.db'),'readOpencodeDbMessages','kiloCli']];
 for(const[source,dbPath,reader,cursorKey]of databases)if(dbPath&&fs.existsSync(dbPath))await run(source,()=>rollout.parseOpencodeDbIncremental({...common,dbMessages:rollout[reader](dbPath),dbPath,source,cursorKey}));
 // Older OpenCode versions used individual message files instead of SQLite.
 if(!fs.existsSync(databases[0][1]))await run('opencode',async()=>rollout.parseOpencodeIncremental({...common,messageFiles:await rollout.listOpencodeMessageFiles(path.join(data,'opencode/storage')),source:'opencode'}));
 await runOptional(results,'cursor',async()=>{
  if(!cursor.isCursorInstalled({home,env}))return{};
  const auth=cursor.extractCursorSessionToken({home,env});
  if(!auth?.cookie)return{};
  const csv=await cursor.fetchCursorUsageCsv({cookie:auth.cookie,fetchImpl});
  const records=cursor.parseCursorCsv(csv);
  return records.length?rollout.parseCursorApiIncremental({records,cursors,queuePath,onProgress:simpleProgress,source:'cursor'}):{};
 });

 // These sources already have passive, local-only parsers in the vendored
 // TokenTracker code. Keep them behind per-source error isolation so one
 // optional client cannot prevent the core Claude/Codex sync from completing.
 await runOptional(results,'acode',()=>parseRolloutSources({home,cursors,queuePath,projectQueuePath,source:'acode',roots:[env.TOKENTRACKER_ACODE_HOME||path.join(home,'.acode')]}));
 await runOptional(results,'every-code',()=>parseRolloutSources({home,cursors,queuePath,projectQueuePath,source:'every-code',roots:[env.CODE_HOME||path.join(home,'.code')]}));
 if(typeof rollout.resolveQoderDbPaths==='function')await runOptional(results,'qoder',()=>parseQoderSource({home,env,cursors,queuePath,projectQueuePath,source:'qoder',dbResolver:rollout.resolveQoderDbPaths,projectsResolver:rollout.resolveQoderProjectsDir,projectsCursor:'qoderNew'}));
 if(typeof rollout.resolveQoderCnDbPaths==='function')await runOptional(results,'qoder-cn',()=>parseQoderSource({home,env,cursors,queuePath,projectQueuePath,source:'qoder-cn',dbResolver:rollout.resolveQoderCnDbPaths,projectsResolver:rollout.resolveQoderCnProjectsDir,projectsCursor:'qoderCnNew'}));
 await runOptional(results,'claude-science',async()=>{
  const total={recordsProcessed:0,eventsAggregated:0,bucketsQueued:0};
  const paths=rollout.resolveClaudeScienceDbPaths({home,env})||[];
  for(const dbPath of paths)if(present(dbPath)){const parsed=await rollout.parseClaudeScienceIncremental({dbRows:await rollout.readClaudeScienceFrames(dbPath),cursors,queuePath,onProgress:simpleProgress});total.recordsProcessed+=parsed.recordsProcessed||0;total.eventsAggregated+=parsed.eventsAggregated||0;total.bucketsQueued+=parsed.bucketsQueued||0;}
  return total;
 });
 await runOptional(results,'antigravity',async()=>{
  const files=await rollout.listAntigravityTranscripts(path.join(home,'.gemini'));
  return files.length?rollout.parseAntigravityIncremental({sessionFiles:files,cursors,queuePath,projectQueuePath,onProgress:simpleProgress,source:'antigravity'}):{};
 });
 await runOptional(results,'kiro',async()=>{
  const base=rollout.resolveKiroBasePath(env);if(!base)return{};
  const dbPath=rollout.resolveKiroDbPath(base),jsonlPath=rollout.resolveKiroJsonlPath(base);
  return present(dbPath)||present(jsonlPath)?rollout.parseKiroIncremental({basePath:base,dbPath,jsonlPath,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'kiro-cli',async()=>{
  const sessionFiles=rollout.resolveKiroCliSessionFiles(env),dbPath=rollout.resolveKiroCliDbPath(env);
  return present(dbPath)||sessionFiles.length?rollout.parseKiroCliIncremental({sessionFiles,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'hermes',async()=>{
  const hermesPath=rollout.resolveHermesPath(env);return present(hermesPath)?rollout.parseHermesIncremental({hermesPath,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'kimi',async()=>{
  const files=await nativeFiles(rollout.resolveKimiWireFiles,env);return files.length?rollout.parseKimiIncremental({wireFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'kimi-code',async()=>{
  const files=await nativeFiles(rollout.resolveKimiCodeWireFiles,env);return files.length?rollout.parseKimiCodeIncremental({wireFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'codebuddy',async()=>{
  const files=await nativeFiles(rollout.resolveCodebuddyProjectFiles,env);return files.length?rollout.parseCodebuddyIncremental({projectFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'workbuddy',async()=>{
  const files=await nativeFiles(rollout.resolveWorkbuddyProjectFiles,env);return files.length?rollout.parseWorkbuddyIncremental({projectFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'omp',async()=>{
  const files=await nativeFiles(rollout.resolveOmpSessionFiles,env),subagents=await nativeFiles(rollout.resolveOmpSubagentFiles,env);return files.length||subagents.length?rollout.parseOmpIncremental({sessionFiles:files,subagentFiles:subagents,cursors,queuePath,projectQueuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'pi',async()=>{
  const files=await nativeFiles(rollout.resolvePiSessionFiles,env);return files.length?rollout.parsePiIncremental({sessionFiles:files,cursors,queuePath,projectQueuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'prime-agent',async()=>{
  const files=await nativeFiles(rollout.resolvePrimeAgentSessionFiles,env);return files.length?rollout.parsePrimeAgentIncremental({sessionFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'craft',async()=>{
  const files=await nativeFiles(rollout.resolveCraftSessionFiles,env);return files.length?rollout.parseCraftIncremental({sessionFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'reasonix',async()=>{
  const files=await nativeFiles(rollout.resolveReasonixTelemetryFiles,env);return files.length?rollout.parseReasonixIncremental({telemetryFiles:files,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'kilocode',async()=>{
  const files=await nativeFiles(rollout.resolveKilocodeTaskFiles,env);return files.length?rollout.parseKilocodeIncremental({taskFiles:files,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'roocode',async()=>{
  const files=await nativeFiles(rollout.resolveRoocodeTaskFiles,env);return files.length?rollout.parseRoocodeIncremental({taskFiles:files,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'zed',async()=>{
  const dbPath=rollout.resolveZedDbPath(env);return present(dbPath)?rollout.parseZedIncremental({dbPath,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'unsloth',async()=>{
  const dbPath=rollout.resolveUnslothDbPath(env);return present(dbPath)?rollout.parseUnslothIncremental({dbPath,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'anythingllm',async()=>{
  const dbPath=rollout.resolveAnythingllmDbPath(env);return present(dbPath)?rollout.parseAnythingllmIncremental({dbPath,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'devin',async()=>{
  const dbPath=rollout.resolveDevinDbPath(env);return present(dbPath)?rollout.parseDevinIncremental({dbPath,cursors,queuePath,projectQueuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'goose',async()=>{
  const dbPath=rollout.resolveGooseDbPath(env);return present(dbPath)?rollout.parseGooseIncremental({dbPath,cursors,queuePath,onProgress:simpleProgress,env}):{};
 });
 await runOptional(results,'droid',async()=>{
  const files=await nativeFiles(rollout.listDroidSettingsFiles,env);return files.length?rollout.parseDroidIncremental({settingsFiles:files,cursors,queuePath,projectQueuePath,onProgress:simpleProgress,env,prune:true}):{};
 });
 await runOptional(results,'dsh',async()=>{
  const files=await nativeFiles(rollout.resolveDshSessionFiles,env);return files.length?rollout.parseDshIncremental({sessionFiles:files,cursors,queuePath,onProgress:simpleProgress}):{};
 });
 await runOptional(results,'copilot',async()=>{
  const otel=await nativeFiles(rollout.resolveCopilotOtelPaths,env);
  const store=await nativeFiles(rollout.resolveCopilotSessionStorePaths,env);
  const app=await nativeFiles(rollout.resolveCopilotAppDbPaths,env);
  let total={};
  if(otel.length)total=await rollout.parseCopilotIncremental({otelPaths:otel,cursors,queuePath,onProgress:simpleProgress,env});
  if(store.length){const parsed=await rollout.parseCopilotSessionStoreIncremental({dbPaths:store,cursors,queuePath,onProgress:simpleProgress,env});total=parsed;}
  if(app.length){const parsed=await rollout.parseCopilotAppDbIncremental({dbPaths:app,cursors,queuePath,onProgress:simpleProgress,env});total=parsed;}
  return total;
 });
 return results;
}
module.exports={profileHomes,collectAdditionalSources};
