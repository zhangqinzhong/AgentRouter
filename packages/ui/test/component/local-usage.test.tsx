import test from 'node:test';
import assert from 'node:assert/strict';
import {localUsageRange} from '../../src/pages/home/components/local-usage';
import {buildFleetData} from '../../src/vendor/tokentracker/lib/model-breakdown';

test('local usage calendar ranges preserve week/month boundaries and custom dates',()=>{
 const date=new Date(2026,2,1,12);
 assert.deepEqual(localUsageRange('week',{from:'',to:''},date),{from:'2026-02-23',to:'2026-03-01'});
 assert.deepEqual(localUsageRange('month',{from:'',to:''},date),{from:'2026-03-01',to:'2026-03-31'});
 assert.deepEqual(localUsageRange('custom',{from:'2025-12-31',to:'2026-01-02'},date),{from:'2025-12-31',to:'2026-01-02'});
});
test('tool proportions use collected totals without double adding cached tokens',()=>{
 const providers=buildFleetData({sources:[{source:'codex',totals:{total_tokens:100,billable_total_tokens:100,total_cost_usd:'1'},models:[{model:'gpt-fixture',totals:{total_tokens:100,billable_total_tokens:100,input_tokens:10,cached_input_tokens:80,output_tokens:10,total_cost_usd:'1'}}]},{source:'claude',totals:{total_tokens:100,billable_total_tokens:100,total_cost_usd:'2'},models:[{model:'claude-fixture',totals:{total_tokens:100,billable_total_tokens:100,total_cost_usd:'2'}}]}]});
 assert.equal(providers.reduce((sum,p)=>sum+p.usage,0),200);
 assert.ok(providers.every(p=>Number(p.totalPercent)===50));
});

import {modelDisplayName,compareOtherLast} from '../../src/vendor/tokentracker/lib/model-display';
import {setUsageLocale} from '../../src/vendor/tokentracker/lib/copy';
test('unattributed models display Other and sort behind concrete models regardless of usage',()=>{setUsageLocale('zh');assert.equal(modelDisplayName('unknown'),'其他');const rows=[{name:'unknown',usage:999},{name:'gpt-test',usage:1}].sort((a,b)=>compareOtherLast(a,b)||b.usage-a.usage);assert.equal(rows[1].name,'unknown');setUsageLocale('en');assert.equal(modelDisplayName('unknown'),'Other');setUsageLocale('zh');});
