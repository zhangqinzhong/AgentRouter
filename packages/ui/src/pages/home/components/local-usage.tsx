import {memo,useEffect,useMemo,useState} from 'react';
import type {LocalUsagePageData} from '@agentrouter/core/collector/usage-page';
import {CostAnalysisModal} from '@/vendor/tokentracker/ui/dashboard/components/CostAnalysisModal';
import {UsageOverview} from '@/vendor/tokentracker/ui/dashboard/components/UsageOverview';
import {buildFleetData} from '@/vendor/tokentracker/lib/model-breakdown';
import {copy,setUsageLocale} from '@/vendor/tokentracker/lib/copy';
import {useAppText} from '../shared/index';

type Period='day'|'week'|'month'|'total'|'custom';
export function localUsageRange(period:Period, custom:{from:string;to:string}, now=new Date()){
 const day=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 if(period==='custom')return custom;
 const start=new Date(now);const end=new Date(now);
 if(period==='week'){start.setDate(start.getDate()-((start.getDay()+6)%7));end.setTime(start.getTime());end.setDate(start.getDate()+6);}
 if(period==='month'){start.setDate(1);end.setMonth(end.getMonth()+1,0);}
 return {from:period==='total'?'':day(start),to:day(end)};
}
export const LocalUsageView=memo(function LocalUsageView(){
 const t=useAppText();const locale=t('Usage')==='用量'?'zh':'en';setUsageLocale(locale);
 const [period,setPeriod]=useState<Period>('total');
 const [custom,setCustom]=useState(()=>localUsageRange('day',{from:'',to:''}));
 const [costOpen,setCostOpen]=useState(false);
 const [calendarOpen,setCalendarOpen]=useState(false);
 const [result,setResult]=useState<{key:string;data:LocalUsagePageData}>();const [error,setError]=useState('');const [loading,setLoading]=useState(true);
 const [revision,setRevision]=useState(0);const [full,setFull]=useState(false);
 const range=localUsageRange(period,custom);
 const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const rangeKey=JSON.stringify([range.from,range.to,tz]);
 const data=result?.key===rangeKey?result.data:undefined;
 useEffect(()=>{let active=true;setLoading(true);setError('');
   const api=window.agentrouter;
   if(!api?.getLocalUsagePage){setError(t('Local usage data is unavailable.'));setLoading(false);return;}
   void api.getLocalUsagePage({...range,tz}).then(data=>{if(active)setResult({key:rangeKey,data})}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(active)setLoading(false)});
   return()=>{active=false};
 },[rangeKey,revision]);
 useEffect(()=>{const timer=setInterval(()=>setRevision(v=>v+1),60000);return()=>clearInterval(timer)},[]);
 const fleet=useMemo(()=>buildFleetData({sources:data?.sources??[]},{copyFn:copy}),[data,locale]);
 const tokens=Number(data?.totals.billable_total_tokens??data?.totals.total_tokens??0);
 const display=full?tokens.toLocaleString(locale==='zh'?'zh-CN':'en-US'):tokens>=1e9?`${(tokens/1e9).toFixed(1)}B`:tokens>=1e6?`${(tokens/1e6).toFixed(1)}M`:tokens>=1e3?`${(tokens/1e3).toFixed(1)}K`:String(tokens);
 return <div className="local-usage-page mx-auto w-full max-w-[1120px] px-5 py-6 sm:px-9 sm:py-8">
   <h1 className="mb-8 text-[24px] font-semibold tracking-[-0.025em]">{t('Usage')}</h1>
   {error ? <div role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={()=>setRevision(v=>v+1)}>{t('Retry')}</button></div>:null}
   <UsageOverview period={period} periods={['day','week','month','total','custom']} onPeriodChange={value=>{if(value==='custom'){setCalendarOpen(true);return;}setPeriod(value as Period)}}
    summaryValue={display} summaryFullValue={tokens.toLocaleString()} onToggleSummaryFormat={()=>setFull(v=>!v)} summaryLabel={locale==='zh'?'TOKEN 总数':'TOTAL TOKENS'}
    summaryCostValue={data?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(data.totals.total_cost_usd??0)):''}
    onCostInfo={()=>setCostOpen(true)}
    fleetData={fleet} onRefresh={()=>setRevision(v=>v+1)} loading={loading} summaryLoading={loading||(!data&&!error)} providersLoading={loading||(!data&&!error)} hasSummary={!!data}
    from={period==='total'?(data?.firstActivityDay??range.to):range.from} to={range.to} customFrom={custom.from} customTo={custom.to}
    customRangeOpen={calendarOpen} onCustomRangeOpenChange={setCalendarOpen} onCustomRangeApply={(from,to)=>{setCustom({from,to});setPeriod('custom');setCalendarOpen(false)}}/>
   <CostAnalysisModal isOpen={costOpen} onClose={()=>setCostOpen(false)} fleetData={fleet}/>
 </div>;
});
