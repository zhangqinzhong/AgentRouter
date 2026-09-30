const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {getUsageLimits,resetUsageLimitsCache}=require('../../packages/core/src/vendor/tokentracker/lib/usage-limits');
test('single-account force refresh contacts only Codex and bypasses its cache',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'quota-scope-'));const urls=[];
 try {
  fs.mkdirSync(path.join(home,'.codex'));fs.writeFileSync(path.join(home,'.codex/auth.json'),JSON.stringify({tokens:{access_token:'test-token'}}));
  const options={home,env:{},platform:'linux',provider:'codex',allowCodexTokenRefresh:false,commandRunner:()=>{throw Error('Unrelated CLI queried')},securityRunner:()=>{throw Error('Unrelated keychain queried')},fetchImpl:async url=>{
   urls.push(String(url));assert.match(String(url),/^https:\/\/chatgpt.com\/backend-api\/wham\//);
   return {ok:true,status:200,json:async()=>({rate_limit:{primary_window:{used_percent:10,reset_at:2000000000,limit_window_seconds:18000}},rate_limit_reset_credits:{available_count:0,credits:[]}})};
  }};
  resetUsageLimitsCache();const first=await getUsageLimits(options);assert.deepEqual(Object.keys(first).sort(),['codex','fetched_at']);assert.equal(first.codex.primary_window.used_percent,10);
  const count=urls.length;assert.ok(count>0);await getUsageLimits(options);assert.equal(urls.length,count);
  await getUsageLimits({...options,forceRefresh:true});assert.ok(urls.length>count);
  await assert.rejects(getUsageLimits({...options,provider:'unknown'}),/Unknown quota provider/);
 } finally {resetUsageLimitsCache();fs.rmSync(home,{recursive:true,force:true})}
});
