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
import {matchingSessionProfiles,profileOpenSurfaces,resumeExtraArgs} from '../../src/vendor/tokentracker/pages/SessionsPage';
import {formatToolCalls,toolDisplayName} from '../../src/pages/home/components/heatmap-tools';
import {dailyRowsFromHeatmap,heatmapCellTokens} from '../../src/pages/home/components/local-heatmap';
import {heatmapTrendRange,trendChartPoints} from '../../src/pages/home/components/usage-trend-line';
import {buildActivityHeatmap} from '../../src/vendor/tokentracker/lib/activity-heatmap';
test('unattributed models display Other and sort behind concrete models regardless of usage',()=>{setUsageLocale('zh');assert.equal(modelDisplayName('unknown'),'其他');const rows=[{name:'unknown',usage:999},{name:'gpt-test',usage:1}].sort((a,b)=>compareOtherLast(a,b)||b.usage-a.usage);assert.equal(rows[1].name,'unknown');setUsageLocale('en');assert.equal(modelDisplayName('unknown'),'Other');setUsageLocale('zh');});
test('heatmap trend range follows menu-bar day week month year windows',()=>{
 const date=new Date(2026,8,16,12);
 const empty={from:'',to:''};
 assert.deepEqual(heatmapTrendRange('day',empty,date),{from:'2026-09-16',to:'2026-09-16'});
 assert.deepEqual(heatmapTrendRange('week',empty,date),{from:'2026-09-14',to:'2026-09-20'});
 assert.deepEqual(heatmapTrendRange('month',empty,date),{from:'2026-09-01',to:'2026-09-30'});
 assert.deepEqual(heatmapTrendRange('year',empty,date),{from:'2026-01-01',to:'2026-12-31'});
 assert.equal(heatmapTrendRange('total',empty,date).to,'2026-09-16');
});
test('trend line fills a complete month axis and keeps zero days',()=>{
 const points=trendChartPoints([
  {day:'2026-09-01',total_tokens:100,billable_total_tokens:100},
  {day:'2026-09-08',total_tokens:200,billable_total_tokens:200}
 ],'month','2026-09-01','2026-09-30');
 assert.equal(points.length,30);
 assert.equal(points[0].tokens,100);
 assert.equal(points[7].tokens,200);
 assert.equal(points[1].tokens,0);
});
test('day trend axis is 24 hours and year trend axis is 12 months',()=>{
 assert.equal(trendChartPoints([],'day','2026-09-16','2026-09-16').length,24);
 assert.equal(trendChartPoints([],'year','2026-01-01','2026-12-31').length,12);
 assert.equal(trendChartPoints([],'week','2026-09-14','2026-09-20').length,7);
});
test('year and day axes map collector month and hour keys onto the fixed buckets',()=>{
 const year=trendChartPoints([{month:'2026-09',total_tokens:100,billable_total_tokens:100}],'year','2026-01-01','2026-12-31');
 assert.equal(year[8].tokens,100);
 const hours=trendChartPoints([{hour:'2026-09-16T14:00:00',total_tokens:50,billable_total_tokens:50}],'day','2026-09-16','2026-09-16');
 assert.equal(hours[14].tokens,50);
});
test('total trend axis fills the 24-month window including empty 2025 months',()=>{
 const points=trendChartPoints([
  {month:'2026-03',total_tokens:100,billable_total_tokens:100},
  {month:'2026-09',total_tokens:200,billable_total_tokens:200}
 ],'total','','2026-09-16');
 assert.equal(points.length,24);
 assert.equal(points[0].row.month,'2024-10');
 assert.equal(points.find((point)=>point.row.month==='2026-03')?.tokens,100);
 assert.equal(points.find((point)=>point.row.month==='2025-01')?.tokens,0);
 assert.equal(points[points.length-1].row.month,'2026-09');
});
test('custom long range uses monthly ticks instead of every day',()=>{
 const points=trendChartPoints([
  {day:'2026-03-02',total_tokens:40,billable_total_tokens:40},
  {day:'2026-09-16',total_tokens:80,billable_total_tokens:80}
 ],'custom','2025-04-01','2026-09-16');
 assert.equal(points.length,18);
 assert.equal(points[0].row.month,'2025-04');
 assert.equal(points.find((point)=>point.row.month==='2025-12')?.tokens,0);
 assert.equal(points.find((point)=>point.row.month==='2026-03')?.tokens,40);
 assert.equal(points[points.length-1].row.month,'2026-09');
});
test('session resume args follow each agent CLI and prefer tagged AgentRouter profiles',()=>{
 assert.deepEqual(resumeExtraArgs('codex','abc-123'),['resume','abc-123']);
 assert.deepEqual(resumeExtraArgs('claude','abc-123'),['--resume','abc-123']);
 assert.deepEqual(resumeExtraArgs('grok','abc-123'),['--resume','abc-123']);
 const profiles=[
  {id:'codex-work',name:'Codex Work',agent:'codex',enabled:true},
  {id:'codex-company',name:'CodexCompany',agent:'codex',enabled:true},
  {id:'grok-home',name:'Grok',agent:'grok',enabled:true}
 ];
 assert.equal(matchingSessionProfiles(profiles,{source:'codex',ar_profile:'codex-work'})[0].id,'codex-work');
 assert.equal(matchingSessionProfiles(profiles,{source:'grok'})[0].id,'grok-home');
 assert.equal(matchingSessionProfiles(profiles,{source:'codex'}).length,0);
 assert.deepEqual(profileOpenSurfaces({agent:'codex',surface:'auto'}),['cli','app']);
 assert.deepEqual(profileOpenSurfaces({agent:'codex',surface:'cli'}),['cli']);
 assert.deepEqual(profileOpenSurfaces({agent:'grok'}),['cli']);
});
test('heatmap tool names map raw ids and format integer call counts',()=>{
 assert.equal(formatToolCalls(17626),'17,626');
 assert.equal(formatToolCalls(17.626),'18');
 assert.equal(toolDisplayName('exec_command'),'执行命令');
 assert.equal(toolDisplayName('mcp__browser__click'),'Browser / Click');
});
test('heatmap cells read billable tokens when value is missing',()=>{
 const rows=dailyRowsFromHeatmap({weeks:[[{day:'2026-03-07',billable_total_tokens:150,total_tokens:150,level:2}]]});
 assert.equal(heatmapCellTokens({day:'2026-03-07',billable_total_tokens:150,level:2}),150);
 assert.equal(rows[0].billable_total_tokens,150);
 const built=buildActivityHeatmap({dailyRows:rows,weeks:1,to:'2026-03-07',weekStartsOn:'sun'});
 assert.ok(built.weeks.flat().some((cell)=>cell&&cell.day==='2026-03-07'&&cell.value===150&&cell.level>0));
});
test('custom short range keeps a daily axis',()=>{
 const points=trendChartPoints([
  {day:'2026-09-01',total_tokens:10,billable_total_tokens:10}
 ],'custom','2026-09-01','2026-09-16');
 assert.equal(points.length,16);
 assert.equal(points[0].tokens,10);
 assert.equal(points[1].tokens,0);
});
