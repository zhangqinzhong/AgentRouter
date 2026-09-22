import {DEFAULT_PAGE_RANGES} from "@agentrouter/core/config/page-default-ranges";
import type {PageDefaultRanges} from "@agentrouter/core/contracts/app";
import {memo} from 'react';
import {ToastProvider} from '@/vendor/tokentracker/ui/components/Toast';
import {SessionsPage} from '@/vendor/tokentracker/pages/SessionsPage';

export const LocalSessionsView=memo(function LocalSessionsView({defaultRange=DEFAULT_PAGE_RANGES.sessions}:{defaultRange?:PageDefaultRanges["sessions"]}){
 return <ToastProvider><div className="local-usage-page mx-auto w-full max-w-[1120px]"><SessionsPage defaultRange={defaultRange}/></div></ToastProvider>;
});
