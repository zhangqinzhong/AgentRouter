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
  ariaLabel,
  tablistRef,
  onKeyDown,
  className = "",
}) {
  // Match the Usage page's keyboard navigation on every consumer. Calendar
  // navigation belongs to the popup, even though portal events bubble here.
  const handleKeyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !event.currentTarget.contains(tab)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]')).filter((item) => !item.disabled);
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  };

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
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

        if (key === customKey) {
          // A custom tab without a picker must not activate an invalid query.
          if (!customRange || !onCustomRangeOpenChange || !onCustomRangeApply) return null;
          return (
            <DateRangePickerPopover
              key={String(key)}
              open={Boolean(customRangeOpen)}
              onOpenChange={onCustomRangeOpenChange}
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
              onApply={(from, to) => {
                // Commit the dates before activating the query. Opening or
                // dismissing the picker must never submit an empty/stale range.
                onCustomRangeApply(from, to);
                onChange?.(key);
              }}
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
            onClick={() => {
              onCustomRangeOpenChange?.(false);
              onChange?.(key);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
