import {queryLocalCollector} from './service';
export type LocalUsageRange = {from:string;to:string;tz?:string};
export type LocalUsagePageData = {
  totals: Record<string,number|string>;
  sources: Array<Record<string,unknown>>;
  firstActivityDay?: string;
};
export async function getLocalUsagePage(range:LocalUsageRange):Promise<LocalUsagePageData>{
  const validDay=(day:string)=>typeof day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10)===day;
  if(!range || (range.from!==''&&!validDay(range.from)) || !validDay(range.to) || range.from>range.to)throw new Error('Invalid usage date range');
  if(range.tz)new Intl.DateTimeFormat('en-US',{timeZone:range.tz});
  const query={from:range.from,to:range.to,tz:range.tz||Intl.DateTimeFormat().resolvedOptions().timeZone};
  // Same collector and aggregation contract as the native menu. Gateway
  // request usage is deliberately not added to these local-session totals.
  const [summary,models,daily]=await Promise.all([
    queryLocalCollector('/functions/tokentracker-usage-summary',query),
    queryLocalCollector('/functions/tokentracker-usage-model-breakdown',query),
    queryLocalCollector('/functions/tokentracker-usage-daily',query)
  ]) as [{totals:LocalUsagePageData['totals']},{sources:LocalUsagePageData['sources']},{data:Array<{day:string;total_tokens:number}>}];
  return {totals:summary.totals,sources:models.sources,firstActivityDay:daily.data.find(row=>Number(row.total_tokens)>0)?.day};
}

export type LocalUsageCategoryRange=LocalUsageRange & {source:'claude'|'codex'|'grok'};
export async function getLocalUsageCategories(range:LocalUsageCategoryRange):Promise<Record<string,unknown>> {
 if(!range||!['claude','codex','grok'].includes(range.source)||!/^\d{4}-\d{2}-\d{2}$/.test(range.to)||(range.from!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(range.from))||range.from>range.to)throw new Error('Invalid context range');
 if(range.tz)new Intl.DateTimeFormat('en',{timeZone:range.tz});
 return queryLocalCollector('/functions/tokentracker-usage-category-breakdown',{from:range.from,to:range.to,source:range.source,tz:range.tz||Intl.DateTimeFormat().resolvedOptions().timeZone}) as Promise<Record<string,unknown>>;
}
