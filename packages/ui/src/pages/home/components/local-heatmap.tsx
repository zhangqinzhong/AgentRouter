import {memo,useEffect,useMemo,useRef,useState,type MouseEvent} from 'react';
import {createPortal} from 'react-dom';
import {copy,setUsageLocale} from '@/vendor/tokentracker/lib/copy';
import {buildActivityHeatmap,computeActiveStreakDays} from '@/vendor/tokentracker/lib/activity-heatmap';
import {formatTokenCount,formatTokenTooltip} from '@/vendor/tokentracker/lib/token-format';
import {formatTimeZoneLabel,getBrowserTimeZone,getBrowserTimeZoneOffsetMinutes} from '@/vendor/tokentracker/lib/timezone';
import {formatToolCalls,toolDisplayName,toolIcon} from './heatmap-tools';
import {useAppText} from '../shared/index';

type HeatmapCell={day?:string;value?:number;level?:number;billable_total_tokens?:number;total_tokens?:number;models?:unknown}|null;
type HeatmapTool={name:string;calls:number};
type HeatmapProfile={displayName?:string;username?:string;avatar?:string|null};
type HeatmapPayload=Record<string,unknown> & {profile?:HeatmapProfile;weeks?:HeatmapCell[][]};
const GREEN=['#ebedf0','#a7f3d0','#6ee7b7','#34d399','#10b981'];
const DARK_GREEN=['#121212','#065f46','#059669','#10b981','#34d399'];
type BuiltCell={day:string;value:number;level:number;models?:Record<string,number>|null};
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'] as const;
const WEEKDAYS=['sun','mon','tue','wed','thu','fri','sat'] as const;

export function heatmapCellTokens(cell:HeatmapCell|undefined){
 const value=Number(cell?.billable_total_tokens??cell?.total_tokens??cell?.value??0);
 return Number.isFinite(value)&&value>0?value:0;
}

export function dailyRowsFromHeatmap(heatmap:HeatmapPayload|undefined){
 const weeks=Array.isArray(heatmap?.weeks)?heatmap.weeks:[];
 const rows:Array<{day:string;billable_total_tokens:number;total_tokens:number;models:unknown}>=[];
 for(const week of weeks){
  for(const cell of week||[]){
   if(!cell?.day)continue;
   const tokens=heatmapCellTokens(cell);
   rows.push({day:cell.day,billable_total_tokens:tokens,total_tokens:tokens,models:cell.models});
  }
 }
 return rows;
}

function longestStreak(cells:Array<{day:string;value:number}>){
 const active=new Set(cells.filter((cell)=>cell.value>0).map((cell)=>cell.day));
 const days=[...active].sort();
 let best=0;let current=0;let previous='';
 for(const day of days){
  if(!previous){current=1;best=1;previous=day;continue;}
  const prev=new Date(`${previous}T00:00:00`);
  const next=new Date(`${day}T00:00:00`);
  const diff=Math.round((next.getTime()-prev.getTime())/86400000);
  current=diff===1?current+1:1;
  best=Math.max(best,current);
  previous=day;
 }
 return best;
}

function currentStreak(dailyRows:Array<{day:string;billable_total_tokens:number}>,to?:string){
 const today=to||dailyRows.at(-1)?.day;
 if(!today)return 0;
 const todayRow=dailyRows.find((row)=>row.day===today);
 if(heatmapCellTokens(todayRow)>0)return computeActiveStreakDays({dailyRows,to});
 const [year,month,day]=today.split('-').map(Number);
 const previous=new Date(Date.UTC(year,month-1,day-1)).toISOString().slice(0,10);
 return computeActiveStreakDays({dailyRows,to:previous});
}

function formatTaskDuration(ms:number){
 if(!Number.isFinite(ms)||ms<=0)return '—';
 const total=Math.round(ms/1000);
 const hours=Math.floor(total/3600);
 const minutes=Math.floor((total%3600)/60);
 const seconds=total%60;
 if(hours>0)return `${hours}h ${minutes}m`;
 if(minutes>0)return `${minutes}m ${seconds}s`;
 return `${seconds}s`;
}

const SKIP_TOOLS=new Set(['text_response','assistant_response']);
function mergeTools(payloads:Array<Record<string,unknown>|undefined>){
 const byName=new Map<string,number>();
 for(const payload of payloads){
  const breakdown=payload?.tool_calls_breakdown as {tools?:Array<{name?:string;calls?:number}>}|undefined;
  const skills=payload?.skills_breakdown as {skills?:Array<{name?:string;calls?:number}>}|undefined;
  for(const row of [...(breakdown?.tools||[]),...(skills?.skills||[])]){
   const name=String(row?.name||'').trim();
   const calls=Number(row?.calls||0);
   if(!name||SKIP_TOOLS.has(name)||!Number.isFinite(calls)||calls<=0)continue;
   byName.set(name,(byName.get(name)||0)+calls);
  }
 }
 return [...byName.entries()].map(([name,calls])=>({name,calls:Math.round(calls)})).sort((a,b)=>b.calls-a.calls).slice(0,50);
}

function tooltipInsight(level:number,value:number){
 if(level>=4)return copy(`heatmap.3d.voxel.joke.${(Math.floor(Math.random()*3)+1) as 1|2|3}`,{value:formatTokenCount(value)});
 if(level===3)return copy('heatmap.3d.voxel.level3',{value:formatTokenCount(value)});
 if(level===2)return copy('heatmap.3d.voxel.level2',{value:formatTokenCount(value)});
 if(level===1)return copy('heatmap.3d.voxel.level1',{value:formatTokenCount(value)});
 return copy('heatmap.3d.voxel.level0');
}

function HeatmapHoverTooltip({
 cell,
 palette,
 isDark,
 pos
}:{
 cell:BuiltCell;
 palette:string[];
 isDark:boolean;
 pos:{x:number;y:number;shiftX:number;flipY:boolean};
}){
 const tokens=Number(cell.value||0);
 const models=cell.models&&typeof cell.models==='object'?Object.entries(cell.models).map(([name,val])=>({name,val:Number(val)||0})).sort((a,b)=>b.val-a.val):[];
 const badgeColor=cell.level===0?(isDark?'#9ca3af':'#6b7280'):palette[cell.level]||palette[1];
 return createPortal(
  <div className="pointer-events-none fixed z-[9999] h-0 w-0" style={{left:`${pos.x}px`,top:`${pos.y}px`,position:'fixed'}}>
   <div
    className={`absolute left-0 ${pos.flipY?'top-[10px]':'bottom-[10px]'} flex max-w-[280px] min-w-[200px] flex-col gap-2 rounded-xl border border-oai-gray-200/50 bg-white/95 p-3.5 shadow-xl backdrop-blur-md dark:border-oai-gray-800/50 dark:bg-oai-gray-900/95`}
    style={{transform:`translateX(calc(-50% + ${pos.shiftX}px))`,animation:'tt-heatmap-pop 120ms ease-out forwards'}}
   >
    <div className="flex items-center justify-between border-b border-oai-gray-100 pb-1.5 dark:border-oai-gray-800/80">
     <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">{cell.day}</span>
     <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{backgroundColor:`${badgeColor}22`,color:badgeColor,border:`1px solid ${badgeColor}44`}}>
      {copy('heatmap.tooltip.level',{level:cell.level})}
     </span>
    </div>
    <div className="flex items-baseline gap-1">
     <span className="text-lg font-bold leading-none text-oai-gray-900 dark:text-white" title={formatTokenTooltip(tokens)}>{formatTokenCount(tokens)}</span>
     <span className="text-[10px] font-semibold uppercase tracking-wider text-oai-gray-400">{copy('heatmap.unit.tokens')}</span>
    </div>
    {models.length>0?(
     <div className="mt-1.5 flex flex-col gap-1.5 border-t border-oai-gray-100 pt-2 dark:border-oai-gray-800/60">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">{copy('heatmap.tooltip.model_breakdown')}</div>
      <div className="flex max-h-[150px] flex-col gap-2 overflow-y-auto pr-1.5">
       {models.map(({name,val})=>{
        const pct=Math.round((val/Math.max(tokens,1))*100);
        return (
         <div key={name} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3 text-[11px]">
           <span className="max-w-[120px] truncate font-medium text-oai-gray-750 dark:text-oai-gray-200" title={name}>{name}</span>
           <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono font-semibold text-oai-gray-900 dark:text-oai-gray-100" title={formatTokenTooltip(val)}>{formatTokenCount(val)}</span>
            <span className="min-w-[28px] text-right text-[9px] font-medium text-oai-gray-450 dark:text-oai-gray-500">{pct}%</span>
           </div>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800/85">
           <div className="h-full rounded-full transition-all duration-300" style={{width:`${pct}%`,backgroundColor:palette[4],boxShadow:`0 0 4px ${palette[4]}55`}}/>
          </div>
         </div>
        );
       })}
      </div>
     </div>
    ):(
     <p className="mt-1 border-t border-dashed border-oai-gray-100 pt-1.5 text-[11px] font-normal leading-relaxed text-oai-gray-600 dark:border-oai-gray-800/60 dark:text-oai-gray-300">
      {tooltipInsight(cell.level,tokens)}
     </p>
    )}
   </div>
   <div
    className={`absolute left-0 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-white shadow-sm dark:bg-oai-gray-900 ${pos.flipY?'top-[6px] border-l border-t':'bottom-[6px] border-r border-b'} border-oai-gray-200/50 dark:border-oai-gray-800/50`}
    style={pos.flipY?{marginTop:'1px'}:{marginBottom:'1px'}}
   />
  </div>,
  document.body
 );
}

function initials(name:string){
 const parts=name.trim().split(/\s+/).filter(Boolean);
 if(parts.length>=2)return `${parts[0][0]||''}${parts[1][0]||''}`.toUpperCase();
 return name.slice(0,2).toUpperCase()||'AR';
}

export const LocalHeatmapView=memo(function LocalHeatmapView(){
 const t=useAppText();setUsageLocale(t('Usage')==='用量'?'zh':'en');
 const [heatmap,setHeatmap]=useState<HeatmapPayload>();
 const [tools,setTools]=useState<HeatmapTool[]>([]);
 const [toolsLoading,setToolsLoading]=useState(true);
 const [longestTaskMs,setLongestTaskMs]=useState(0);
 const [lifetime,setLifetime]=useState(0);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const [revision,setRevision]=useState(0);
 const [hoveredCell,setHoveredCell]=useState<BuiltCell>();
 const [tooltipPos,setTooltipPos]=useState({x:0,y:0,shiftX:0,flipY:false});
 const hideTimeoutRef=useRef<ReturnType<typeof setTimeout>|null>(null);
 const timeZone=getBrowserTimeZone()||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const isDark=typeof document!=='undefined'&&document.documentElement.classList.contains('dark');
 const palette=isDark?DARK_GREEN:GREEN;
 useEffect(()=>{let active=true;setLoading(true);setError('');
  const api=window.agentrouter;
  if(!api?.getLocalUsageHeatmap){setError(t('Local usage data is unavailable.'));setLoading(false);return;}
  const to=new Date();
  const toDay=`${to.getFullYear()}-${String(to.getMonth()+1).padStart(2,'0')}-${String(to.getDate()).padStart(2,'0')}`;
  void api.getLocalUsageHeatmap({weeks:53,tz:timeZone}).then((data)=>{if(active)setHeatmap(data as HeatmapPayload)}).catch((e)=>{if(active)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(active)setLoading(false)});
  if(api.getLocalUsagePage)void api.getLocalUsagePage({from:'',to:toDay,tz:timeZone}).then((page)=>{if(active)setLifetime(Number(page?.totals?.billable_total_tokens??page?.totals?.total_tokens??0)||0)}).catch(()=>{});
  if(api.getLocalUsageSessions)void api.getLocalUsageSessions({from:'',to:toDay,tz:timeZone,limit:2000}).then((result)=>{
   if(!active)return;
   const sessions=Array.isArray(result?.sessions)?result.sessions as Array<{duration_ms?:number}>:[];
   setLongestTaskMs(sessions.reduce((max,session)=>Math.max(max,Number(session.duration_ms)||0),0));
  }).catch(()=>{});
  if(api.getLocalUsageCategories){
   const range={from:'',to:toDay,tz:timeZone};
   void Promise.allSettled([
    api.getLocalUsageCategories({...range,source:'codex'}),
    api.getLocalUsageCategories({...range,source:'claude'}),
    api.getLocalUsageCategories({...range,source:'grok'})
   ]).then((results)=>{
    if(!active)return;
    setTools(mergeTools(results.map((item)=>item.status==='fulfilled'?item.value as Record<string,unknown>:undefined)));
   }).finally(()=>{if(active)setToolsLoading(false)});
  }else setToolsLoading(false);
  return()=>{active=false};
 },[revision,timeZone,t]);
 useEffect(()=>()=>{if(hideTimeoutRef.current)clearTimeout(hideTimeoutRef.current);},[]);
 const showCellTooltip=(event:MouseEvent<HTMLButtonElement>,cell:BuiltCell)=>{
  if(hideTimeoutRef.current){clearTimeout(hideTimeoutRef.current);hideTimeoutRef.current=null;}
  setHoveredCell(cell);
  const rect=event.currentTarget.getBoundingClientRect();
  const viewportWidth=window.innerWidth||1024;
  const x=rect.left+rect.width/2;
  const flipY=rect.top<300;
  const y=flipY?rect.bottom:rect.top;
  const halfWidth=140;
  let shiftX=0;
  if(x<halfWidth)shiftX=halfWidth-x;
  else if(x>viewportWidth-halfWidth)shiftX=viewportWidth-halfWidth-x;
  setTooltipPos({x,y,shiftX,flipY});
 };
 const hideCellTooltip=()=>{
  if(hideTimeoutRef.current)clearTimeout(hideTimeoutRef.current);
  hideTimeoutRef.current=setTimeout(()=>setHoveredCell(undefined),150);
 };
 const dailyRows=useMemo(()=>dailyRowsFromHeatmap(heatmap),[heatmap]);
 const built=useMemo(()=>buildActivityHeatmap({dailyRows,weeks:53,to:typeof heatmap?.to==='string'?heatmap.to:undefined,weekStartsOn:'sun'}),[dailyRows,heatmap]);
 const stats=useMemo(()=>{
  const cells=dailyRows.map((row)=>({day:row.day,value:row.billable_total_tokens}));
  return {
   lifetime:lifetime||cells.reduce((sum,cell)=>sum+cell.value,0),
   peak:cells.reduce((max,cell)=>Math.max(max,cell.value),0),
   current:currentStreak(dailyRows,typeof heatmap?.to==='string'?heatmap.to:undefined),
   longest:longestStreak(cells),
   task:formatTaskDuration(longestTaskMs)
  };
 },[dailyRows,heatmap,lifetime,longestTaskMs]);
 const monthLabels=useMemo(()=>{
  const labels:Array<{label:string;index:number}>=[];
  const seen=new Set<number>();
  (built.weeks||[]).forEach((week,index)=>{
   const first=week.find((cell)=>cell?.day);
   if(!first?.day)return;
   const month=Number(first.day.slice(5,7))-1;
   if(seen.has(month))return;
   seen.add(month);
   labels.push({label:copy(`heatmap.month.${MONTHS[month]}`),index});
  });
  return labels;
 },[built.weeks]);
 const profile=heatmap?.profile||{};
 const displayName=String(profile.displayName||profile.username||t('Local usage'));
 const username=String(profile.username||'');
 return (
  <div className="local-usage-page mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 pb-0 sm:px-9">
   <div className="shrink-0">
   {error?<div role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={()=>setRevision((value)=>value+1)}>{t('Retry')}</button></div>:null}
   <div className="mb-6 flex items-center gap-4">
    {profile.avatar?(
     <img src={profile.avatar} alt="" className="h-16 w-16 rounded-full object-cover"/>
    ):(
     <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#216e39] text-lg font-semibold text-white">{initials(displayName)}</div>
    )}
    <div className="min-w-0">
     <h1 className="truncate text-[24px] font-semibold tracking-[-0.025em]">{displayName}</h1>
     <p className="truncate text-sm text-muted-foreground">{username?`@${username}`:t('Local usage')}</p>
     <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{formatTimeZoneLabel({timeZone,offsetMinutes:getBrowserTimeZoneOffsetMinutes()})}</p>
    </div>
   </div>
   <div className="mb-5 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-5">
    {[
     {label:t('Lifetime tokens'),value:formatTokenCount(stats.lifetime)},
     {label:t('Peak tokens'),value:formatTokenCount(stats.peak)},
     {label:t('Current streak'),value:`${stats.current} ${copy('heatmap.3d.modal.stats.days_suffix')}`},
     {label:t('Longest streak'),value:`${stats.longest} ${copy('heatmap.3d.modal.stats.days_suffix')}`},
     {label:t('Longest task'),value:stats.task}
    ].map((item)=>(
     <div key={item.label} className="min-w-0">
      <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{item.label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{item.value}</div>
     </div>
    ))}
   </div>
   <h2 className="mb-3 text-sm font-medium">{t('Token activity')}</h2>
   {loading&&!heatmap?<p className="text-sm text-muted-foreground">{copy('qpd.card.updating')}</p>:(
    <div className="w-full overflow-x-auto">
     <div className="relative mb-1 h-4 min-w-[720px]">
      {monthLabels.map((marker)=>(
       <span key={`${marker.label}-${marker.index}`} className="absolute text-[10px] text-muted-foreground" style={{left:`${(marker.index/Math.max(built.weeks.length,1))*100}%`}}>{marker.label}</span>
      ))}
     </div>
     <div className="flex min-w-[720px] gap-1">
      <div className="flex flex-col justify-around py-[2px] text-[9px] text-muted-foreground">
       {WEEKDAYS.map((day,index)=>index%2===1?<span key={day}>{copy(`heatmap.day.${day}`)}</span>:<span key={day} className="h-[11px]"/>)}
      </div>
      <div className="grid flex-1 grid-flow-col grid-rows-7 gap-[3px] overflow-visible">
       {built.weeks.flatMap((week,weekIndex)=>week.map((cell,dayIndex)=>(
        <button
         key={`${weekIndex}-${dayIndex}`}
         type="button"
         disabled={!cell}
         onMouseEnter={(event)=>{if(cell)showCellTooltip(event,cell as BuiltCell);}}
         onMouseLeave={hideCellTooltip}
         className={`h-[11px] w-[11px] rounded-[2px] ${cell?'cursor-pointer transition-transform duration-150 ease-out hover:z-10 hover:scale-125':''}`}
         style={{backgroundColor:cell?palette[cell.level||0]:'transparent'}}
        />
       )))}
      </div>
     </div>
     <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
      <span>{copy('heatmap.legend.utc')}</span>
      <span className="flex items-center gap-1">{copy('heatmap.legend.less')}{GREEN.map((color)=><span key={color} className="h-2.5 w-2.5 rounded-[2px]" style={{backgroundColor:color}}/>)}{copy('heatmap.legend.more')}</span>
     </div>
    </div>
   )}
   </div>
   <div className="mt-6 flex min-h-0 flex-1 flex-col">
    <h2 className="mb-3 shrink-0 text-sm font-medium">{t('Most used tools')}</h2>
    {toolsLoading?<p className="text-sm text-muted-foreground">{copy('qpd.card.updating')}</p>:tools.length===0?<p className="text-sm text-muted-foreground">{t('No local tool usage yet')}</p>:(
     <div className="min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-width:thin]">
      <div className="flex flex-col gap-2.5">
       {tools.map((tool)=>{
        const width=Math.max(8,(tool.calls/Math.max(tools[0].calls,1))*100);
        const Icon=toolIcon(tool.name);
        const label=toolDisplayName(tool.name);
        return (
         <div key={tool.name} className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-3 text-sm">
          <div className="flex min-w-0 items-start gap-2.5">
           <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            <Icon size={14}/>
           </span>
           <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={tool.name}>{label}</div>
            {label!==tool.name?<div className="truncate font-mono text-[10px] text-muted-foreground">{tool.name}</div>:null}
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
             <div className="h-full rounded-full bg-[#30a14e]" style={{width:`${width}%`}}/>
            </div>
           </div>
          </div>
          <div className="text-right tabular-nums text-muted-foreground">{formatToolCalls(tool.calls)}</div>
         </div>
        );
       })}
      </div>
     </div>
    )}
   </div>
   {hoveredCell&&typeof document!=='undefined'?<HeatmapHoverTooltip cell={hoveredCell} isDark={isDark} palette={palette} pos={tooltipPos}/>:null}
   <style>{`@keyframes tt-heatmap-pop{from{opacity:0}to{opacity:1}}`}</style>
  </div>
 );
});
