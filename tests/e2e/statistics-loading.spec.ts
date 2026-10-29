import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
let bundle: string;
test.beforeAll(async()=>{
 const result=await build({entryPoints:['tests/e2e/fixtures/statistics-loading.jsx'],bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',tsconfig:path.resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"test"'},loader:{'.png':'dataurl','.svg':'dataurl','.ico':'dataurl','.jpg':'dataurl','.jpeg':'dataurl','.webp':'dataurl','.gif':'dataurl'}});
 bundle=result.outputFiles[0].text;
});
async function open(page: Page, mode: string) {
 await page.addInitScript(()=>{
  (window as any).__calls=[];
  let usageCount=0,heatmapCount=0;
  (window as any).agentrouter={
   getLocalUsagePage:async()=>{
    (window as any).__calls.push('usage');const count=++usageCount;const total=count===1?120:220;
    const totals={total_tokens:total,billable_total_tokens:total,input_tokens:total,total_cost_usd:1};
    return {collectionState:count===1?'loading':'ready',totals,sources:[{source:'codex',totals,models:[{model:'fixture-model',totals}]}]};
   },
   getLocalUsageTrend:async(q: any)=>{
    if(q.period==='month')return await new Promise(resolve=>{(window as any).__finishOld=()=>resolve({from:'2026-10-01',to:'2026-10-27',data:[{day:'2026-10-27',total_tokens:999}]});});
    return {from:'2026-10-21',to:'2026-10-27',data:[{day:'2026-10-27',total_tokens:220}]};
   },
   getLocalUsageHeatmap:async()=>{
    (window as any).__calls.push('heatmap');const count=++heatmapCount;
    return {collectionState:count===1?'loading':'ready',profile:{username:'fixture'},weeks:[[{day:'2026-10-27',total_tokens:count===1?120:220}]]};
   },
   getLocalUsageSessions:async()=>({sessions:[]}),
   getLocalUsageCategories:async()=>{(window as any).__calls.push('category');return {};}
  };
 });
 await page.route('http://statistics.test/**',route=>route.fulfill({contentType:new URL(route.request().url()).pathname==='/app.js'?'application/javascript':'text/html',body:new URL(route.request().url()).pathname==='/app.js'?bundle:'<html><body><div id="root"></div><script src="/app.js"></script></body></html>'}));
 await page.goto('http://statistics.test/?page='+mode);
}
test('saved usage stays visible and updates when background collection completes',async({page})=>{
 await open(page,'usage');
 await expect(page.getByRole('button',{name:/全部工具：120 Token/})).toBeVisible();
 await expect(page.getByRole('button',{name:/全部工具：220 Token/})).toBeVisible();
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__calls.filter((v:string)=>v==='usage').length)).toBe(2);
});
test('a late trend response cannot overwrite the newly selected period',async({page})=>{
 await open(page,'trend');
 await page.getByRole('button',{name:'Week',exact:true}).click();
 await expect(page.getByLabel('trend tokens')).toHaveText('220');
 await page.evaluate(()=>(window as any).__finishOld());
 await expect(page.getByLabel('trend tokens')).toHaveText('220');
 await expect(page.getByLabel('trend loading')).toHaveText('false');
});
test('heatmap snapshot polling does not rerun expensive transcript analyses',async({page})=>{
 await open(page,'heatmap');
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((v:string)=>v==='heatmap').length)).toBe(2);
 const calls=await page.evaluate(()=>(window as any).__calls);
 expect(calls.filter((v:string)=>v==='category')).toHaveLength(3);
});
