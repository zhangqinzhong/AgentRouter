import type {ComponentType} from 'react';
import type {ProviderUsage} from '../../../lib/model-breakdown';
export const UsageOverview:ComponentType<{
 period:string;periods:string[];onPeriodChange:(value:string)=>void;summaryValue:string;summaryFullValue?:string;summaryLabel:string;summaryCostValue:string;onCostInfo:()=>void;fleetData:ProviderUsage[];
 onRefresh:()=>void;loading:boolean;summaryLoading:boolean;providersLoading:boolean;hasSummary:boolean;className?:string;from:string;to:string;customFrom:string;customTo:string;
 onCustomRangeApply:(from:string,to:string)=>void;customRangeOpen:boolean;onCustomRangeOpenChange:(value:boolean)=>void;onToggleSummaryFormat:()=>void;
}>;
