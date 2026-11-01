import * as React from "react";
import { Button, Check, CircleAlert, cn, useAppText, X } from "../shared/index";
import { Spinner } from "@/components/ui/spinner";

export function PersistenceFeedback({ actionError, contained = false, disconnected, error, inline = false, onDismissAction, onRetry, state }: {
  actionError: string;
  contained?: boolean;
  disconnected: boolean;
  error: string;
  inline?: boolean;
  onDismissAction: () => void;
  onRetry: () => void;
  state: "idle" | "saving" | "saved" | "error";
}) {
  const t = useAppText();
  const [showSaved, setShowSaved] = React.useState(false);
  React.useEffect(() => {
    setShowSaved(state === "saved");
    if (state !== "saved") return;
    const timer = window.setTimeout(() => setShowSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const failed = state === "error";
  const message = failed ? t("Changes have not been saved.") : disconnected ? t("Connection lost. Status may be out of date.") : actionError;
  if (!message && state !== "saving" && !showSaved) return null;
  return (
    <div className={cn(
      "border-border bg-popover px-4 py-3 text-body text-popover-foreground",
      inline
        ? "shrink-0 border-t"
        : contained
          ? "pointer-events-auto w-max max-w-full rounded-lg border shadow-lg"
          : "pointer-events-auto fixed left-1/2 top-5 z-[10000] w-max max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-lg border shadow-lg"
    )} role={message ? "alert" : "status"}>
      <div className="flex items-center gap-3">
        {message ? <CircleAlert className="h-4 w-4 shrink-0 text-destructive" /> : state === "saving" ? <Spinner className="shrink-0" /> : <Check className="h-4 w-4 shrink-0 text-primary" />}
        <span>{message || t(state === "saving" ? "Saving changes…" : "Changes saved.")}</span>
        {failed ? <Button onClick={onRetry} size="sm" variant="outline">{t("Retry saving")}</Button> : actionError && !disconnected ? <Button aria-label={t("Dismiss")} onClick={onDismissAction} size="iconSm" variant="ghost"><X className="h-4 w-4" /></Button> : null}
      </div>
      {failed && error ? <details className="mt-2 text-caption text-muted-foreground"><summary className="cursor-pointer">{t("Technical details")}</summary><p className="mt-1 max-h-24 overflow-auto break-words">{error}</p></details> : null}
    </div>
  );
}
// Toasts live in the shared components; these names are kept for existing call sites.
export { Toast as LightToast, ToastStack as FeedbackStack } from "@/components/ui/toast";
