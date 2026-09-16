import React from "react";
import { cn } from "../../lib/cn";

/**
 * Small styled hover tooltip. Positions itself above the nearest ancestor that
 * has `group relative` on it — the caller owns that wrapper so this stays a
 * plain sibling, not an extra layout-affecting box. Glass-card styling matches
 * ActivityHeatmap3D's hover tooltip (backdrop-blur + subtle border + shadow-xl)
 * for a consistent hover-surface language app-wide.
 *
 * Renders `whitespace-pre-line`, so callers can join multiple lines with \n.
 */
export function HoverTooltip({ text, placement = "top" }) {
  if (!text) return null;
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none absolute left-1/2 z-10 w-max max-w-[260px] -translate-x-1/2 whitespace-pre-line rounded-xl border border-oai-gray-200/50 dark:border-oai-gray-800/50 bg-white/90 dark:bg-oai-gray-900/90 backdrop-blur-md px-2.5 py-1.5 text-[10.5px] leading-snug text-oai-gray-700 dark:text-oai-gray-200 shadow-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100",
        // Anchoring below matters when the trigger sits under the content it
        // would otherwise cover (e.g. a metadata line beneath a row title).
        placement === "bottom" ? "top-full mt-2" : "bottom-full mb-2",
      )}
    >
      {text}
    </div>
  );
}
