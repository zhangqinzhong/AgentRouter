const {collectAdditionalSources}=require('./local-sources.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const rollout = require('./lib/rollout');
const { queryOffline } = require('./lib/offline-api');
const { getUsageLimits, resetUsageLimitsCache } = require('./lib/usage-limits');
const subscriptions = require('./lib/subscription-manager');
const {ensurePricingLoaded}=require('./lib/pricing');

// Parsing runs in a worker. Source files are read-only; only aggregate queues and
// incremental cursors are stored here. No CLI initialization, hooks or upload.
function createCollector({ home = os.homedir(), dataDir = path.join(home, '.agentrouter', 'collector'), fetchImpl = fetch } = {}) {
  const queuePath = path.join(dataDir, 'queue.jsonl');
  const projectQueuePath = path.join(dataDir, 'project.queue.jsonl');
  const cursorsPath = path.join(dataDir, 'cursors.json');
  let inFlight, lastSync = 0, pricingReady;
  function pricing() {
    if (!pricingReady) pricingReady=(async()=>{
      await fs.mkdir(dataDir,{recursive:true,mode:0o700});
      const cachePath=path.join(dataDir,'pricing.json');
      try{await fs.copyFile(path.join(home,'.tokentracker/cache/pricing.json'),cachePath,require('node:fs').constants.COPYFILE_EXCL);}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
      await ensurePricingLoaded({cachePath,fetchImpl:async({url,timeoutMs})=>{
        const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs)});
        if(!response.ok)throw new Error('Pricing unavailable');return response.json();
      }});
    })();
    return pricingReady;
  }
  async function sync(force = false) {
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastSync < 60000) return;
    inFlight = (async () => {
      await fs.mkdir(dataDir, {recursive:true,mode:0o700});
      let cursors;
      try { cursors=JSON.parse(await fs.readFile(cursorsPath,'utf8')); }
      catch (e) { if(e.code !== 'ENOENT') throw e; cursors={}; }
      const codexHomes = new Set([path.join(home,'.codex')]);
      const claudeHomes = new Set([path.join(home,'.claude')]);
      const profileRoot = path.join(home,'.agentrouter','profiles');
      const entries = await fs.readdir(profileRoot,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e});
      for (const entry of entries.filter(e=>e.isDirectory())) {
        for (const prefix of ['', 'custom']) {
          codexHomes.add(path.join(profileRoot,entry.name,prefix,'codex'));
          claudeHomes.add(path.join(profileRoot,entry.name,prefix,'claude'));
        }
      }
      const codexFiles = [...new Set((await Promise.all([...codexHomes].flatMap(dir=>[
        rollout.listRolloutFiles(path.join(dir,'sessions')),
        rollout.listRolloutFilesDeep(path.join(dir,'archived_sessions')),
      ]))).flat())].sort();
      const claudeFiles = [...new Set((await Promise.all([...claudeHomes].map(dir=>rollout.listClaudeProjectFiles(path.join(dir,'projects'))))).flat())].sort();
      await require('./rebuild-codex.cjs').rebuildCodex({dataDir,cursors,files:codexFiles});
      await rollout.parseRolloutIncremental({rolloutFiles:codexFiles,cursors,queuePath,projectQueuePath,source:'codex'});
      await rollout.parseClaudeIncremental({projectFiles:claudeFiles,cursors,queuePath,projectQueuePath,source:'claude'});
      const additional=await collectAdditionalSources({home,cursors,queuePath,projectQueuePath});
      // Complete queue snapshots are appended by upstream parsers. Compact latest
      // snapshots after each successful scan so this store cannot grow per poll.
      for (const file of [queuePath,projectQueuePath]) await compactQueue(file);
      const temp=cursorsPath+'.tmp';
      await fs.writeFile(temp,JSON.stringify(cursors),{mode:0o600});
      await fs.rename(temp,cursorsPath);
      lastSync=Date.now();
      return {codexFiles:codexFiles.length,claudeFiles:claudeFiles.length,additional};
    })().finally(()=>{inFlight=undefined});
    return inFlight;
  }
  async function query(endpoint, query = {}) {
    if(endpoint.endsWith('usage-category-breakdown')) {
      const {getCategoryBreakdown}=require('./context.cjs');
      return getCategoryBreakdown({home,...query});
    }
    if(endpoint.endsWith('usage-limits')) {
      if(query.refresh==='1') resetUsageLimitsCache();
      // Never rotate a refresh token concurrently with the user's active CLI.
      // The CLI owns login renewal; this observer reads its current credentials.
      return getUsageLimits({home,env:{...process.env,CODEX_HOME:path.join(home,'.codex')},fetchImpl,allowCodexTokenRefresh:false,forceRefresh:query.refresh==='1',devinEnabled:query.devin==='1'});
    }
    if(endpoint.endsWith('subscription-manager')) {
      const own=await subscriptions.listSubscriptions({trackerDir:dataDir});
      const originalFile=path.join(home,'.tokentracker','tracker','subscription-manager.json');
      // Read existing manual subscription records without repairing/writing the source.
      let inherited=[];
      try { const raw=JSON.parse(await fs.readFile(originalFile,'utf8')); inherited=Array.isArray(raw.items)?raw.items:[]; } catch(e) { if(e.code!=='ENOENT' && !(e instanceof SyntaxError))throw e; }
      return {subscriptions:[...new Map([...inherited,...own].map(row=>[row.id,row])).values()]};
    }
    if(endpoint.endsWith('local-sync')) { await sync(query.auto!=='true'); if(query.auto!=='true')resetUsageLimitsCache();return {ok:true,code:0}; }
    await Promise.all([sync(),pricing()]);
    return queryOffline(queuePath,endpoint,query);
  }
  return {sync,query};
}
async function compactQueue(file) {
  let raw;try{raw=await fs.readFile(file,'utf8')}catch(e){if(e.code==='ENOENT')return;throw e}
  const latest=new Map();
  for(const line of raw.split('\n')) {if(!line.trim())continue;const row=JSON.parse(line);const key=JSON.stringify([row.project_key??null,row.source,row.model,row.hour_start]);latest.set(key,row);}
  const temp=file+'.compact';await fs.writeFile(temp,[...latest.values()].map(row=>JSON.stringify(row)+'\n').join(''),{mode:0o600});await fs.rename(temp,file);
}
module.exports={createCollector,compactQueue};
