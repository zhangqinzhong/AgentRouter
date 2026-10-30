const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {readClaudeDesktopUsage}=require('../../packages/core/src/vendor/tokentracker/lib/claude-desktop-usage');
test('desktop snapshots require matching account and organization, valid values and recent time',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ar-desktop-quota-'));const code=path.join(root,'code'),desktop=path.join(root,'desktop');fs.mkdirSync(code);fs.mkdirSync(desktop);const nowMs=Date.now();const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
 const cfg=path.join(desktop,'config.json'),hist=path.join(desktop,'plan-usage-history.json');const read=()=>readClaudeDesktopUsage({roots:[path.join(code,'projects')],nowMs});
 try{
 write(path.join(code,'.claude.json'),{oauthAccount:{accountUuid:'account',organizationUuid:'org'}});write(cfg,{lastKnownAccountUuid:'account'});
 const sample={t:nowMs-600000,org:'org',u:{fh:15,sd:17}};write(hist,{version:2,samples:[sample,{...sample,t:nowMs,org:'other',u:{fh:99,sd:99}}]});
 const result=await read();assert.equal(result.five_hour.utilization,15);assert.equal(result.seven_day.utilization,17);assert.equal(result.stale,true);assert.equal(result.five_hour.resets_at,null);
 write(cfg,{lastKnownAccountUuid:'other'});assert.equal(await read(),null);write(cfg,{lastKnownAccountUuid:'account'});
 for(const patch of [{t:nowMs+1},{t:nowMs-86400001},{u:{fh:-1,sd:1}},{u:{fh:1,sd:101}},{u:{fh:'15',sd:17}},{u:{}}]){write(hist,{version:2,samples:[{...sample,...patch}]});assert.equal(await read(),null)}
 fs.writeFileSync(hist,'{');assert.equal(await read(),null);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
