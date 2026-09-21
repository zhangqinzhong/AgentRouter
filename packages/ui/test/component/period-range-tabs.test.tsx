import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeriodRangeTabs } from "../../src/vendor/tokentracker/ui/dashboard/components/PeriodRangeTabs";
import { DateRangePickerPopover } from "../../src/vendor/tokentracker/ui/dashboard/components/DateRangePopover";
import { setUsageLocale } from "../../src/vendor/tokentracker/lib/copy";
import { installBrowserGlobals } from "../fixtures/index";

installBrowserGlobals();

type Period = "today" | "all" | "custom";
const options: Array<{ key: Period; label: string }> = [
  { key: "today", label: "Today" },
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" }
];

function harness(dates = { from: "", to: "" }) {
  const calls: unknown[] = [];
  const tree = PeriodRangeTabs({
    value: "today",
    options,
    customRange: dates,
    customRangeOpen: false,
    onChange: (period) => calls.push(["period", period]),
    onCustomRangeOpenChange: (open) => calls.push(["open", open]),
    onCustomRangeApply: (from, to) => calls.push(["dates", from, to])
  });
  const children = React.Children.toArray(tree.props.children) as React.ReactElement[];
  const picker = children.find((child) => child.type === DateRangePickerPopover)!;
  return { calls, children, picker, tree };
}

test("custom range opening and dismissal never activate empty or previously saved dates", () => {
  for (const dates of [{ from: "", to: "" }, { from: "2026-09-01", to: "2026-09-03" }]) {
    const { calls, picker } = harness(dates);
    picker.props.onOpenChange(true);
    picker.props.onOpenChange(false);
    assert.deepEqual(calls, [["open", true], ["open", false]]);
  }
});

test("custom range application saves dates before activating the selected range", () => {
  const { calls, picker } = harness();
  picker.props.onApply("2026-09-01", "2026-09-03");
  assert.deepEqual(calls, [["dates", "2026-09-01", "2026-09-03"], ["period", "custom"]]);
});

test("switching to a preset closes the calendar and preserves the All option", () => {
  const { calls, children } = harness();
  const all = children.find((child) => child.props.children === "All")!;
  all.props.onClick();
  assert.deepEqual(calls, [["open", false], ["period", "all"]]);
});

test("a custom option without date controls cannot submit an invalid range", () => {
  const html = renderToStaticMarkup(<PeriodRangeTabs value="today" options={options} />);
  assert.match(html, />Today</);
  assert.match(html, />All</);
  assert.doesNotMatch(html, /Custom/);
});

test("shared date trigger uses localized range labels and a stable accessible name", () => {
  for (const [language, expected] of [["zh", /9月 1 — 9月 3/], ["en", /Sep 1 — Sep 3/]] as const) {
    setUsageLocale(language);
    const html = renderToStaticMarkup(
      <PeriodRangeTabs
        value="custom"
        options={options}
        customRange={{ from: "2026-09-01", to: "2026-09-03" }}
        customRangeOpen={false}
        onCustomRangeOpenChange={() => undefined}
        onCustomRangeApply={() => undefined}
      />
    );
    assert.match(html, expected);
    assert.match(html, /aria-label="Custom"/);
    assert.match(html, /aria-selected="true"/);
    assert.doesNotMatch(html, /type="date"/);
  }
  setUsageLocale("zh");
});

test("all consumers share keyboard navigation without handling calendar arrow keys", () => {
  const { tree } = harness();
  const calls: string[] = [];
  const tabs = ["today", "all", "custom"].map((value) => ({
    disabled: false,
    focus: () => calls.push(`focus:${value}`),
    click: () => calls.push(`click:${value}`)
  }));
  const event = {
    key: "End",
    defaultPrevented: false,
    currentTarget: { contains: () => true, querySelectorAll: () => tabs },
    target: { closest: () => tabs[0] },
    preventDefault: () => calls.push("prevent")
  };
  tree.props.onKeyDown(event);
  assert.deepEqual(calls, ["prevent", "focus:custom", "click:custom"]);
  calls.length = 0;
  tree.props.onKeyDown({ ...event, key: "ArrowRight", target: { closest: () => null } });
  assert.deepEqual(calls, []);
});
