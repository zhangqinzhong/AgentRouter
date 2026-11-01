import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeAnchoredPopoverLayout, ListboxOption, ListboxSearch } from "@agentrouter/ui/components/ui/listbox.tsx";

const viewport = { height: 900, width: 1440 };

test("anchored popover opens below the trigger with the trigger width by default", () => {
  const layout = computeAnchoredPopoverLayout(
    { bottom: 132, left: 400, top: 100, width: 320 },
    viewport,
    { flipBelow: 152, maxHeight: 152, minHeight: 120 }
  );
  assert.deepEqual(layout, { left: 400, maxHeight: 152, offset: 138, placement: "below", width: 320 });
});

test("anchored popover flips above when the room below is short and widens to minWidth", () => {
  const layout = computeAnchoredPopoverLayout(
    { bottom: 840, left: 1300, top: 808, width: 200 },
    viewport,
    { flipBelow: 280, maxHeight: 360, minHeight: 144, minViewportWidth: 240, minWidth: 280 }
  );
  assert.equal(layout.placement, "above");
  assert.equal(layout.width, 280);
  // Kept inside the 12px viewport margin.
  assert.equal(layout.left, 1440 - 12 - 280);
  assert.equal(layout.offset, 900 - 808 + 6);
  assert.equal(layout.maxHeight, 360);
});

test("anchored popover uses a fixed width capped by the viewport", () => {
  const layout = computeAnchoredPopoverLayout(
    { bottom: 60, left: 20, top: 20, width: 200 },
    { height: 700, width: 400 },
    { flipBelow: 240, maxHeight: 360, minHeight: 144, minViewportWidth: 240, width: 560 }
  );
  assert.equal(layout.width, 376);
  assert.equal(layout.left, 12);
});

test("anchored popover keeps the minimum height in a short viewport", () => {
  const layout = computeAnchoredPopoverLayout(
    { bottom: 150, left: 20, top: 120, width: 300 },
    { height: 200, width: 800 },
    { flipBelow: 260, maxHeight: 328, minHeight: 140 }
  );
  assert.equal(layout.placement, "above");
  assert.equal(layout.maxHeight, 140);
});

test("ListboxOption marks the selected option and shows a check", () => {
  const html = renderToStaticMarkup(
    <div role="listbox">
      <ListboxOption className="h-9 px-2" selected>Claude Code</ListboxOption>
      <ListboxOption className="h-9 px-2" selected={false}>Codex</ListboxOption>
    </div>
  );
  const [selected, unselected] = html.match(/<button[^>]*>/g) ?? [];
  assert.match(selected, /aria-selected="true"/);
  assert.match(selected, /role="option"/);
  assert.match(selected, /type="button"/);
  assert.match(unselected, /aria-selected="false"/);
  assert.match(html, /class="[^"]*bg-primary\/10 text-primary[^"]*"/);
  assert.match(html, /class="[^"]*text-foreground hover:bg-muted[^"]*"/);
  assert.equal(html.match(/lucide-check/g)?.length, 1);
});

test("ListboxOption with a checkbox indicator renders a read-only checkbox", () => {
  const html = renderToStaticMarkup(<ListboxOption indicator="checkbox" selected>OpenAI</ListboxOption>);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /bg-emerald-500\/\[0\.045\]/);
});

test("ListboxSearch renders a labelled input with a search icon", () => {
  const html = renderToStaticMarkup(<ListboxSearch aria-label="Filter" containerClassName="mb-1" placeholder="Filter" />);
  assert.match(html, /<div class="relative mb-1">/);
  assert.match(html, /lucide-search/);
  const input = html.match(/<input[^>]*>/)?.[0] ?? "";
  assert.match(input, /aria-label="Filter"/);
  assert.match(input, /class="[^"]*h-8[^"]*pl-8/);
});
