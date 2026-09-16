import {Radio,Loader2} from 'lucide-react';
import {Switch} from './Switch';
import {cn} from '@/lib/utils';
export function ProxyToggle({active,pending,onToggle,onInfo,label}:{active:boolean;pending:boolean;onToggle:()=>void;onInfo:()=>void;label:string}) {
 return <div className="flex items-center gap-1 px-1.5 h-8 rounded-lg bg-muted/50 transition-all" title={label}>
  {pending ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground"/> : <button type="button" aria-label="端点信息" onClick={onInfo} style={{display:'flex',padding:0,border:0,background:'transparent'}}><Radio className={cn("h-4 w-4 transition-colors",active?"text-emerald-500 status-heartbeat":"text-muted-foreground")}/></button>}
  <Switch checked={active} onCheckedChange={onToggle} disabled={pending} aria-label={label}/>
 </div>;
}
