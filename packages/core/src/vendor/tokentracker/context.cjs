const path=require('node:path');const{profileHomes}=require('./local-sources.cjs');const{getTimeZoneContext}=require('./lib/offline-api');
const inFlight=new Map();
function getCategoryBreakdown(options){const key=JSON.stringify(options);if(inFlight.has(key))return inFlight.get(key);const promise=compute(options).finally(()=>inFlight.delete(key));inFlight.set(key,promise);return promise;}
async function compute({home,from='',to,source,tz}){
 const roots=await profileHomes(home);const timeZoneContext=getTimeZoneContext(new URL('http://localhost/?'+new URLSearchParams({tz:tz||'UTC'})));let result;
 if(source==='claude')result=await require('./lib/claude-categorizer').computeClaudeCategoryBreakdown({from,to,rootDir:roots.claude.map(dir=>path.join(dir,'projects')),timeZone:tz||'UTC',cacheDir:path.join(home,'.agentrouter/collector/context-cache')});
 else if(source==='codex')result=await require('./lib/codex-context-breakdown').computeCodexContextBreakdown({from,to,top:50,timeZoneContext,codexDir:roots.codex.flatMap(dir=>[path.join(dir,'sessions'),path.join(dir,'archived_sessions')])});
 else if(source==='grok')result=await require('./lib/grok-context-breakdown').computeGrokContextBreakdown({from,to,top:50,timeZoneContext,env:{...process.env,TOKENTRACKER_GROK_HOME:path.join(home,'.grok')}});
 else throw new Error('Unsupported context source');
 return{from,to,...result};
}
module.exports={getCategoryBreakdown};
