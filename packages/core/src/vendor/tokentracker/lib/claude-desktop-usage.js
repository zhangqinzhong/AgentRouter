'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {collectionRoots} = require('../collection-roots.cjs');
// Read the desktop's own snapshots only. Never extract credentials or make requests.
async function readClaudeDesktopUsage({home, nowMs = Date.now(), roots} = {}) {
  const locations = roots || (await collectionRoots({home})).claudeProjects;
  let newest = null;
  for (const projects of locations) {
    const code = path.dirname(projects);
    if (path.basename(projects) !== 'projects' || path.basename(code) !== 'code') continue;
    const desktop = path.join(path.dirname(code), 'desktop');
    try {
      const [profile, config, history] = await Promise.all([
        fs.readFile(path.join(code,'.claude.json'),'utf8').then(JSON.parse),
        fs.readFile(path.join(desktop,'config.json'),'utf8').then(JSON.parse),
        fs.readFile(path.join(desktop,'plan-usage-history.json'),'utf8').then(JSON.parse),
      ]);
      const account = profile.oauthAccount;
      if (!account?.accountUuid || account.accountUuid !== config.lastKnownAccountUuid || !account.organizationUuid || history.version !== 2 || !Array.isArray(history.samples)) continue;
      for (const sample of history.samples) {
        if (sample.org !== account.organizationUuid || !Number.isFinite(sample.t) || sample.t > nowMs || nowMs - sample.t > 86400000) continue;
        const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
        if (!valid(sample.u?.fh) || !valid(sample.u?.sd)) continue;
        if (!newest || sample.t > Date.parse(newest.cached_at)) newest = {
          configured:true, error:null, source:'claude_desktop_cache',
          five_hour:{utilization:sample.u.fh,resets_at:null},
          seven_day:{utilization:sample.u.sd,resets_at:null},
          stale:nowMs-sample.t>300000, cached_at:new Date(sample.t).toISOString(),
        };
      }
    } catch { /* Missing files, account changes and incomplete writes are not quota data. */ }
  }
  return newest;
}
module.exports={readClaudeDesktopUsage};
