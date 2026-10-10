import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionDetailModal} from '../../src/vendor/tokentracker/ui/dashboard/components/SessionDetailModal';
import {setUsageLocale} from '../../src/vendor/tokentracker/lib/copy';
import {summarizeSessions} from '../../src/vendor/tokentracker/lib/sessions-insights';

test('session detail distinguishes missing pricing from free and includes child usage once',()=>{
 setUsageLocale('zh');
 const child={session_hash:'child',own_total_tokens:50,own_cost_usd:0.5,total_tokens:50,cost_usd:0.5};
 assert.equal(summarizeSessions([child,child]).tokens,50);
 const html=renderToStaticMarkup(<SessionDetailModal onClose={()=>{}} subagents={[child]} session={{source:'codex',session_hash:'parent',title:'Session',own_total_tokens:100,own_cost_usd:1,total_tokens:150,cost_usd:1.5,subagent_total_tokens:50,subagent_cost_usd:0.5,cost_is_partial:true,model_usage:[{model:'unknown-model',total_tokens:70,cost_usd:0,pricing:{status:'unpriced'}},{model:'free-model',total_tokens:30,cost_usd:0,pricing:{status:'free'}}]}}/>);
 assert.match(html,/role="dialog"/);
 assert.match(html,/unknown-model/);
 assert.match(html,/free-model/);
 assert.match(html,/≥/);
 assert.doesNotMatch(html,/sessions\.[a-z_.]+|dashboard\.[a-z_.]+/);
 for(const label of ["输入","缓存读取","缓存写入","输出","推理输出"]) assert.ok(html.includes(label));
 assert.doesNotMatch(html,/NaN|undefined/);
});
