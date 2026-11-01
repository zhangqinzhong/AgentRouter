import * as React from "react";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "./icons";

// Inline loading indicator. Size it with h-/w- classes (default 16px).
export function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircle>) {
  return <LoaderCircle aria-hidden="true" className={cn("h-4 w-4 animate-spin", className)} {...props} />;
}
