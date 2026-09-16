const path=require('node:path');const fs=require('node:fs');const fsp=require('node:fs/promises');const rollout=require('./lib/rollout');const{resolveZcodeNativeDbPath}=require('./lib/install-resolver');
async function profileHomes(home){
 const codex=new Set([path.join(home,'.codex')]),claude=new Set([path.join(home,'.claude')]);const base=path.join(home,'.agentrouter/profiles');
 for(const entry of await fsp.readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e}))if(entry.isDirectory())for(const prefix of ['','custom']){codex.add(path.join(base,entry.name,prefix,'codex'));claude.add(path.join(base,entry.name,prefix,'claude'));}
 return{codex:[...codex],claude:[...claude]};
}
async function collectAdditionalSources({home,cursors,queuePath,projectQueuePath}){
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
 return results;
}
module.exports={profileHomes,collectAdditionalSources};
