const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const roll = require("../../packages/core/src/vendor/tokentracker/lib/rollout");
const api = require("../../packages/core/src/vendor/tokentracker/lib/session-analytics");
const { computeRowCost, getModelPricing } = require("../../packages/core/src/vendor/tokentracker/lib/pricing");

const stamp = "2026-10-26T12:00:00Z";
const message = (id, total = 150) => ({type:"message", id, timestamp:stamp,
  message:{role:"assistant",model:"gpt-6-astra",timestamp:Date.parse(stamp),usage:{input:total-50,output:50,totalTokens:total}}});
const extra = {type:"model_usage", id:"extra",timestamp:stamp,model:"gpt-6-astra",usage:{input:50,output:20,totalTokens:70}};
const append = (file, rows) => fs.appendFileSync(file, rows.map(JSON.stringify).join("\n")+"\n");
function queueTotal(file) {
  if (!fs.existsSync(file)) return 0;
  const latest = new Map();
  for (const line of fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean)) {
    const row=JSON.parse(line); latest.set(`${row.source}|${row.model}|${row.hour_start}|${row.project_key||""}`,row.total_tokens);
  }
  return [...latest.values()].reduce((a,b)=>a+b,0);
}
async function ompHome(run) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ar-review-omp-"));
  const project=path.join(home,"project");fs.mkdirSync(path.join(project,".git"),{recursive:true});
  fs.writeFileSync(path.join(project,".git/config"),'[remote "origin"]\nurl = https://github.com/fixture/repo.git\n');
  const file=path.join(home,"session.jsonl");
  append(file,[{type:"session",id:"one",cwd:project,timestamp:stamp},message("old")]);
  const options={sessionFiles:[file],cursors:{},queuePath:path.join(home,"queue.jsonl"),projectQueuePath:path.join(home,"project.jsonl"),
    publicRepoResolver:async({projectRef})=>({status:"public_verified",projectKey:"fixture/repo",projectRef})};
  try {await run({home,file,options});}finally{fs.rmSync(home,{recursive:true,force:true});}
}
function legacyCursor(options,file) {
  options.cursors.omp.version=1;
  for(const offsets of [options.cursors.omp.fileOffsets,options.cursors.omp.projectFileOffsets]) {
    if (offsets?.[file]) {delete offsets[file].usageVersion;offsets[file].size=fs.statSync(file).size;}
  }
}

test("OMP migration keeps historical totals, appended messages and newly discovered files",async()=>ompHome(async({home,file,options})=>{
  await roll.parseOmpIncremental(options);
  append(file,[extra]);legacyCursor(options,file); // legacy reader consumed but ignored this record
  append(file,[message("new",80)]);
  const fresh=path.join(home,"fresh.jsonl");append(fresh,[{type:"session",id:"two",cwd:path.join(home,"project"),timestamp:stamp},message("fresh",90)]);
  options.sessionFiles.push(fresh);
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),390,"150 retained + 70 backfill + 80 appended + 90 new file");
  assert.equal(queueTotal(options.projectQueuePath),390);
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),390,"migration is idempotent");
}));

test("OMP project backfill has its own migration state when project collection is enabled later",async()=>ompHome(async({file,options})=>{
  const totalOnly={...options};delete totalOnly.projectQueuePath;
  await roll.parseOmpIncremental(totalOnly);
  append(file,[extra]);legacyCursor(options,file);
  await roll.parseOmpIncremental(totalOnly);
  assert.equal(queueTotal(options.queuePath),220);
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.projectQueuePath),220,"first project scan includes old messages too");
}));

test("OMP waits for an incomplete final JSONL record before committing its offset",async()=>ompHome(async({file,options})=>{
  await roll.parseOmpIncremental(options);
  const tail=JSON.stringify(message("partial",80));
  fs.appendFileSync(file,tail.slice(0,-3));
  await roll.parseOmpIncremental(options);
  fs.appendFileSync(file,tail.slice(-3)+"\n");
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),230);
  assert.equal(queueTotal(options.projectQueuePath),230);
}));

for(const [tier,multiplier] of [["priority",2],["ultrafast",6]]) {
  test(`Codex ${tier} pricing multiplies the actual context tier and survives date filtering`,async()=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),"ar-review-pricing-"));
    try {
      const file=path.join(home,"rollout-2026-10-26T12-00-00-00000000-0000-4000-8000-000000000099.jsonl");
      const input=300000,output=400;
      append(file,[{type:"session_meta",timestamp:stamp,payload:{id:"00000000-0000-4000-8000-000000000099",cwd:"/tmp/project"}},
        {type:"event_msg",timestamp:stamp,payload:{type:"thread_settings_applied",thread_settings:{service_tier:tier}}},
        {type:"turn_context",timestamp:stamp,payload:{model:"gpt-6-astra",turn_id:"one"}},
        {type:"event_msg",timestamp:stamp,payload:{type:"token_count",info:{last_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},total_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output}}}}]);
      const row=await api.scanCodexSession(file);
      const rates=getModelPricing("gpt-6-astra");
      const expected=(input*rates.input*2+output*rates.output*1.5)*multiplier/1e6;
      assert.ok(Math.abs(row.cost_usd-expected)<1e-9,`${row.cost_usd} must equal ${expected}`);
      const day=api.listSessionsForBrowser([row],{from:"2026-10-26",to:"2026-10-26"}).sessions[0];
      assert.equal(day.cost_usd,row.cost_usd);
    } finally{fs.rmSync(home,{recursive:true,force:true});}
  });
}

test("MiMo temporary database read failure preserves the complete inventory and retries without waiting for the TTL",async()=>{
  const {DatabaseSync}=require("node:sqlite");
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ar-review-mimo-"));
  const dbPath=path.join(home,".local/share/mimocode/mimocode.db");fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  try {
    const db=new DatabaseSync(dbPath);
    db.exec("CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
    const payload={role:"assistant",providerID:"mimo",modelID:"mimo-v2.6-pro",path:{cwd:"/tmp/project"},time:{created:Date.parse(stamp),completed:Date.parse(stamp)+1000},tokens:{input:100,output:50}};
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m1","session1",Date.parse(stamp),Date.parse(stamp),JSON.stringify(payload));db.close();
    const initial=await api.buildSessionAnalytics({home,force:true});
    assert.equal(initial.filter(r=>r.source==="mimo").length,1);
    const bytes=fs.readFileSync(dbPath),stat=fs.statSync(dbPath);
    fs.writeFileSync(dbPath,"temporarily unavailable database");
    const failed=await api.buildSessionAnalytics({home,force:true});
    assert.equal(failed.filter(r=>r.source==="mimo")[0]?.total_tokens,150,"last complete rows survive a failed read");
    fs.writeFileSync(dbPath,bytes);fs.utimesSync(dbPath,stat.atime,stat.mtime);
    const recovered=await api.buildSessionAnalytics({home,cacheTtlMs:3600000});
    assert.equal(recovered.filter(r=>r.source==="mimo")[0]?.total_tokens,150);
    assert.equal(recovered.skippedFiles,0,"retry reaches the reader instead of returning a cached empty inventory");
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});


test("OMP project cursor independently replays accounting after a total-only migration",async()=>ompHome(async({file,options})=>{
  await roll.parseOmpIncremental(options);
  append(file,[extra]);legacyCursor(options,file);
  const totalOnly={...options};delete totalOnly.projectQueuePath;
  await roll.parseOmpIncremental(totalOnly);
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),220);
  assert.equal(queueTotal(options.projectQueuePath),220);
}));

test("official Kimi sessions read and invalidate the model configuration in their own install root",async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"ar-review-kimi-"));
  const root=path.join(home,".kimi-code"),file=path.join(root,"sessions/ses_00000000-0000-4000-8000-000000000001/agents/main/wire.jsonl");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const config=path.join(root,"config.toml");
  const writeModel=model=>fs.writeFileSync(config,`default_model = "custom"\n[models."custom"]\nmodel = "${model}"\n`);
  try {
    writeModel("kimi-k2.5");
    append(file,[{type:"context.append_loop_event",time:Date.parse(stamp),event:{type:"step.end",uuid:"one",usage:{inputOther:100,output:50}}}]);
    const rows=await api.buildSessionAnalytics({home,force:true});
    assert.equal(rows.find(r=>r.source==="kimi")?.model,"kimi-k2.5");
    writeModel("gpt-6-astra");
    const updated=await api.buildSessionAnalytics({home,cacheTtlMs:0});
    assert.equal(updated.find(r=>r.source==="kimi")?.model,"gpt-6-astra","a config-only change invalidates the sidecar");
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});


test("OMP accepts a complete final record without LF consistently with the session reader",async()=>ompHome(async({file,options})=>{
  await roll.parseOmpIncremental(options);
  fs.appendFileSync(file,JSON.stringify(message("without-newline",80)));
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),230);
  assert.equal(queueTotal(options.projectQueuePath),230);
  assert.equal((await api.scanOmpSessions([file]))[0].total_tokens,230);
  await roll.parseOmpIncremental(options);
  assert.equal(queueTotal(options.queuePath),230);
}));
