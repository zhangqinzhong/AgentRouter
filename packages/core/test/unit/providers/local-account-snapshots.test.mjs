import test from 'node:test';import assert from 'node:assert/strict';
import {localQuotaSnapshots,mergeAccountSnapshots} from '@agentrouter/core/providers/local-account-snapshots.ts';
test('local quotas retain every window, correct remaining percentage and account plan',()=>{
 const rows=localQuotaSnapshots({fetched_at:'2026-09-30T00:00:00Z',cursor:{configured:true,primary_window:{used_percent:1},secondary_window:{used_percent:2},tertiary_window:{used_percent:0},grok_bot_plan_label:'SuperGrok Heavy',quaternary_window:{used_percent:4}},zcode:{configured:true,plan_label:'Start',primary_window:{used_percent:71,reset_at:2000000000}},copilot:{configured:false}});
 assert.equal(rows.length,3);assert.equal(rows[0].meters.length,3);const bot=rows.find(r=>r.localSource==='grokbot');assert.equal(bot.displayName,'Grok Bot · SuperGrok Heavy');assert.equal(bot.meters[0].remaining,96);const zcode=rows.find(r=>r.localSource==='zcode');assert.equal(zcode.displayName,'ZCode Start');assert.equal(zcode.meters[0].remaining,29);assert.equal(zcode.meters[0].resetAt,new Date(2000000000000).toISOString());
});
test('only proven same local login is deduplicated; paid credentials stay separate',()=>{
 const local=localQuotaSnapshots({codex:{configured:true,primary_window:{used_percent:10}}});
 const row={provider:'Renamed Codex',meters:[{id:'quota'}]};const provider={name:'Renamed Codex',api_key:'ar-local-agent-login',baseUrl:'https://chatgpt.com/backend-api/codex'};
 assert.equal(mergeAccountSnapshots([provider],[row],local).length,1);
 assert.equal(mergeAccountSnapshots([{...provider,api_key:'paid-api-key'}],[row],local).length,2);
 assert.equal(mergeAccountSnapshots([provider],[{...row,credentialId:'other-account'}],local).length,2);
 assert.equal(mergeAccountSnapshots([provider],[{...row,meters:[]}],local).length,2);
});
