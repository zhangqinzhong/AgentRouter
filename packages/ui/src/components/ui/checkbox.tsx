import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onCheckedChange?: (checked: boolean) => void;
}

// Unified selection indicator: 18px rounded square that fills with the emerald
// brand accent and shows a bold white check. Sized up from the old 16px square
// so it reads clearly next to 12px row text.
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ checked = false, className, disabled, onChange, onCheckedChange, ...props }, ref) => (
    <span className={cn("relative inline-flex h-[18px] w-[18px] shrink-0", className)}>
      <input
        aria-checked={checked}
        checked={checked}
        className={cn(
          "peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none rounded-[6px] border bg-background outline-none transition-[background-color,border-color] hover:border-muted-foreground/45 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
          checked
            ? "border-emerald-600 bg-emerald-600 dark:border-emerald-500 dark:bg-emerald-500"
            : "border-muted-foreground/30"
        )}
        disabled={disabled}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked);
        }}
        ref={ref}
        type="checkbox"
        {...props}
      />
      <Check
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 text-white transition-opacity",
          checked ? "opacity-100" : "opacity-0"
        )}
        strokeWidth={3}
      />
    </span>
  )
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
