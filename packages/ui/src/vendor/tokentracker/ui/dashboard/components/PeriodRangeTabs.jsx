import React from "react";
import { DateRangePickerPopover } from "./DateRangePopover.jsx";

export function PeriodRangeTabs({
  value,
  options,
  onChange,
  customKey = "custom",
  customRange,
  customRangeOpen = false,
  onCustomRangeOpenChange,
  onCustomRangeApply,
  activateCustomOnOpen = false,
  ariaLabel,
  tablistRef,
  onKeyDown,
  className = "",
}) {
  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`flex flex-1 min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {options.map((option) => {
        const key = option.key ?? option.value;
        const label = option.label ?? String(key);
        const active = value === key;
        const tabClass = `shrink-0 whitespace-nowrap text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
          active
            ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
            : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800"
        }`;

        if (key === customKey && customRange && onCustomRangeOpenChange && onCustomRangeApply) {
          return (
            <DateRangePickerPopover
              key={String(key)}
              open={Boolean(customRangeOpen)}
              onOpenChange={(open) => {
                if (open && activateCustomOnOpen) onChange?.(key);
                onCustomRangeOpenChange(open);
              }}
              from={customRange.from}
              to={customRange.to}
              active={active}
              label={label}
              trigger={
                <button
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  type="button"
                  className={tabClass}
                />
              }
              onApply={onCustomRangeApply}
            />
          );
        }

        return (
          <button
            key={String(key)}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            type="button"
            className={tabClass}
            onClick={() => onChange?.(key)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
