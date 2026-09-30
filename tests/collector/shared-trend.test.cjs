const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {queryTrend}=require('../../packages/core/src/vendor/tokentracker/trend.cjs');
const {queryOffline}=require('../../packages/core/src/vendor/tokentracker/lib/offline-api');
test('shared trend uses rolling days and all history, with the same totals as its summary',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ar-shared-trend-'));
 try{
  const qp=path.join(dir,'queue.jsonl');
  const dates=['2020-01-01T02:00:00Z','2026-08-31T01:00:00Z','2026-08-31T03:00:00Z','2026-09-23T01:00:00Z','2026-09-23T03:00:00Z','2026-09-29T01:00:00Z','2026-09-29T03:00:00Z','2026-09-30T02:00:00Z'];
  await fs.writeFile(qp,dates.map(hour_start=>JSON.stringify({source:'claude',model:'fixture',hour_start,input_tokens:100,total_tokens:100})).join('\n')+'\n');
  const read=(endpoint,q)=>queryOffline(qp,endpoint,q);const now=new Date('2026-09-30T02:35:00Z');
  for(const [period,expected,count] of [['day',200,25],['week',400,8],['month',600,31],['total',800,81]]){
   const result=await queryTrend({period,tz:'Asia/Shanghai'},read,now);
   const summary=await queryTrend({period,tz:'Asia/Shanghai',view:'summary'},read,now);
   assert.equal(result.data.reduce((n,r)=>n+r.total_tokens,0),expected,period);
   assert.equal(summary.totals.total_tokens,expected,period+' summary');
   assert.equal(result.data.length,count,period+' axis');
   if(period==='day')assert.deepEqual([result.from,result.to],['2026-09-29T10:00:00','2026-09-30T10:00:00']);
   if(period==='total')assert.equal(result.from,'2020-01-01');
  }
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('empty shared day trend retains the complete cross-midnight axis',async()=>{
 const result=await queryTrend({period:'day',tz:'Asia/Shanghai'},async()=>({data:[]}),new Date('2026-09-29T16:05:00Z'));
 assert.equal(result.data.length,25);assert.equal(result.data[0].hour,'2026-09-29T00:00:00');assert.equal(result.data.at(-1).hour,'2026-09-30T00:00:00');
});
