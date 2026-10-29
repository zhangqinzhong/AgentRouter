import * as React from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  onCheckedChange?: (checked: boolean) => void;
  size?: "default" | "sm";
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ checked = false, className, disabled, onChange, onCheckedChange, size = "default", title, ...props }, ref) => (
    <span className={cn("relative inline-flex shrink-0", size === "sm" ? "h-5 w-9" : "h-[30px] w-[54px]", className)} title={title}>
      <input
        aria-checked={checked}
        checked={checked}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        disabled={disabled}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked);
        }}
        ref={ref}
        role="switch"
        title={title}
        type="checkbox"
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex h-full w-full items-center rounded-full transition-all duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-ring/25 peer-disabled:opacity-50",
          size === "sm" ? "px-0.5" : "px-[3px]",
          checked ? "bg-primary shadow-[0_0_0_1px_rgba(15,118,110,0.2)]" : "bg-muted shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
        )}
      >
        <span
          className={cn(
            "rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.15)] transition-transform duration-200",
            size === "sm" ? "h-4 w-4" : "h-6 w-6",
            checked && (size === "sm" ? "translate-x-4" : "translate-x-[24px]")
          )}
        />
      </span>
    </span>
  )
);

Switch.displayName = "Switch";

export { Switch };
