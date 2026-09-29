import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {queryLocalCollector} from './service';
export type LocalUsageRange = {from:string;to:string;tz?:string;since?:string};
export type LocalUsagePeriod = 'day'|'week'|'month'|'year'|'total'|'custom';
export type LocalUsagePageData = {
  totals: Record<string,number|string>;
  sources: Array<Record<string,unknown>>;
  firstActivityDay?: string;
};
export type LocalUsageOverviewPeriod = "day" | "hour";
export type LocalUsageOverviewData = LocalUsagePageData & {
  series: Array<Record<string,unknown>>;
};
export const LOCAL_OVERVIEW_SOURCE_KEYS = [
  'acode','every-code','openclaw','lmstudio','cursor','antigravity',
  'qoder','qoder-cn','claude-science','kiro','kiro-cli','hermes',
  'kimi','kimi-code','codebuddy','workbuddy','omp','pi','prime-agent',
  'craft','reasonix','kilocode','roocode','zed','unsloth','anythingllm',
  'devin','goose','droid','dsh','copilot','mimo','zcode'
] as const;
export type LocalUsageTrendQuery = LocalUsageRange & {
  period: LocalUsagePeriod;
  day?: string;
  months?: number;
};
export type LocalUsageHeatmapQuery = {weeks?:number;tz?:string};
export type LocalUsageProfile = {displayName:string;username:string;avatar:string|null};

function localUsageProfile():LocalUsageProfile{
  let username='user';
  try{username=os.userInfo().username||process.env.USER||'user';}catch{username=process.env.USER||'user';}
  let displayName=username;
  let avatar:string|null=null;
  if(process.platform==='darwin'){
    try{
      const raw=execFileSync('dscl',['.','-read',`/Users/${username}`,'RealName'],{encoding:'utf8',timeout:2000});
      const name=raw.replace(/^RealName:\s*/u,'').split('\n').map((line)=>line.trim()).filter(Boolean).at(-1);
      if(name)displayName=name;
    }catch{/* keep username */}
    try{
      const raw=execFileSync('dscl',['.','-read',`/Users/${username}`,'JPEGPhoto'],{encoding:'utf8',timeout:2000,maxBuffer:6*1024*1024});
      const hex=raw.replace(/^JPEGPhoto:\s*/u,'').replace(/[^0-9a-fA-F]/g,'');
      if(hex.length>=8&&hex.length%2===0)avatar=`data:image/jpeg;base64,${Buffer.from(hex,'hex').toString('base64')}`;
    }catch{/* initials fallback in UI */}
  }
  return {displayName,username,avatar};
}
export type LocalUsageSessionsQuery = {from?:string;to?:string;tz?:string;refresh?:boolean;limit?:number};

const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
function validDay(day:string){
  return typeof day==='string' && dayPattern.test(day) && Number.isFinite(Date.parse(day)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day;
}
function zone(tz?:string){
  const value=tz||Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat('en-US',{timeZone:value});
  return value;
}
function shiftMonth(day:string,delta:number){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if(!match)return day;
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1+delta,Number(match[3])));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
function listDays(from:string,to:string){
  const start=new Date(`${from}T00:00:00Z`);
  const end=new Date(`${to}T00:00:00Z`);
  const days:string[]=[];
  for(let cursor=start;cursor<=end;cursor.setUTCDate(cursor.getUTCDate()+1)){
    days.push(cursor.toISOString().slice(0,10));
  }
  return days;
}

// Rolling windows share the Overview page's semantics: a period ends at "now"
// and starts an exact duration earlier, never at a calendar boundary. `since`
// is an absolute ISO instant the collector cuts rows at; `from`/`to` are the
// calendar days (in the target time zone) that contain the window and only
// drive bucket enumeration.
const rollingPeriodMs:Record<string,number>={
  day:24*3600_000,
  week:7*24*3600_000,
  month:30*24*3600_000,
  year:365*24*3600_000
};
function dayKeyInTz(date:Date,tz:string){
  return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
// "YYYY-MM-DDTHH:00:00" in the target time zone — the same key shape the
// collector's hourly endpoint emits, so chart axes and rows compare directly.
export function hourKeyInTz(date:Date,tz:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const value=(type:string)=>parts.find(part=>part.type===type)?.value??'00';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:00:00`;
}
export function rollingWindow(period:LocalUsagePeriod,tz:string,now:Date=new Date()):{since:string;from:string;to:string}|null{
  const ms=rollingPeriodMs[period];
  if(!ms)return null;
  const since=new Date(now.getTime()-ms);
  return {since:since.toISOString(),from:dayKeyInTz(since,tz),to:dayKeyInTz(now,tz)};
}

export async function getLocalUsagePage(range:LocalUsageRange):Promise<LocalUsagePageData>{
  if(!range || (range.from!==''&&!validDay(range.from)) || !validDay(range.to) || range.from>range.to)throw new Error('Invalid usage date range');
  if(range.since!==undefined&&range.since!==''&&!Number.isFinite(Date.parse(range.since)))throw new Error('Invalid usage date range');
  const query={from:range.from,to:range.to,tz:zone(range.tz),...(range.since?{since:range.since}:{})};
  // Same collector and aggregation contract as the native menu. Gateway
  // request usage is deliberately not added to these local-session totals.
  const [summary,models,daily]=await Promise.all([
    queryLocalCollector('/functions/tokentracker-usage-summary',query),
    queryLocalCollector('/functions/tokentracker-usage-model-breakdown',query),
    queryLocalCollector('/functions/tokentracker-usage-daily',query)
  ]) as [{totals:LocalUsagePageData['totals']},{sources:LocalUsagePageData['sources']},{data:Array<{day:string;total_tokens:number}>}];
  return {totals:summary.totals,sources:models.sources,firstActivityDay:daily.data.find(row=>Number(row.total_tokens)>0)?.day};
}

export async function getLocalUsageOverview(range:LocalUsageRange, period:LocalUsageOverviewPeriod):Promise<LocalUsageOverviewData>{
  if(!range || (range.from!==''&&!validDay(range.from)) || !validDay(range.to) || range.from>range.to)throw new Error('Invalid usage date range');
  const query={from:range.from,to:range.to,tz:zone(range.tz)};
  const overviewQuery={...query,source:LOCAL_OVERVIEW_SOURCE_KEYS.join(",")};
  const [summary,models,series] = await Promise.all([
    queryLocalCollector('/functions/tokentracker-usage-summary',overviewQuery),
    queryLocalCollector('/functions/tokentracker-usage-model-breakdown',overviewQuery),
    period==='hour'
      ? Promise.all(listDays(range.from,range.to).map((day)=>queryLocalCollector('/functions/tokentracker-usage-hourly',{day,tz:query.tz,source:LOCAL_OVERVIEW_SOURCE_KEYS.join(",")}) as Promise<Record<string,unknown>>)).then((responses)=>({
          data:responses.flatMap((response)=>Array.isArray(response?.data)?response.data:[])
        }))
      : queryLocalCollector('/functions/tokentracker-usage-daily',overviewQuery)
  ]) as [
    {totals:LocalUsagePageData['totals']},
    {sources:LocalUsagePageData['sources']},
    {data:Array<Record<string,unknown>>}
  ];
  return {totals:summary.totals,sources:models.sources,series:series.data};
}

// A rolling "day" spans two calendar days, so its hour buckets keep their real
// date-time keys and the axis bounds are datetimes (window start hour → current
// hour). Folding them onto the current day's clock hours would make the UI's
// future-hour filter discard yesterday's tail, which is real in-window data.
export async function getLocalUsageTrend(query:LocalUsageTrendQuery):Promise<Record<string,unknown>>{
  if(!query||!['day','week','month','year','total','custom'].includes(query.period))throw new Error('Invalid usage trend period');
  const tz=zone(query.tz);
  // day/week/month/year are rolling windows ending at "now"; the window is
  // derived here so the UI cannot drift from the Overview page's semantics.
  const window=rollingWindow(query.period,tz);
  if(query.period==='day'&&window){
    const today=window.to;
    const previous=window.from;
    const responses=await Promise.all(
      (previous===today?[today]:[previous,today]).map((day)=>queryLocalCollector('/functions/tokentracker-usage-hourly',{day,tz,since:window.since}) as Promise<Record<string,unknown>>)
    );
    const rows=responses
      .flatMap((response)=>Array.isArray(response?.data)?response.data:[])
      .sort((left,right)=>String(left.hour??'').localeCompare(String(right.hour??'')));
    const now=new Date();
    const startKey=rows.length?`${String(rows[0].hour??'').slice(0,13)}:00:00`:hourKeyInTz(now,tz);
    return {day:today,from:startKey,to:hourKeyInTz(now,tz),data:rows};
  }
  if(query.period==='week'||query.period==='month'){
    if(!window)throw new Error('Invalid usage trend period');
    return queryLocalCollector('/functions/tokentracker-usage-daily',{from:window.from,to:window.to,tz,since:window.since}) as Promise<Record<string,unknown>>;
  }
  if(query.period==='year'){
    if(!window)throw new Error('Invalid usage trend period');
    return queryLocalCollector('/functions/tokentracker-usage-monthly',{from:window.from,to:window.to,tz,since:window.since}) as Promise<Record<string,unknown>>;
  }
  const to=query.to||'';
  if(!validDay(to))throw new Error('Invalid usage date range');
  if(query.period==='total'){
    const months=Number.isFinite(query.months)&&Number(query.months)>0?Math.min(Math.floor(Number(query.months)),120):24;
    const from=query.from&&validDay(query.from)?query.from:shiftMonth(to,-(months-1));
    return queryLocalCollector('/functions/tokentracker-usage-monthly',{from,to,tz}) as Promise<Record<string,unknown>>;
  }
  if((query.from!==''&&!validDay(query.from))||query.from>to)throw new Error('Invalid usage date range');
  return queryLocalCollector('/functions/tokentracker-usage-daily',{from:query.from,to,tz}) as Promise<Record<string,unknown>>;
}

export async function getLocalUsageHeatmap(query:LocalUsageHeatmapQuery={}):Promise<Record<string,unknown>>{
  const weeks=Number.isFinite(query.weeks)?Math.floor(Number(query.weeks)):52;
  if(weeks<1||weeks>104)throw new Error('Invalid heatmap range');
  const heatmap=await queryLocalCollector('/functions/tokentracker-usage-heatmap',{weeks:String(weeks),tz:zone(query.tz)}) as Record<string,unknown>;
  return {...heatmap,profile:localUsageProfile()};
}

export async function getLocalUsageSessions(query:LocalUsageSessionsQuery={}):Promise<Record<string,unknown>>{
  if(query.from&&!validDay(query.from))throw new Error('Invalid usage date range');
  if(query.to&&!validDay(query.to))throw new Error('Invalid usage date range');
  if(query.from&&query.to&&query.from>query.to)throw new Error('Invalid usage date range');
  const params:Record<string,string>={tz:zone(query.tz)};
  if(query.from)params.from=query.from;
  if(query.to)params.to=query.to;
  if(query.refresh)params.refresh='1';
  if(Number.isFinite(query.limit)&&Number(query.limit)>0)params.limit=String(Math.min(Math.floor(Number(query.limit)),2000));
  return queryLocalCollector('/functions/tokentracker-sessions',params) as Promise<Record<string,unknown>>;
}

export type LocalUsageCategoryRange=LocalUsageRange & {source:'claude'|'codex'|'grok'};
export async function getLocalUsageCategories(range:LocalUsageCategoryRange):Promise<Record<string,unknown>> {
 if(!range||!['claude','codex','grok'].includes(range.source)||!/^\d{4}-\d{2}-\d{2}$/.test(range.to)||(range.from!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(range.from))||range.from>range.to)throw new Error('Invalid context range');
 if(range.tz)new Intl.DateTimeFormat('en',{timeZone:range.tz});
 return queryLocalCollector('/functions/tokentracker-usage-category-breakdown',{from:range.from,to:range.to,source:range.source,tz:range.tz||Intl.DateTimeFormat().resolvedOptions().timeZone}) as Promise<Record<string,unknown>>;
}
