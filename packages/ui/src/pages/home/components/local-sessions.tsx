import {memo} from 'react';
import {ToastProvider} from '@/vendor/tokentracker/ui/components/Toast';
import {SessionsPage} from '@/vendor/tokentracker/pages/SessionsPage';

export const LocalSessionsView=memo(function LocalSessionsView(){
 return <ToastProvider><div className="local-usage-page mx-auto w-full max-w-[1120px]"><SessionsPage/></div></ToastProvider>;
});
