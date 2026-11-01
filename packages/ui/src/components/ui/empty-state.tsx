import * as React from "react";
import { cn } from "@/lib/utils";

// Muted, centred placeholder for a section or list with no data.
export function EmptyState({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-32 items-center justify-center text-sm text-muted-foreground", className)} {...props} />;
}
