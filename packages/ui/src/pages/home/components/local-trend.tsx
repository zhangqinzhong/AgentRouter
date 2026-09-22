import {DEFAULT_PAGE_RANGES} from "@agentrouter/core/config/page-default-ranges";
import type {PageDefaultRanges} from "@agentrouter/core/contracts/app";
import {memo,useMemo,useState} from 'react';
import {copy} from '@/vendor/tokentracker/lib/copy';
import {formatUsdCurrency} from '@/vendor/tokentracker/lib/format';
import {formatTokenCount,formatTokenTooltip} from '@/vendor/tokentracker/lib/token-format';
import {computeZoomStats,getTrendInsightKey} from '@/vendor/tokentracker/lib/trend-stats';
import {formatTimeZoneLabel,getBrowserTimeZone,getBrowserTimeZoneOffsetMinutes} from '@/vendor/tokentracker/lib/timezone';
import {useTrendData} from '@/vendor/tokentracker/hooks/use-trend-data';
import {useAppNumberLocale,useAppText} from '../shared/index';
import {heatmapTrendRange,TrendPeriod,TrendPeriodTabs,UsageTrendLineChart} from './usage-trend-line';

function StatCell({label,value,sub,title}:{label:string;value:string;sub?:string;title?:string}){
 return (
  <div className="flex min-w-0 flex-col gap-1.5">
   <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
   <span className="text-xl font-semibold tabular-nums tracking-tight" title={title}>{value}</span>
   {sub?<span className="text-[10px] tabular-nums text-muted-foreground">{sub}</span>:null}
  </div>
 );
}

export const LocalTrendView=memo(function LocalTrendView({defaultRange=DEFAULT_PAGE_RANGES.trend}:{defaultRange?:PageDefaultRanges["trend"]}){
 const t=useAppText();const numberLocale=useAppNumberLocale();
 const [period,setPeriod]=useState<TrendPeriod>(defaultRange);
 const [custom,setCustom]=useState(()=>heatmapTrendRange('day'));
 const [calendarOpen,setCalendarOpen]=useState(false);
 const timeZone=getBrowserTimeZone()||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const range=useMemo(()=>heatmapTrendRange(period,custom),[custom,period]);
 const trend=useTrendData({period,from:range.from,to:range.to,timeZone,tzOffsetMinutes:getBrowserTimeZoneOffsetMinutes()});
 const stats=useMemo(()=>computeZoomStats(trend.rows),[trend.rows]);
 const peakLabel=typeof stats.peak==='object'&&stats.peak&&'label'in stats.peak?String((stats.peak as {label?:string}).label||''):'';
 return (
  <div className="local-usage-page mx-auto w-full max-w-[1120px] px-5 py-6 sm:px-9 sm:py-8">
   <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div>
     <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">{copy('trend.zoom.badge')}</p>
     <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.025em]">{t('Trend')}</h1>
     <p className="mt-1 font-mono text-[11px] text-muted-foreground">{formatTimeZoneLabel({timeZone,offsetMinutes:getBrowserTimeZoneOffsetMinutes()})}</p>
    </div>
    <div className="relative">
     <TrendPeriodTabs
      period={period}
      customRange={custom}
      customRangeOpen={calendarOpen}
      onCustomRangeOpenChange={setCalendarOpen}
      onCustomRangeApply={(from:string,to:string)=>setCustom({from,to})}
      onPeriodChange={setPeriod}
     />
    </div>
   </div>
   <div className="mb-6 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-4">
    <StatCell label={copy('trend.zoom.stats.tokens')} value={formatTokenCount(Number(stats.totalTokens)||0)} title={formatTokenTooltip(Number(stats.totalTokens)||0)}/>
    {stats.totalCostUsd!=null?<StatCell label={copy('trend.zoom.stats.cost')} value={formatUsdCurrency(stats.totalCostUsd)}/>:null}
    <StatCell label={copy('trend.zoom.stats.conversations')} value={Number(stats.conversationCount||0).toLocaleString(numberLocale)}/>
    {stats.peak&&typeof stats.peak==='object'?<StatCell label={copy('trend.zoom.stats.peak')} value={formatTokenCount(Number((stats.peak as {value?:number}).value)||0)} title={formatTokenTooltip(Number((stats.peak as {value?:number}).value)||0)} sub={peakLabel.slice(0,16)}/>:null}
   </div>
   <p className="mb-8 border-l-2 border-emerald-500 pl-3 text-[13px] leading-relaxed text-muted-foreground">
    {copy(getTrendInsightKey(stats),{active:stats.activeBuckets,peak:formatTokenCount(Number((stats.peak as {value?:number}|undefined)?.value)||0)})}
   </p>
   <UsageTrendLineChart
    period={period}
    onPeriodChange={setPeriod}
    rows={trend.rows as Array<Record<string,unknown>>}
    loading={trend.loading}
    from={range.from}
    to={range.to}
    size="full"
    showHeader={false}
   />
  </div>
 );
});
