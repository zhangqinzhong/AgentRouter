import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionEase, reducedMotionTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Check } from "./icons";

export type ToastMessage = {
  id: number;
  message: string;
};

// Fixed, centred stack at the top of the window for toasts and save feedback.
export function ToastStack({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed left-1/2 top-5 z-[10000] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col items-center gap-3">
      {children}
    </div>
  );
}

// Transient success pill. Render inside ToastStack with `contained`.
export function Toast({ contained = false, toast }: { contained?: boolean; toast?: ToastMessage }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {toast ? (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "pointer-events-none flex items-center gap-2 rounded-full border border-border bg-popover px-3 py-2 text-caption font-medium text-popover-foreground shadow-lg",
            contained ? "max-w-full" : "fixed left-1/2 top-5 z-[10000] max-w-[calc(100vw-24px)] -translate-x-1/2"
          )}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          key={toast.id}
          role="status"
          transition={shouldReduceMotion ? reducedMotionTransition : { duration: 0.16, ease: motionEase }}
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="truncate">{toast.message}</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
