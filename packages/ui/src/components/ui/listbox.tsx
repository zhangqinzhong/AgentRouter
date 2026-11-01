import * as React from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";
import { Checkbox } from "./checkbox";
import { Check, Search } from "./icons";
import { Input, type InputProps } from "./input";
import { AnimatedPopover, PopoverPortal } from "./popover";

// Building blocks for dropdown lists anchored to a trigger: choose one or more
// options from a popover that flips above the trigger when space runs out.

const useClientLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

const viewportMargin = 12;
const anchorGap = 6;

export type AnchoredPopoverLayout = {
  left: number;
  maxHeight: number;
  /** Distance from the viewport top (below) or bottom (above). */
  offset: number;
  placement: "above" | "below";
  width: number;
};

export type AnchoredPopoverOptions = {
  /** Flip above the trigger when less than this much room is left below. */
  flipBelow: number;
  /** Upper bound for the popover height. */
  maxHeight: number;
  /** Lower bound for the popover height, even when the viewport is short. */
  minHeight: number;
  /** Fixed width; otherwise the trigger width, at least `minWidth`. */
  width?: number;
  minWidth?: number;
  /** Width the popover may keep when the viewport is narrower than it. */
  minViewportWidth?: number;
};

export function computeAnchoredPopoverLayout(
  anchor: Pick<DOMRect, "bottom" | "left" | "top" | "width">,
  viewport: { height: number; width: number },
  { flipBelow, maxHeight, minHeight, minViewportWidth = 220, minWidth = 0, width: fixedWidth }: AnchoredPopoverOptions
): AnchoredPopoverLayout {
  const availableWidth = Math.max(minViewportWidth, viewport.width - viewportMargin * 2);
  const width = Math.min(fixedWidth ?? Math.max(anchor.width, minWidth), availableWidth);
  const left = Math.min(Math.max(viewportMargin, anchor.left), viewport.width - viewportMargin - width);
  const below = Math.max(0, viewport.height - anchor.bottom - viewportMargin - anchorGap);
  const above = Math.max(0, anchor.top - viewportMargin - anchorGap);
  const placement = below < flipBelow && above > below ? "above" : "below";
  return {
    left,
    maxHeight: Math.min(maxHeight, Math.max(minHeight, placement === "above" ? above : below)),
    offset: placement === "above" ? viewport.height - anchor.top + anchorGap : anchor.bottom + anchorGap,
    placement,
    width
  };
}

// Track the popover layout for `anchorRef` while open, following scroll and resize.
export function useAnchoredPopoverLayout(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  options: AnchoredPopoverOptions
): AnchoredPopoverLayout | undefined {
  const [layout, setLayout] = React.useState<AnchoredPopoverLayout>();
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  useClientLayoutEffect(() => {
    if (!open) {
      setLayout(undefined);
      return;
    }

    function update() {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      setLayout(computeAnchoredPopoverLayout(
        anchor.getBoundingClientRect(),
        { height: window.innerHeight, width: window.innerWidth },
        optionsRef.current
      ));
    }

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  return layout;
}

// Close on a press outside `refs` or on Escape. With `restoreFocus`, Escape
// moves focus back to the `[aria-haspopup]` trigger inside the first ref.
export function useDismiss(
  open: boolean,
  refs: Array<React.RefObject<HTMLElement | null>>,
  onDismiss: () => void,
  { pointerEvent = "mousedown", restoreFocus = false }: { pointerEvent?: "mousedown" | "pointerdown"; restoreFocus?: boolean } = {}
) {
  const latest = React.useRef({ onDismiss, refs });
  latest.current = { onDismiss, refs };

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && latest.current.refs.some((ref) => ref.current?.contains(target))) {
        return;
      }
      latest.current.onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (restoreFocus) {
        event.preventDefault();
      }
      latest.current.onDismiss();
      if (restoreFocus) {
        latest.current.refs[0]?.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus({ preventScroll: true });
      }
    };

    document.addEventListener(pointerEvent, handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener(pointerEvent, handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, pointerEvent, restoreFocus]);
}

// Portal + entrance animation, fixed to a layout from useAnchoredPopoverLayout.
// Before the first measurement the popover renders unpositioned unless the
// caller keeps `open` false until `layout` exists.
export function AnchoredPopover({
  children,
  className,
  constrainHeight = true,
  layout,
  open
}: {
  children: React.ReactNode;
  className?: string;
  /** Apply layout.maxHeight to the wrapper (the content still scrolls itself). */
  constrainHeight?: boolean;
  layout: AnchoredPopoverLayout | undefined;
  open: boolean;
}) {
  return (
    <PopoverPortal open={open}>
      <AnimatedPopover
        className={cn("fixed z-[140]", className)}
        placement={layout?.placement ?? "below"}
        style={layout
          ? {
            left: `${layout.left}px`,
            ...(constrainHeight ? { maxHeight: `${layout.maxHeight}px` } : {}),
            width: `${layout.width}px`,
            ...(layout.placement === "above" ? { bottom: `${layout.offset}px` } : { top: `${layout.offset}px` })
          }
          : undefined}
      >
        {children}
      </AnimatedPopover>
    </PopoverPortal>
  );
}

export interface ListboxOptionProps extends Omit<ButtonProps, "size" | "unstyled" | "variant"> {
  /** "check" shows a trailing check when selected; "checkbox" a leading checkbox (multi-select). */
  indicator?: "check" | "checkbox" | "none";
  indicatorClassName?: string;
  selected: boolean;
}

// One option row. Layout (height, padding, text size) comes from className.
export const ListboxOption = React.forwardRef<HTMLButtonElement, ListboxOptionProps>(
  ({ children, className, indicator = "check", indicatorClassName, selected, ...props }, ref) => (
    <Button
      aria-selected={selected}
      className={cn(
        "flex w-full min-w-0 rounded-[5px] text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/25",
        indicator === "checkbox"
          ? selected ? "bg-emerald-500/[0.045] text-foreground" : "text-foreground hover:bg-muted/40"
          : selected ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted",
        className
      )}
      ref={ref}
      role="option"
      unstyled
      {...props}
    >
      {indicator === "checkbox" ? <Checkbox checked={selected} className={indicatorClassName} readOnly tabIndex={-1} /> : null}
      {children}
      {indicator === "check" && selected ? <Check className={cn("h-3.5 w-3.5 shrink-0", indicatorClassName)} /> : null}
    </Button>
  )
);

ListboxOption.displayName = "ListboxOption";

// Filter field at the top of a listbox popover.
export const ListboxSearch = React.forwardRef<HTMLInputElement, InputProps & { containerClassName?: string }>(
  ({ className, containerClassName, ...props }, ref) => (
    <div className={cn("relative", containerClassName)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input className={cn("h-8 pl-8", className)} ref={ref} {...props} />
    </div>
  )
);

ListboxSearch.displayName = "ListboxSearch";
