import {useEffect,useId,useMemo,useRef} from 'react';
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {getModelColor,mergeModelSegments} from '@/vendor/tokentracker/ui/dashboard/components/TrendMonitor';
import {PeriodRangeTabs} from '@/vendor/tokentracker/ui/dashboard/components/PeriodRangeTabs';
import {copy,getCopyLocale} from '@/vendor/tokentracker/lib/copy';
import {formatUsdCurrency} from '@/vendor/tokentracker/lib/format';
import {modelDisplayName} from '@/vendor/tokentracker/lib/model-display';
import {formatTokenCount,formatTokenTooltip} from '@/vendor/tokentracker/lib/token-format';
import {formatBucketRange,formatTickLabel,granularityFromPeriod} from '@/vendor/tokentracker/lib/trend-stats';
import {useAppText} from '../shared/index';
import {localUsageRange} from './local-usage';

export type TrendPeriod='day'|'week'|'month'|'year'|'total'|'custom';
type TrendRow=Record<string,unknown>;

const PERIODS:TrendPeriod[]=['day','week','month','year','total','custom'];
const LINE='#007aff';
const WEEKDAYS=['mon','tue','wed','thu','fri','sat','sun'] as const;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'] as const;

function pad(value:number){return String(value).padStart(2,'0');}
function dayKey(date:Date){return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;}
function parseDay(value:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
 if(!match)return null;
 return new Date(Number(match[1]),Number(match[2])-1,Number(match[3]));
}
function addDays(date:Date,count:number){
 const next=new Date(date);
 next.setDate(next.getDate()+count);
 return next;
}
function monthKey(date:Date){return `${date.getFullYear()}-${pad(date.getMonth()+1)}`;}
function shiftMonths(date:Date,delta:number){
 return new Date(date.getFullYear(),date.getMonth()+delta,1);
}
function daysInclusive(from:string,to:string){
 const start=parseDay(from);
 const end=parseDay(to);
 if(!start||!end)return 0;
 return Math.round((end.getTime()-start.getTime())/86400000)+1;
}

export function trendAxisGrain(period:TrendPeriod,from='',to=''){
 if(period==='custom')return daysInclusive(from,to)>62?'monthly':'daily';
 return granularityFromPeriod(period);
}

function compactMonthLabel(key:string,locale:string){
 const match=/^(\d{4})-(\d{2})$/.exec(key);
 if(!match)return key;
 const month=Number(match[2]);
 if(locale.startsWith('zh'))return month===1?`${match[1]}年`:`${month}月`;
 const names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 return month===1?match[1]:names[month-1];
}

function fillMonthPoints(
 byMonth:Map<string,TrendRow>,
 start:Date,
 end:Date,
 locale:string,
 compact:boolean
){
 const points:{label:string;tokens:number;row:TrendRow}[]=[];
 for(let cursor=shiftMonths(start,0);cursor<=shiftMonths(end,0);cursor=shiftMonths(cursor,1)){
  const key=monthKey(cursor);
  const row=byMonth.get(key);
  points.push({
   label:compact?compactMonthLabel(key,locale):formatTickLabel({month:key},'monthly',locale),
   tokens:rowTokens(row),
   row:{...(row||{}),month:key}
  });
 }
 return points;
}

function rowTokens(row:TrendRow|undefined){
 const value=Number(row?.billable_total_tokens??row?.total_tokens??0);
 return Number.isFinite(value)&&value>0?value:0;
}

function addTokenRows(left:TrendRow|undefined,right:TrendRow):TrendRow{
 if(!left)return right;
 const models={...(left.models&&typeof left.models==='object'?left.models as Record<string,number>:{}),...(right.models&&typeof right.models==='object'?right.models as Record<string,number>:{})};
 return {
  ...left,
  ...right,
  total_tokens:rowTokens(left)+rowTokens(right),
  billable_total_tokens:Number(left.billable_total_tokens||0)+Number(right.billable_total_tokens||0),
  conversation_count:Number(left.conversation_count||0)+Number(right.conversation_count||0),
  total_cost_usd:Number(left.total_cost_usd||0)+Number(right.total_cost_usd||0),
  models
 };
}

function indexTrendRows(rows:TrendRow[]){
 const byHour=new Map<string,TrendRow>();
 const byDay=new Map<string,TrendRow>();
 const byMonth=new Map<string,TrendRow>();
 for(const row of rows){
  if(!row||row.future)continue;
  const hour=String(row.hour||row.label||'');
  const hourMatch=/(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(hour);
  if(hourMatch)byHour.set(`${hourMatch[1]}T${hourMatch[2]}`,addTokenRows(byHour.get(`${hourMatch[1]}T${hourMatch[2]}`),row));
  const day=String(row.day||hourMatch?.[1]||'').slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}$/.test(day)){
   byDay.set(day,addTokenRows(byDay.get(day),row));
   byMonth.set(day.slice(0,7),addTokenRows(byMonth.get(day.slice(0,7)),row));
  }
  const month=String(row.month||'').slice(0,7);
  if(/^\d{4}-\d{2}$/.test(month))byMonth.set(month,addTokenRows(byMonth.get(month),row));
 }
 return {byHour,byDay,byMonth};
}

export function completeTrendPoints(rows:TrendRow[],period:TrendPeriod,from:string,to:string){
 const {byHour,byDay,byMonth}=indexTrendRows(Array.isArray(rows)?rows:[]);
 const locale=getCopyLocale();
 const start=parseDay(from)||new Date();
 const end=parseDay(to)||start;
 const points:{label:string;tokens:number;row:TrendRow}[]=[];
 if(period==='day'){
  const day=from||to||dayKey(new Date());
  for(let hour=0;hour<24;hour+=1){
   const key=`${day}T${pad(hour)}`;
   const row=byHour.get(key);
   points.push({label:String(hour),tokens:rowTokens(row),row:row||{hour:`${key}:00:00`,day}});
  }
  return points;
 }
 if(period==='year'){
  const year=(from||to||dayKey(new Date())).slice(0,4);
  for(let month=1;month<=12;month+=1){
   const key=`${year}-${pad(month)}`;
   const row=byMonth.get(key);
   points.push({label:copy(`heatmap.month.${MONTHS[month-1]}`),tokens:rowTokens(row),row:row||{month:key}});
  }
  return points;
 }
 if(period==='total'||(period==='custom'&&trendAxisGrain(period,from,to)==='monthly')){
  const last=end;
  const first=period==='total'&&!from?shiftMonths(last,-23):start;
  return fillMonthPoints(byMonth,first,last,locale,true);
 }
 let cursor=new Date(start);
 let index=0;
 while(cursor<=end){
  const key=dayKey(cursor);
  const row=byDay.get(key);
  const label=period==='week'?copy(`heatmap.day.${WEEKDAYS[index]||'mon'}`):period==='custom'?formatTickLabel({day:key},'daily',locale):String(cursor.getDate());
  points.push({label,tokens:rowTokens(row),row:row||{day:key}});
  cursor=addDays(cursor,1);
  index+=1;
 }
 return points;
}

export function trendChartPoints(rows:TrendRow[],period:TrendPeriod,from='' ,to=''){
 if(from||to)return completeTrendPoints(rows,period,from,to);
 return completeTrendPoints(rows,period,to,to);
}

function TrendHoverTooltip({
 active,
 payload,
 period,
 grain
}:{
 active?:boolean;
 payload?:Array<{payload:{tokens:number;row:TrendRow}}>;
 period:TrendPeriod;
 grain:'hourly'|'daily'|'monthly';
}){
 if(!active||!payload?.[0])return null;
 const point=payload[0].payload;
 const row=point.row;
 const tokens=point.tokens;
 const timeLabel=formatBucketRange(row,grain||granularityFromPeriod(period),getCopyLocale());
 const segments=mergeModelSegments(row.models).map((segment)=>({...segment,name:modelDisplayName(segment.name)}));
 const cost=row.total_cost_usd;
 const conversations=Number(row.conversation_count)||0;
 const requests=Number(row.total_requests)||0;
 return (
  <div className="max-w-[280px] min-w-[220px] rounded-xl border border-oai-gray-200/50 bg-white/95 p-3.5 shadow-xl backdrop-blur-md dark:border-oai-gray-800/50 dark:bg-oai-gray-900/95">
   <div className="border-b border-oai-gray-100 pb-1.5 text-[11px] font-semibold text-oai-gray-500 dark:border-oai-gray-800/80 dark:text-oai-gray-400">{timeLabel}</div>
   <div className="mt-2 flex items-baseline gap-1">
    <span className="text-lg font-bold leading-none text-oai-gray-900 dark:text-white" title={formatTokenTooltip(tokens)}>{formatTokenCount(tokens)}</span>
    <span className="text-[10px] font-semibold uppercase tracking-wider text-oai-gray-400">{copy('heatmap.unit.tokens')}</span>
   </div>
   {(cost!=null||conversations>0||requests>0)&&(
    <div className="mt-2 flex items-center gap-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
     {cost!=null?<span><span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">{formatUsdCurrency(cost)}</span> {copy('trend.zoom.tooltip.cost')}</span>:null}
     {conversations>0?<span><span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">{conversations.toLocaleString(getCopyLocale())}</span> {copy('trend.zoom.tooltip.conversations')}</span>:null}
     {conversations<=0&&requests>0?<span><span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">{requests.toLocaleString(getCopyLocale())}</span> {copy('trend.zoom.tooltip.requests')}</span>:null}
    </div>
   )}
   {segments.length>0?(
    <div className="mt-2 flex max-h-[150px] flex-col gap-1.5 overflow-y-auto border-t border-oai-gray-100 pt-2 dark:border-oai-gray-800/60">
     <div className="text-[10px] font-semibold uppercase tracking-wider text-oai-gray-400">{copy('heatmap.tooltip.model_breakdown')}</div>
     {segments.map((segment)=>{
      const pct=Math.round((segment.value/tokens)*100);
      const color=getModelColor(segment.name);
      return (
       <div key={segment.name} className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3 text-[11px]">
         <span className="max-w-[130px] truncate font-medium text-oai-gray-700 dark:text-oai-gray-200" title={segment.name}>{segment.name}</span>
         <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono font-semibold text-oai-gray-900 dark:text-oai-gray-100" title={formatTokenTooltip(segment.value)}>{formatTokenCount(segment.value)}</span>
          <span className="min-w-[28px] text-right text-[9px] font-medium text-oai-gray-400">{pct}%</span>
         </div>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800/85">
         <div className="h-full rounded-full" style={{width:`${Math.max(0,Math.min(100,pct))}%`,backgroundColor:color}}/>
        </div>
       </div>
      );
     })}
    </div>
   ):null}
  </div>
 );
}

export function UsageTrendLineChart({
 period,
 onPeriodChange,
 rows,
 loading,
 from='',
 to='',
 size='compact',
 showHeader=true,
 periods=PERIODS
}:{
 period:TrendPeriod;
 onPeriodChange:(value:TrendPeriod)=>void;
 rows:TrendRow[];
 loading?:boolean;
 from?:string;
 to?:string;
 size?:'compact'|'full';
 showHeader?:boolean;
 periods?:TrendPeriod[];
}){
 const t=useAppText();
 const gradientId=useId().replace(/:/g,'');
 const scrollerRef=useRef<HTMLDivElement>(null);
 const grain=useMemo(()=>trendAxisGrain(period,from,to),[from,period,to]);
 const points=useMemo(()=>completeTrendPoints(rows,period,from,to),[from,period,rows,to]);
 const height=size==='full'?'h-[min(52vh,520px)] min-h-[320px]':'h-[140px]';
 const pan=size==='full'&&points.length>14;
 const innerWidth=pan?Math.max(points.length*(grain==='monthly'?64:40),720):undefined;
 const longAxis=period==='custom'||period==='total'||period==='month';
 useEffect(()=>{
  const node=scrollerRef.current;
  if(!node||!pan)return undefined;
  const frame=requestAnimationFrame(()=>{node.scrollLeft=node.scrollWidth;});
  return()=>cancelAnimationFrame(frame);
 },[from,pan,period,points.length,to]);
 return (
  <section className={showHeader?'mt-8':''}>
   {showHeader?(
    <div className="mb-3.5 flex items-center justify-between gap-3">
     <h2 className="text-sm font-medium tracking-tight">{t('Trend')}</h2>
     <TrendPeriodTabs period={period} periods={periods} onPeriodChange={onPeriodChange}/>
    </div>
   ):null}
   {loading&&!rows.length?(
    <div className={`flex ${height} items-center justify-center text-xs text-muted-foreground`}>{copy('qpd.card.updating')}</div>
   ):points.length===0?(
    <div className={`flex ${height} items-center justify-center text-xs text-muted-foreground`}>{t('Usage trend appears after your first AI session')}</div>
   ):(
    <div ref={scrollerRef} className={`w-full ${height} ${pan?'overflow-x-auto overflow-y-hidden [scrollbar-width:thin]':''}`}>
     <div className="h-full" style={innerWidth?{width:innerWidth,minWidth:'100%'}:{width:'100%'}}>
      <ResponsiveContainer width="100%" height="100%">
       <AreaChart data={points} margin={{top:8,right:12,left:0,bottom:4}}>
        <defs>
         <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={LINE} stopOpacity={0.32}/>
          <stop offset="100%" stopColor={LINE} stopOpacity={0}/>
         </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(128,128,128,0.18)" strokeDasharray="2 5" vertical={false}/>
        <XAxis axisLine={false} dataKey="label" interval={longAxis||pan?'preserveStartEnd':0} minTickGap={longAxis||pan?24:8} tick={{fill:'var(--muted-foreground)',fontSize:11}} tickLine={false}/>
        <YAxis axisLine={false} tick={{fill:'var(--muted-foreground)',fontSize:11}} tickFormatter={(value)=>formatTokenCount(Number(value)||0)} tickLine={false} width={44}/>
        <Tooltip content={<TrendHoverTooltip grain={grain} period={period}/>} cursor={{stroke:'rgba(60,60,60,0.28)',strokeWidth:1}} wrapperStyle={{zIndex:40,outline:'none'}}/>
        <Area
         activeDot={{r:4,stroke:LINE,fill:LINE,strokeWidth:0}}
         dataKey="tokens"
         dot={false}
         fill={`url(#${gradientId})`}
         stroke={LINE}
         strokeWidth={2}
         type="monotone"
        />
       </AreaChart>
      </ResponsiveContainer>
     </div>
    </div>
   )}
  </section>
 );
}

export function TrendPeriodTabs({
 period,
 periods=PERIODS,
 onPeriodChange,
 customRange,
 customRangeOpen,
 onCustomRangeOpenChange,
 onCustomRangeApply
}:{
 period:TrendPeriod;
 periods?:TrendPeriod[];
 onPeriodChange:(value:TrendPeriod)=>void;
 customRange?:{from:string;to:string};
 customRangeOpen?:boolean;
 onCustomRangeOpenChange?:(open:boolean)=>void;
 onCustomRangeApply?:(from:string,to:string)=>void;
}){
 const options=periods.map((value)=>({key:value,label:copy(`usage.period.${value}`)}));
 return (
  <PeriodRangeTabs
   value={period}
   options={options}
   onChange={onPeriodChange}
   customRange={customRange}
   customRangeOpen={customRangeOpen}
   onCustomRangeOpenChange={onCustomRangeOpenChange}
   onCustomRangeApply={onCustomRangeApply}
   activateCustomOnOpen
   ariaLabel={copy('usage.overview.tablist_aria')}
  />
 );
}

export function heatmapTrendRange(period:TrendPeriod,custom:{from:string;to:string}={from:'',to:''},now=new Date()){
 return localUsageRange(period,custom,now);
}
