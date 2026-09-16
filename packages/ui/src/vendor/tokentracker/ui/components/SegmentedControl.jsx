import React, { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

/**
 * SegmentedControl — iOS/Linear style segmented control with a single white
 * "thumb" that slides between options instead of each button toggling its own
 * background. The thumb is one absolutely-positioned element animated with a
 * transform/width transition, so switching options glides rather than jumps.
 *
 * @param {Object} props
 * @param {Array<{id: string, label: React.ReactNode, icon?: React.ReactNode, disabled?: boolean}>} props.options
 * @param {string} props.value - Currently selected option id.
 * @param {(id: string) => void} props.onChange
 * @param {React.ReactNode} [props.leading] - Optional node rendered before the options (e.g. an icon).
 * @param {boolean} [props.disabled] - Disables every option.
 * @param {string} [props.ariaLabel]
 * @param {string} [props.className]
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  leading = null,
  disabled = false,
  ariaLabel,
  className = "",
}) {
  const trackRef = useRef(null);
  const buttonRefs = useRef(new Map());
  const [thumb, setThumb] = useState(null);

  const moveSelection = (event, optionId) => {
    const enabled = options.filter((option) => !disabled && !option.disabled);
    const index = enabled.findIndex((option) => option.id === optionId);
    if (index < 0) return;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = enabled[(index + 1) % enabled.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = enabled[(index - 1 + enabled.length) % enabled.length];
    } else if (event.key === "Home") {
      next = enabled[0];
    } else if (event.key === "End") {
      next = enabled[enabled.length - 1];
    }
    if (!next || next.id === optionId) return;
    event.preventDefault();
    onChange(next.id);
    buttonRefs.current.get(next.id)?.focus();
  };

  // Position the thumb over the active option. Runs before paint (no flash)
  // and re-measures on resize/label changes so the thumb stays aligned.
  useLayoutEffect(() => {
    const measure = () => {
      const active = buttonRefs.current.get(value);
      // offsetWidth is 0 in non-layout environments (jsdom); skip so we don't
      // schedule a pointless state update (and an act() warning) there.
      if (!active || active.offsetWidth === 0) return;
      const next = {
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
      };
      setThumb((prev) =>
        prev
        && prev.left === next.left
        && prev.top === next.top
        && prev.width === next.width
        && prev.height === next.height
          ? prev
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !trackRef.current) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(trackRef.current);
    for (const node of buttonRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [value, options]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex h-8 items-center gap-1 rounded-md border border-oai-gray-200 bg-oai-gray-100 p-[3px] dark:border-oai-gray-700 dark:bg-oai-gray-800",
        className,
      )}
    >
      {leading}
      {thumb ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 rounded-sm bg-white shadow-sm transition-[transform,width] duration-200 ease-out motion-reduce:transition-none dark:bg-oai-gray-700"
          style={{
            transform: `translate(${thumb.left}px, ${thumb.top}px)`,
            width: `${thumb.width}px`,
            height: `${thumb.height}px`,
          }}
        />
      ) : null}
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(option.id, node);
              else buttonRefs.current.delete(option.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => moveSelection(event, option.id)}
            className={cn(
              "relative z-10 inline-flex h-6 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
              active
                ? "text-oai-black dark:text-white"
                : "text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
