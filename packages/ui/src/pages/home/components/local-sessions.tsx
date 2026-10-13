import { DEFAULT_PAGE_RANGES } from "@agentrouter/core/config/page-default-ranges";
import type { PageDefaultRanges } from "@agentrouter/core/contracts/app";
import { memo } from "react";
import { ToastProvider } from "@/vendor/tokentracker/ui/components/Toast";
import { SessionLibrary } from "./session-library";

export const LocalSessionsView = memo(function LocalSessionsView({
  defaultRange = DEFAULT_PAGE_RANGES.sessions,
}: {
  defaultRange?: PageDefaultRanges["sessions"];
}) {
  return (
    <ToastProvider>
      <div className="local-usage-page h-full min-h-0 w-full p-4 lg:p-6">
        <SessionLibrary defaultRange={defaultRange} />
      </div>
    </ToastProvider>
  );
});
