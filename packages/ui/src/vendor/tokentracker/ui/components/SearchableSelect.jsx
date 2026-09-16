import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Folder, Search as SearchIcon } from "lucide-react";
import { cn } from "../../lib/cn";

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-oai-black outline-none hover:bg-oai-gray-100 dark:text-white dark:hover:bg-oai-gray-800";

/**
 * SearchableSelect — a dropdown that lets you search a long list and pick one
 * option (or reset to the "all" entry). Built on Base UI Popover so it matches
 * the dashboard's existing menu styling, with a filter input at the top.
 *
 * @param {Object} props
 * @param {Array<{value: string, label: string}>} props.options
 * @param {string} props.value - Selected value, or `allValue` for no filter.
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.allValue] - Sentinel value for the reset entry.
 * @param {string} props.allLabel - Label for the reset entry / empty selection.
 * @param {string} [props.searchPlaceholder]
 * @param {string} [props.emptyLabel]
 * @param {string} [props.ariaLabel]
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  allValue = "all",
  allLabel,
  searchPlaceholder,
  emptyLabel,
  ariaLabel,
  disabled = false,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef(null);
  const listId = `${useId()}-listbox`;

  const selectedLabel = value === allValue
    ? allLabel
    : (options.find((option) => option.value === value)?.label ?? value);

  const query_ = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (query_ ? options.filter((option) => option.label.toLowerCase().includes(query_)) : options),
    [options, query_],
  );

  // One flat list of selectable rows: the "all" reset entry, then the matches.
  // Arrow keys walk it; -1 means nothing is highlighted yet.
  const rows = useMemo(
    () => [{ value: allValue, label: allLabel }, ...filtered],
    [allValue, allLabel, filtered],
  );
  const activeRow = activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex] : null;

  const select = (next) => {
    onChange(next);
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  };

  // Keep the highlighted row scrolled into view while navigating by keyboard.
  useEffect(() => {
    if (!open) return;
    // Optional call: jsdom does not implement scrollIntoView.
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const handleKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const down = event.key === "ArrowDown";
      setActiveIndex((prev) => {
        const count = rows.length;
        if (!count) return -1;
        if (down) return prev >= count - 1 ? 0 : prev + 1;
        return prev <= 0 ? count - 1 : prev - 1;
      });
      return;
    }
    if (event.key === "Enter") {
      // Commit the highlighted row, or the top match once the user has typed.
      // Enter on a freshly-opened dropdown must do nothing — it used to select
      // whichever project happened to sort first.
      const target = activeRow || (query_ && filtered.length ? filtered[0] : null);
      if (!target) return;
      event.preventDefault();
      select(target.value);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setActiveIndex(-1);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md border border-oai-gray-200 bg-oai-white px-2.5 text-xs font-medium transition hover:border-oai-gray-300 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 disabled:opacity-60 data-[popup-open]:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:hover:border-oai-gray-700",
          value !== allValue
            ? "text-oai-black dark:text-white"
            : "text-oai-gray-700 dark:text-oai-gray-200",
          className,
        )}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" aria-hidden />
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} side="bottom" align="start" className="z-[60]">
          <Popover.Popup className="w-56 overflow-hidden rounded-md border border-oai-gray-200 bg-white p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] outline-none dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
            <div className="relative mb-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-oai-gray-400" aria-hidden />
              <input
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={activeRow ? `${listId}-${activeIndex}` : undefined}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(-1);
                }}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded border border-oai-gray-200 bg-transparent pl-8 pr-2 text-xs text-oai-black outline-none placeholder:text-oai-gray-400 focus:border-oai-gray-400 dark:border-oai-gray-800 dark:text-white dark:focus:border-oai-gray-500"
              />
            </div>
            <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto">
              {rows.map((option, index) => (
                <button
                  key={option.value}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  data-active={index === activeIndex ? "true" : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option.value)}
                  className={cn(
                    ITEM_CLASS,
                    value === option.value && "bg-oai-gray-100 dark:bg-oai-gray-800",
                    index === activeIndex && "ring-1 ring-inset ring-oai-gray-300 dark:ring-oai-gray-600",
                  )}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  {value === option.value ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                </button>
              ))}
              {filtered.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-oai-gray-400 dark:text-oai-gray-500">{emptyLabel}</div>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
