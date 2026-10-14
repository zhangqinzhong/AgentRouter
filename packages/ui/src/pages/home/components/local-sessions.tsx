import { memo } from "react";
import { ToastProvider } from "@/vendor/tokentracker/ui/components/Toast";
import { SessionLibrary } from "./session-library";

export const LocalSessionsView = memo(function LocalSessionsView({
  agent = "all",
  onCatalogRefresh,
  project = "all",
  scopeNonce = 0,
}: {
  agent?: string;
  onCatalogRefresh?: (since?: number) => void;
  project?: string;
  scopeNonce?: number;
}) {
  return (
    <ToastProvider>
      <div className="local-usage-page h-full min-h-0 w-full p-4 lg:p-6">
        <SessionLibrary agent={agent} onCatalogRefresh={onCatalogRefresh} project={project} scopeNonce={scopeNonce} />
      </div>
    </ToastProvider>
  );
});
