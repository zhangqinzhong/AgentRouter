import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {queryLocalCollector} from './service';
export type LocalUsageRange = {from:string;to:string;tz?:string};
export type LocalUsagePeriod = 'day'|'week'|'month'|'year'|'total'|'custom';
export type LocalUsagePageData = {
  totals: Record<string,number|string>;
  sources: Array<Record<string,unknown>>;
  firstActivityDay?: string;
};
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

export async function getLocalUsagePage(range:LocalUsageRange):Promise<LocalUsagePageData>{
  if(!range || (range.from!==''&&!validDay(range.from)) || !validDay(range.to) || range.from>range.to)throw new Error('Invalid usage date range');
  const query={from:range.from,to:range.to,tz:zone(range.tz)};
  // Same collector and aggregation contract as the native menu. Gateway
  // request usage is deliberately not added to these local-session totals.
  const [summary,models,daily]=await Promise.all([
    queryLocalCollector('/functions/tokentracker-usage-summary',query),
    queryLocalCollector('/functions/tokentracker-usage-model-breakdown',query),
    queryLocalCollector('/functions/tokentracker-usage-daily',query)
  ]) as [{totals:LocalUsagePageData['totals']},{sources:LocalUsagePageData['sources']},{data:Array<{day:string;total_tokens:number}>}];
  return {totals:summary.totals,sources:models.sources,firstActivityDay:daily.data.find(row=>Number(row.total_tokens)>0)?.day};
}

export async function getLocalUsageTrend(query:LocalUsageTrendQuery):Promise<Record<string,unknown>>{
  if(!query||!['day','week','month','year','total','custom'].includes(query.period))throw new Error('Invalid usage trend period');
  const tz=zone(query.tz);
  if(query.period==='day'){
    const day=query.day||query.to;
    if(!validDay(day))throw new Error('Invalid usage date range');
    return queryLocalCollector('/functions/tokentracker-usage-hourly',{day,tz}) as Promise<Record<string,unknown>>;
  }
  const to=query.to||'';
  if(!validDay(to))throw new Error('Invalid usage date range');
  if(query.period==='year'||query.period==='total'){
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
