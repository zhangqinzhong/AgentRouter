export interface ModelUsage {id:string;name:string;share:number;usage:number;cost:number}
export interface ProviderUsage {label:string;source:string;usage:number;usd:number;totalPercent:string;totalPercentValue:number;models:ModelUsage[];cacheHitRate?:number}
export function buildFleetData(data:unknown, options?:{copyFn?:(key:string,values?:Record<string,unknown>)=>string}):ProviderUsage[];
