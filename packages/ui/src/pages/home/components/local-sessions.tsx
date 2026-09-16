import {memo} from 'react';
import {setUsageLocale} from '@/vendor/tokentracker/lib/copy';
import {ToastProvider} from '@/vendor/tokentracker/ui/components/Toast';
import {SessionsPage} from '@/vendor/tokentracker/pages/SessionsPage';
import {useAppText} from '../shared/index';

export const LocalSessionsView=memo(function LocalSessionsView(){
 const t=useAppText();setUsageLocale(t('Usage')==='用量'?'zh':'en');
 return <ToastProvider><div className="local-usage-page"><SessionsPage/></div></ToastProvider>;
});
