import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
let bundle: string, css: string;
test.beforeAll(async()=>{
 const result=await build({entryPoints:['tests/e2e/fixtures/statistics-loading.jsx'],plugins:process.env.AR_CAPTURE_BEFORE?[{name:'baseline-usage',setup(build){build.onLoad({filter:/components\/local-usage\.tsx$/},args=>({contents:execFileSync('git',['show',`HEAD:${path.relative(process.cwd(),args.path)}`],{encoding:'utf8'}),loader:'tsx',resolveDir:path.dirname(args.path)}));}}]:[],bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',tsconfig:path.resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"test"'},loader:{'.png':'dataurl','.svg':'dataurl','.ico':'dataurl','.jpg':'dataurl','.jpeg':'dataurl','.webp':'dataurl','.gif':'dataurl'}});
 bundle=result.outputFiles[0].text;
 css=execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','packages/ui/src/styles/globals.css','--minify'],{encoding:'utf8',maxBuffer:10*1024*1024});
});
async function open(page: Page, mode: string) {
 await page.addInitScript(()=>{
  (window as any).__calls=[];
  let usageCount=0,heatmapCount=0;
  (window as any).agentrouter={
   getLocalUsagePage:async(q: any)=>{
    if(new URLSearchParams(location.search).get('instances')) {
      (window as any).__queries ??= []; (window as any).__queries.push(q);
      const rows=[{source:'claude',id:'default',name:'Default Claude Code',tokens:100},{source:'claude',id:'official',name:'Official fixture',tokens:200},{source:'codex',id:'codex',name:'Default Codex',tokens:300}];
      const selected=rows.filter(r=>(!q.source||r.source===q.source)&&(!q.instance||r.id===q.instance));
      const totals={total_tokens:selected.reduce((n,r)=>n+r.tokens,0),total_cost_usd:selected.reduce((n,r)=>n+r.tokens/100,0)};
      return {collectionState:'ready',totals,instances:rows,sources:selected.map(r=>({source:r.source,totals:{total_tokens:r.tokens,total_cost_usd:r.tokens/100},models:[{model:r.id,totals:{total_tokens:r.tokens,total_cost_usd:r.tokens/100}}]}))};
    }
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
 await page.route('http://statistics.test/**',route=>{const p=new URL(route.request().url()).pathname;return route.fulfill({contentType:p==='/app.js'?'application/javascript':p==='/styles.css'?'text/css':'text/html',body:p==='/app.js'?bundle:p==='/styles.css'?css:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="bg-background text-foreground"><div id="root"></div><script>if(matchMedia("(prefers-color-scheme:dark)").matches){document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark"}</script><script src="/app.js"></script></body></html>'})});
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

test('client and instance filters update totals and survive period changes',async({page})=>{
 await open(page,'usage&instances=1');
 await expect(page.getByRole('combobox',{name:'客户端',exact:true})).toContainText('全部客户端');
 await expect(page.getByRole('button',{name:/全部工具：600 Token/})).toBeVisible();
 await page.getByRole('combobox',{name:'客户端',exact:true}).selectOption('claude');
 await expect(page.getByRole('button',{name:/全部工具：300 Token/})).toBeVisible();
 await page.getByRole('combobox',{name:'配置实例',exact:true}).selectOption('official');
 await expect(page.getByRole('button',{name:/全部工具：200 Token/})).toBeVisible();
 await page.getByRole('tab',{name:'周',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'配置实例',exact:true})).toHaveValue('official');
 await expect.poll(()=>page.evaluate(()=>(window as any).__queries.at(-1).instance)).toBe('official');
 await page.getByRole('combobox',{name:'客户端',exact:true}).selectOption('codex');
 await expect(page.getByRole('combobox',{name:'配置实例',exact:true})).toHaveValue('');
 await expect(page.getByRole('button',{name:/全部工具：300 Token/})).toBeVisible();
});

for(const mode of ['light','dark','narrow'])test(`instance filter layout (${mode})`,async({page})=>{
 await page.setViewportSize({width:mode==='narrow'?390:1280,height:900});
 await page.emulateMedia({colorScheme:mode==='dark'?'dark':'light',reducedMotion:'reduce'});
 await open(page,'usage&instances=1');
 await expect(page.getByRole('button',{name:/全部工具：600 Token/})).toBeVisible();
 if(!process.env.AR_CAPTURE_BEFORE){
  await page.getByRole('combobox',{name:'客户端',exact:true}).selectOption('claude');
  await page.getByRole('combobox',{name:'配置实例',exact:true}).selectOption('official');
  await expect(page.getByRole('button',{name:/全部工具：200 Token/})).toBeVisible();
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(mode==='narrow'?390:1280);
 await page.waitForTimeout(500);
 mkdirSync('output/usage-instances',{recursive:true});
 await page.screenshot({path:`output/usage-instances/${process.env.AR_CAPTURE_BEFORE?'before':'after'}-${mode}.png`,fullPage:true});
});
