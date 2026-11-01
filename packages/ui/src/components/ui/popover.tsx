import * as React from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { reducedMotionTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { DialogScopeContext } from "./dialog";

export interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("rounded-md border border-border bg-popover text-popover-foreground shadow-card-elevated", className)}
      ref={ref}
      {...props}
    />
  )
);

PopoverContent.displayName = "PopoverContent";

export interface PopoverPortalProps {
  children: React.ReactNode;
  open?: boolean;
}

function PopoverPortal({ children, open = true }: PopoverPortalProps) {
  const dialogScope = React.useContext(DialogScopeContext);
  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(<div className="contents" data-ui-dialog-owner={dialogScope?.id}>{children}</div>, document.body);
}

type MotionSafeDivAttributes = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onAnimationStart" | "onDrag" | "onDragCapture" | "onDragEnd" | "onDragEndCapture" | "onDragStart" | "onDragStartCapture"
>;

// Fade and slide a popover in from its anchor side.
function AnimatedPopover({
  children,
  className,
  placement = "below",
  ...props
}: MotionSafeDivAttributes & { placement?: "above" | "below" }) {
  const shouldReduceMotion = useReducedMotion();
  const y = placement === "above" ? 4 : -4;

  return (
    <motion.div
      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
      className={className}
      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y }}
      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y }}
      transition={shouldReduceMotion ? reducedMotionTransition : { duration: 0.12, ease: "easeOut" }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

export { AnimatedPopover, PopoverContent, PopoverPortal };
