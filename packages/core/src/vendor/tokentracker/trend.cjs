'use strict';
// One range/aggregation contract for the React trend page and native menu.
const durations={day:86400000,week:7*86400000,month:30*86400000,year:365*86400000};
const dayKey=(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function hourKey(d,tz){const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(d);const v=t=>p.find(x=>x.type===t).value;return `${v('year')}-${v('month')}-${v('day')}T${v('hour')}:00:00`}
async function queryTrend(query,read,now=new Date()){
 const {period}=query,tz=query.tz||Intl.DateTimeFormat().resolvedOptions().timeZone;
 if(!['day','week','month','year','total','custom'].includes(period))throw Error('Invalid usage trend period');
 let from='',to=dayKey(now,tz),since;
 if(durations[period]){since=new Date(now.getTime()-durations[period]).toISOString();from=dayKey(new Date(since),tz)}
 else if(period==='custom'){
  from=query.from;to=query.to;
  const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  if(!valid(from)||!valid(to)||from>to)throw Error('Invalid usage date range');
 }
 const params={from,to,tz,...(since?{since}:{})};
 const views={summary:'summary',models:'model-breakdown',projects:'project-usage-summary'};
 if(query.view){if(!views[query.view])throw Error('Invalid trend view');return read('/functions/tokentracker-'+(query.view==='projects'?'project-usage-summary':'usage-'+views[query.view]),params)}
 const grain=period==='day'?'hour':period==='total'||period==='year'?'month':'day';
 const endpoint='/functions/tokentracker-usage-'+({hour:'hourly',day:'daily',month:'monthly'}[grain]);
 const response=await read(endpoint,params);
 const rows=Array.isArray(response.data)?response.data:[];
 if(grain==='hour'){from=hourKey(new Date(Math.floor(Date.parse(since)/3600000)*3600000),tz);to=hourKey(now,tz)}
 if(period==='total')from=rows.map(r=>String(r.month||'')).filter(Boolean).sort()[0]?.concat('-01')||to.slice(0,7)+'-01';
 const byKey=new Map(rows.map(r=>[r[grain],r]));const data=[];
 // Enumerate timezone-local labels, retaining empty buckets and true dates.
 const start=Date.parse((grain==='hour'?from:grain==='month'?from.slice(0,7)+'-01T00:00:00':from+'T00:00:00')+'Z');
 const end=Date.parse((grain==='hour'?to:grain==='month'?to.slice(0,7)+'-01T00:00:00':to+'T00:00:00')+'Z');
 for(let d=new Date(start);d.getTime()<=end;){
  const stamp=d.toISOString();const key=grain==='hour'?stamp.slice(0,19):grain==='month'?stamp.slice(0,7):stamp.slice(0,10);
  data.push(byKey.get(key)||{[grain]:key,total_tokens:0,billable_total_tokens:0});
  if(grain==='month')d.setUTCMonth(d.getUTCMonth()+1);else d=new Date(d.getTime()+(grain==='hour'?3600000:86400000));
 }
 return {from,to,period,generatedAt:now.toISOString(),data};
}
module.exports={queryTrend};
