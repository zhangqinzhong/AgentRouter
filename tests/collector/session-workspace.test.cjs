const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const binary=path.resolve('native/session-reader/target/release/agentrouter-session-reader');
function request(env,q){return new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(binary,[],{env,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code?reject(new Error(err)):resolve(JSON.parse(out)));child.stdin.end(JSON.stringify(q));});}
test('owned index supports native sources, CJK/code search, stable anchors, persistence, export and safe cleanup review',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-owned-sessions-'));
 const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'.agentrouter/sessions/index.sqlite'),CODEX_HOME:path.join(home,'.codex')};
 try{
  const projects=path.join(home,'.claude/projects/test');await fs.mkdir(projects,{recursive:true});
  const file=path.join(projects,'fixture-session.jsonl');
  await fs.writeFile(file,[{type:'user',sessionId:'fixture-session',uuid:'u1',cwd:'/tmp/ar-fixture-project',timestamp:'2026-10-13T10:00:00Z',message:{role:'user',content:'请查一下二维码 useEffect( 的逻辑'}},{type:'assistant',sessionId:'fixture-session',uuid:'a1',parentUuid:'u1',timestamp:'2026-10-13T10:00:01Z',message:{role:'assistant',content:[{type:'text',text:'已完成修复，保持只读。'}],usage:{input_tokens:12,output_tokens:5}}}].map(JSON.stringify).join('\n'));
  await request(env,{op:'refresh'});
  const list=await request(env,{op:'list'});assert.ok(list.sessions.length);const row=list.sessions.find(s=>s.id==='fixture-session');assert.ok(row);
  for(const query of ['二维码','useEffect(']){const found=await request(env,{op:'search',query});assert.ok(found.hits.some(h=>h.session.key===row.key));const h=found.hits.find(h=>h.session.key===row.key);const read=await request(env,{op:'transcript',key:row.key,seq:h.seq});assert.equal(read.messages[0].seq,h.seq);}
  await request(env,{op:'state',key:row.key,favorite:true,pinned:true});const again=await request(env,{op:'list',starred:true});assert.equal(again.sessions[0].favorite,true);assert.equal(again.sessions[0].pinned,true);
  const cleanup=await request(env,{op:'cleanup'});assert.ok(!cleanup.candidates.some(c=>c.root.key===row.key),'favorite/pinned sessions are protected');
  const settings=await request(env,{op:'settings'});const location=settings.sources.find(s=>s.agent==='claude-code'&&s.paths.includes(path.dirname(projects)));assert.ok(location);await request(env,{op:'location-state',agent:'claude-code',path:location.paths[0],enabled:false});assert.equal((await request(env,{op:'settings'})).sources.find(s=>s.paths.includes(location.paths[0])).enabled,false);await request(env,{op:'location-state',agent:'claude-code',path:location.paths[0],enabled:true});
  const insight=await request(env,{op:"insights",today:"2026-10-13"});assert.equal(insight.sessions,1);assert.equal(insight.prompts,1);assert.equal(insight.agents[0].name,"claude-code");
  const handoff=await request(env,{op:'handoff',key:row.key});assert.match(handoff.markdown,/agentrouter-session-cli/);assert.ok(handoff.markdown.includes(row.key));
  await request(env,{op:'remote-add',name:'fixture-host'});await request(env,{op:'remote-state',name:'fixture-host',enabled:false});assert.equal((await request(env,{op:'settings'})).remotes[0].enabled,false);await request(env,{op:'remote-remove',name:'fixture-host'});
  assert.equal((await request(env,{op:'transcript',key:row.key})).deletion,'trash');
  const exported=await request(env,{op:'export',key:row.key});assert.match(exported.markdown,/二维码/);
  await assert.rejects(request(env,{op:'transcript',key:'../../etc/passwd'}),/not found/);
  await assert.rejects(request(env,{op:'transcript',key:row.key,sidechain:'../../etc/passwd'}),/Unknown branch/);
  await assert.rejects(request(env,{op:'remote-add',name:'-oProxyCommand=bad'}),/Invalid/);
  await assert.rejects(request(env,{op:'cleanup-execute',id:'fabricated'}),/expired/);
  assert.match(await fs.readFile(file,'utf8'),/二维码/);
  assert.equal(await fs.stat(path.join(home,'.agentrouter/sessions/index.sqlite')).then(()=>true),true);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('watcher indexes incremental events, shares ownership and exits when parent closes stdin',{timeout:30000},async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-watch-sessions-'));
 const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'.agentrouter/sessions/index.sqlite'),CODEX_HOME:path.join(home,'.codex')};
 const projects=path.join(home,'.claude/projects/test');await fs.mkdir(projects,{recursive:true});
 const {spawn}=require('node:child_process');const child=spawn(binary,['--watch'],{env,stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);const closed=new Promise(resolve=>child.on('close',resolve));
 async function until(check){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,100))}throw new Error('Watcher did not converge: '+error)}
 try{
  await until(()=>output.includes('"scanning":false'));
  await fs.writeFile(path.join(projects,'live-session.jsonl'),JSON.stringify({type:'user',sessionId:'live-session',uuid:'u-live',cwd:'/tmp/ar-watch-project',timestamp:new Date().toISOString(),message:{role:'user',content:'watcher integration fixture'}})+'\n');
  await until(async()=> (await request(env,{op:'list'})).sessions.some(s=>s.id==='live-session'));
  const second=spawn(binary,['--watch'],{env,stdio:['pipe','pipe','pipe']});let other='';second.stdout.on('data',c=>other+=c);await new Promise((resolve,reject)=>{second.on('close',resolve);second.on('error',reject)});assert.match(other,/"shared":true/);
  child.stdin.end();assert.equal(await closed,0);assert.match(output,/"changed":true/);
 }finally{child.kill();await closed;await fs.rm(home,{recursive:true,force:true})}
});
test('database sessions can be hidden and restored without modifying the client database',{timeout:20000},async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-db-sessions-'));const dbPath=path.join(home,'.local/share/mimocode/mimocode.db');await fs.mkdir(path.dirname(dbPath),{recursive:true});
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(dbPath);
 db.exec("CREATE TABLE session(id TEXT, directory TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER,version TEXT,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT);INSERT INTO session VALUES('one','/tmp/project','MiMo fixture',1000,2000,NULL,'1',NULL);");
 db.prepare("INSERT INTO message VALUES('a','one',1000,?)").run(JSON.stringify({role:'user',time:{created:1000}}));db.prepare("INSERT INTO part VALUES('p','a','one',?)").run(JSON.stringify({type:'text',text:'local database fixture'}));db.close();
 const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'.agentrouter/sessions/index.sqlite'),MIMO_HOME:path.dirname(dbPath),CODEX_HOME:path.join(home,'.codex')};
 try{const original=await fs.readFile(dbPath);await request(env,{op:'refresh'});const row=(await request(env,{op:'list',agent:'mimo'})).sessions[0];assert.ok(row);assert.equal((await request(env,{op:'transcript',key:row.key})).deletion,'hide');await request(env,{op:'hide',key:row.key});await request(env,{op:'refresh'});assert.equal((await request(env,{op:'list',agent:'mimo'})).sessions.length,0);const h=(await request(env,{op:'hidden'})).records[0];await request(env,{op:'unhide',stamp:h.stamp});await request(env,{op:'refresh'});assert.equal((await request(env,{op:'list',agent:'mimo'})).sessions.length,1);assert.deepEqual(await fs.readFile(dbPath),original);
  const memory=path.join(home,'MEMORY.md');await fs.writeFile(memory,'# Fixture memory\nLocal-only memory source');await request(env,{op:'memory-source-add',agent:'mimo',path:memory});await request(env,{op:'refresh'});const docs=(await request(env,{op:'memories',agent:'mimo',query:'Local-only'})).memories;assert.equal(docs.length,1);assert.match((await request(env,{op:'memory',key:docs[0].key})).body,/Local-only/);await request(env,{op:'memory-source-state',agent:'mimo',id:memory,enabled:false});await request(env,{op:'refresh'});assert.equal((await request(env,{op:'memories',agent:'mimo'})).memories.length,0);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('bundled marketplace plugin resolves owned CLI/MCP without a Wake checkout', async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-session-plugin-'));
 try{
  const bundle=path.join(home,'runtime'),plugin=path.join(bundle,'session-marketplace/plugins/agentrouter-sessions');
  await fs.mkdir(plugin,{recursive:true});await fs.cp(path.resolve('native/session-core/integration'),plugin,{recursive:true});
  for(const bin of ['agentrouter-session-cli','agentrouter-session-mcp'])await fs.symlink(path.resolve('native/session-core/target/release',bin),path.join(bundle,bin));
  const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'index.sqlite'),AR_SESSION_ON_REQUEST:'1'};delete env.AR_SESSION_BIN_DIR;
  await request(env,{op:'refresh'});
  const {spawnSync}=require('node:child_process');
  const hook=spawnSync('sh',[path.join(plugin,'scripts/session-start')],{env,encoding:'utf8'});assert.equal(hook.status,0);assert.equal(hook.stdout,'');
  const mcp=spawnSync('sh',[path.join(plugin,'scripts/session-tools'),'agentrouter-session-mcp'],{env,encoding:'utf8',input:[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(JSON.stringify).join('\n')+'\n'});
  assert.equal(mcp.status,0,mcp.stderr);const messages=mcp.stdout.trim().split('\n').map(JSON.parse);assert.equal(messages[0].result.serverInfo.name,'agentrouter-sessions');assert.equal(messages[1].result.tools.length,5);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('reader hides injected metadata before pagination and retains original search anchors',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-visible-sessions-'));
 const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'index.sqlite'),CODEX_HOME:path.join(home,'.codex')};
 try{
  const dir=path.join(home,'.codex/sessions');await fs.mkdir(dir,{recursive:true});
  const records=[{type:'session_meta',timestamp:'2026-10-13T10:00:00Z',payload:{id:'visible-fixture',cwd:'/tmp/visible-fixture',source:'cli'}}];
  for(let i=0;i<65;i++){
   records.push({type:'response_item',timestamp:'2026-10-13T10:00:01Z',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'<codex_apps_client_time_context>injected metadata</codex_apps_client_time_context>'}]}});
   records.push({type:'response_item',timestamp:'2026-10-13T10:00:02Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:`visible question ${i} ${i===63?'anchorfixture':''}`}]}});
  }
  await fs.writeFile(path.join(dir,'rollout-2026-10-13T10-00-00-visible-fixture.jsonl'),records.map(JSON.stringify).join('\n'));
  await request(env,{op:'refresh'});const row=(await request(env,{op:'list',agent:'codex'})).sessions.find(s=>s.id==='visible-fixture');assert.ok(row);
  const first=await request(env,{op:'transcript',key:row.key});assert.equal(first.messages.length,60);assert.equal(first.total,65);assert.ok(first.messages.every(m=>m.kind!=='meta'&&!m.text.includes('injected metadata')));
  const second=await request(env,{op:'transcript',key:row.key,offset:60});assert.equal(second.messages.length,5);assert.match(second.messages[0].text,/visible question 60/);assert.ok(second.messages[0].seq>60);
  const hit=(await request(env,{op:'search',query:'anchorfixture'})).hits.find(h=>h.session.key===row.key);assert.ok(hit);const jump=await request(env,{op:'transcript',key:row.key,seq:hit.seq});assert.equal(jump.offset,63);assert.equal(jump.messages[0].seq,hit.seq);assert.match(jump.messages[0].text,/anchorfixture/);
 }finally{await fs.rm(home,{recursive:true,force:true})}
});

test('favorite search filters before limiting ranked hits',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ar-favorite-search-'));
 const env={...process.env,AR_SESSION_HOME:home,AR_INTERNAL_HOME_DIR:home,AR_SESSION_INDEX:path.join(home,'index.sqlite'),CODEX_HOME:path.join(home,'.codex')};
 try{
  const dir=path.join(home,'.claude/projects/fixture');await fs.mkdir(dir,{recursive:true});
  for(const [id,time] of [['saved','2020-01-01T00:00:00Z'],['recent','2026-10-13T00:00:00Z']])await fs.writeFile(path.join(dir,id+'.jsonl'),JSON.stringify({type:'user',uuid:id,sessionId:id,cwd:'/tmp/fixture',timestamp:time,message:{role:'user',content:'favoritefixture'}})+'\n');
  await request(env,{op:'refresh'});const saved=(await request(env,{op:'list'})).sessions.find(s=>s.id==='saved');await request(env,{op:'state',key:saved.key,favorite:true});
  assert.equal((await request(env,{op:'search',query:'favoritefixture',limit:1})).hits[0].session.id,'recent');
  const only=(await request(env,{op:'search',query:'favoritefixture',starred:true,limit:1})).hits;assert.ok(only.length>0);assert.ok(only.every(h=>h.session.id==='saved'));
 }finally{await fs.rm(home,{recursive:true,force:true})}
});
