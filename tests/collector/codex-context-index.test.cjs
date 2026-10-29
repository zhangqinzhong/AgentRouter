const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),{execFileSync}=require('node:child_process');
const modulePath=path.resolve('packages/core/src/vendor/tokentracker/lib/codex-context-breakdown.js');
const offlinePath=path.resolve('packages/core/src/vendor/tokentracker/lib/offline-api.js');
const stamp=n=>`2026-10-${String(n).padStart(2,'0')}T10:00:00Z`;
function rows(id,input,day=27){const usage={input_tokens:input,cached_input_tokens:0,output_tokens:20,total_tokens:input+20};return [
 {type:'session_meta',timestamp:stamp(day),payload:{id,cwd:'/fixture',model:'gpt-5'}},
 {type:'turn_context',timestamp:stamp(day),payload:{model:'gpt-5'}},
 {type:'response_item',timestamp:stamp(day),payload:{type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE-PROMPT-不得缓存'}]}},
 {type:'response_item',timestamp:stamp(day),payload:{type:'function_call',name:'read_file',arguments:JSON.stringify({path:'PRIVATE-ARGUMENT-不得缓存'})}},
 {type:'event_msg',timestamp:stamp(day),payload:{type:'token_count',info:{last_token_usage:usage,total_token_usage:usage}}}
];}
function file(root,id,records,compressed=false){const p=path.join(root,`rollout-2026-10-27T10-00-00-${id}.jsonl${compressed?'.zst':''}`);const text=records.map(JSON.stringify).join('\r\n')+'\r\n';fs.writeFileSync(p,compressed?zlib.zstdCompressSync(Buffer.from(text)):text);return p;}
function query(root,cacheDir,extra={}){const result=execFileSync(process.execPath,['-e',`const q=JSON.parse(process.argv[1]);q.timeZoneContext=require(${JSON.stringify(offlinePath)}).getTimeZoneContext(new URL('http://localhost/?tz='+q.tz));delete q.tz;require(${JSON.stringify(modulePath)}).computeCodexContextBreakdown(q).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1});`,JSON.stringify({codexDir:root,cacheDir,from:'',to:'2026-10-27',top:50,tz:'UTC',includeDiagnostics:true,...extra})],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});return JSON.parse(result);}
function value(result){const copy=structuredClone(result);delete copy.diagnostics;return copy;}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ar-context-index-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const logs=path.join(root,'logs'),cache=path.join(root,'cache');fs.mkdirSync(logs);return{root,logs,cache};}
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';

test('a fresh process reuses aggregate shards for live/compressed/mirrored sessions without parsing content',t=>{
 const {logs,cache}=setup(t);const record=rows(a,100);file(logs,a,record);fs.mkdirSync(path.join(logs,'archive'));file(path.join(logs,'archive'),a,record,true);file(logs,b,rows(b,200),true);
 const first=query(logs,cache);assert.equal(first.totals.total_tokens,340);assert.equal(first.tool_calls_breakdown.total_calls,2);
 const restarted=query(logs,cache);assert.deepEqual(value(restarted),value(first));assert.equal(restarted.diagnostics.disk_cache_hits,2);assert.equal(restarted.diagnostics.json_parse_calls,0);assert.equal(restarted.diagnostics.opened_files,0);
 for(const name of fs.readdirSync(cache)){const raw=fs.readFileSync(path.join(cache,name),'utf8');assert.ok(!raw.includes('PRIVATE-PROMPT'));assert.ok(!raw.includes('PRIVATE-ARGUMENT'));assert.ok(!raw.includes('resumeState'));if(process.platform!=='win32')assert.equal(fs.statSync(path.join(cache,name)).mode&0o777,0o600);}
});
test('append and same-size atomic replacement invalidate only changed session groups',t=>{
 const {logs,cache}=setup(t);const one=file(logs,a,rows(a,100));file(logs,b,rows(b,200),true);query(logs,cache);
 const next=rows(a,100).slice(3);next[1].payload.info.total_token_usage={input_tokens:200,cached_input_tokens:0,output_tokens:40,total_tokens:240};next.forEach(r=>r.timestamp='2026-10-27T11:00:00Z');fs.appendFileSync(one,next.map(JSON.stringify).join('\n')+'\n');
 const appended=query(logs,cache);assert.equal(appended.diagnostics.disk_cache_hits,1);assert.equal(appended.totals.total_tokens,460);assert.deepEqual(value(appended),value(query(logs,null)));
 const original=fs.statSync(one),raw=fs.readFileSync(one,'utf8').replaceAll('"input_tokens":100','"input_tokens":101');fs.writeFileSync(one+'.next',raw);fs.utimesSync(one+'.next',original.atime,original.mtime);fs.renameSync(one+'.next',one);assert.equal(fs.statSync(one).size,original.size);
 const replaced=query(logs,cache);assert.deepEqual(value(replaced),value(query(logs,null)));assert.ok(replaced.diagnostics.json_parse_calls>0);assert.equal(replaced.diagnostics.disk_cache_hits,1);
});
test('corrupt/tampered shards and an unwritable cache fall back to original logs',t=>{
 const {root,logs,cache}=setup(t);file(logs,a,rows(a,100));const expected=value(query(logs,cache));const p=path.join(cache,fs.readdirSync(cache)[0]);
 const tampered=JSON.parse(fs.readFileSync(p,'utf8'));tampered.parsed.totals.total_tokens=999999;fs.writeFileSync(p,JSON.stringify(tampered));const repaired=query(logs,cache);assert.deepEqual(value(repaired),expected);assert.ok(repaired.diagnostics.json_parse_calls>0);
 fs.writeFileSync(p,'incomplete');assert.deepEqual(value(query(logs,cache)),expected);
 const blocked=path.join(root,'not-a-directory');fs.writeFileSync(blocked,'fixture');assert.deepEqual(value(query(logs,blocked)),expected);
});
test('midnight reuses completed historical sessions but reparses previously excluded future events',t=>{
 const {logs,cache}=setup(t);file(logs,a,rows(a,100));const future=[...rows(b,200),...rows(b,300,28)];file(logs,b,future,true);
 const initial=query(logs,cache);assert.equal(initial.totals.total_tokens,340);
 const advanced=query(logs,cache,{to:'2026-10-28'});assert.equal(advanced.diagnostics.disk_cache_hits,1);assert.deepEqual(value(advanced),value(query(logs,null,{to:'2026-10-28'})));assert.ok(advanced.totals.total_tokens>initial.totals.total_tokens);
 assert.deepEqual(value(query(logs,cache)),value(initial));
 assert.deepEqual(value(query(logs,cache,{from:'2026-10-28',to:'2026-10-28'})),value(query(logs,null,{from:'2026-10-28',to:'2026-10-28'})));
 assert.deepEqual(value(query(logs,cache,{tz:'Pacific/Honolulu'})),value(query(logs,null,{tz:'Pacific/Honolulu'})));
});
