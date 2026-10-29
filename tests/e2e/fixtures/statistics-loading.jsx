import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalUsageView } from '../../../packages/ui/src/pages/home/components/local-usage';
import { LocalHeatmapView } from '../../../packages/ui/src/pages/home/components/local-heatmap';
import { useTrendData } from '../../../packages/ui/src/vendor/tokentracker/hooks/use-trend-data';
import { setUsageLocale } from '../../../packages/ui/src/vendor/tokentracker/lib/copy';
import { AppI18nContext, appCopy } from '../../../packages/ui/src/pages/home/shared/i18n';
setUsageLocale('zh');
function TrendProbe() {
  const [period,setPeriod]=useState('month');
  const result=useTrendData({period,from:'2026-10-01',to:'2026-10-27',timeZone:'UTC'});
  return <><button onClick={()=>setPeriod('week')}>Week</button><output aria-label="trend tokens">{result.rows.reduce((n,row)=>n+Number(row.total_tokens||0),0)}</output><output aria-label="trend loading">{String(result.loading)}</output></>;
}
const mode=new URL(location.href).searchParams.get('page');
createRoot(document.getElementById('root')).render(<AppI18nContext.Provider value={appCopy.zh}>{mode==='trend'?<TrendProbe/>:mode==='heatmap'?<LocalHeatmapView/>:<LocalUsageView defaultRange="week"/>}</AppI18nContext.Provider>);
