import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let bundle: string;
let css: string;
test.use({ viewport: { width: 1400, height: 800 }, timezoneId: "UTC", reducedMotion: "reduce" });
test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: ["tests/e2e/fixtures/overview-trend-tooltip.jsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"test"' },
    tsconfig: path.resolve("tsconfig.json"),
    loader: { ".png": "dataurl", ".svg": "dataurl", ".ico": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".webp": "dataurl", ".gif": "dataurl" }
  });
  bundle = result.outputFiles[0].text;
  const directory = mkdtempSync(path.join(tmpdir(), "ar-trend-tooltip-"));
  try {
    const output = path.join(directory, "styles.css");
    execFileSync(process.execPath, [
      path.resolve("node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i", "packages/ui/src/styles/globals.css", "-o", output, "--minify"
    ]);
    css = readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function openChart(page: Page, fixture: Record<string, unknown>) {
  await page.clock.install();
  await page.addInitScript((value) => {
    (window as unknown as { __overviewTrendFixture: unknown }).__overviewTrendFixture = value;
  }, fixture);
  await page.route("http://overview-trend.test/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    });
  });
  await page.goto("http://overview-trend.test/");
  await expect(page.locator(".recharts-area-curve")).toBeVisible();
  await page.clock.runFor(2_000);
}

// Compute the pointer position from the actual plot bounds and the selected
// time bucket's ordinal, independently of the chart's category lookup.
async function hoverBucket(page: Page, index: number, count: number) {
  const plot = await page.locator(".recharts-cartesian-grid-horizontal line").first().boundingBox();
  const chart = (await page.locator(".recharts-wrapper").boundingBox())!;
  expect(plot).not.toBeNull();
  // Recharts reveals the initial area through an animated clip rectangle.
  // Wait for the whole plot, so the test also produces meaningful screenshots.
  const animationClip = page.locator('clipPath[id^="animationClipPath-"] rect');
  if (await animationClip.count()) expect(Number(await animationClip.first().getAttribute("width"))).toBeGreaterThan(plot!.width - 2);
  const pointer = { x: plot!.x + plot!.width * index / (count - 1), y: chart.y + chart.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.clock.runFor(500);
  const tooltip = page.locator(".recharts-tooltip-wrapper");
  await expect(tooltip).toBeVisible();
  return { tooltip, pointer };
}

async function expectActiveDotAtPointer(page: Page, pointer: { x: number }) {
  const dot = page.locator(".recharts-active-dot circle");
  await expect(dot).toBeVisible();
  const box = (await dot.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - pointer.x)).toBeLessThan(2);
}

test("all-time overview tooltip resolves September 10 rather than the earlier March 10", async ({ page }) => {
  await openChart(page, {
    series: [
      { bucket: "2026-03-10", totalTokens: 18_126_000, costUsd: 8.38, requestCount: 267 },
      { bucket: "2026-09-10", totalTokens: 900_000_000, costUsd: 419, requestCount: 8_700 },
      { bucket: "2026-09-12", totalTokens: 1_000_000, costUsd: 1, requestCount: 10 }
    ]
  });
  const day = 86_400_000;
  const index = (Date.parse("2026-09-10") - Date.parse("2026-03-10")) / day;
  const count = (Date.parse("2026-09-12") - Date.parse("2026-03-10")) / day + 1;
  const { tooltip, pointer } = await hoverBucket(page, index, count);
  await expect(tooltip).toContainText("Sep 10, 2026");
  await expect(tooltip.locator('[title="900M · 900,000,000"]')).toHaveText("900M");
  await expect(tooltip).toContainText("$419.00");
  await expect(tooltip).toContainText("8,700");
  await expect(tooltip).toContainText("Recorded turns");
  await expect(tooltip).not.toContainText(/requests|conversations/i);
  await expect(tooltip).not.toContainText("Mar 10, 2026");
  await expectActiveDotAtPointer(page, pointer);
});

test("read-only production aggregates show the real peak date and exact token count", async ({ page }, testInfo) => {
  const filename = process.env.AR_OVERVIEW_REAL_DATA_FILE;
  test.skip(!filename, "Supply a read-only aggregate export to verify production data");
  const fixture = JSON.parse(readFileSync(filename!, "utf8"));
  const byDay = new Map<string, { tokens: number; cost: number; turns: number }>();
  for (const point of fixture.series) {
    const day = String(point.bucket).slice(0, 10);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const total = byDay.get(day) || { tokens: 0, cost: 0, turns: 0 };
    total.tokens += Number(point.totalTokens || 0);
    total.cost += Number(point.costUsd || 0);
    total.turns += Number(point.requestCount || 0);
    byDay.set(day, total);
  }
  expect(byDay.size).toBeGreaterThan(1);
  const days = [...byDay.keys()].sort();
  const [peakDay, peak] = [...byDay.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0];
  const first = Date.parse(days[0]);
  const count = (Date.parse(days[days.length - 1]) - first) / 86_400_000 + 1;
  const index = (Date.parse(peakDay) - first) / 86_400_000;
  await openChart(page, { ...fixture, language: "en", range: "all" });
  const { tooltip, pointer } = await hoverBucket(page, index, count);
  const label = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC"
  }).format(new Date(peakDay));
  await expect(tooltip).toContainText(label);
  const exactTokens = new Intl.NumberFormat("en-US").format(peak.tokens);
  await expect(tooltip.locator("span[title]").first()).toHaveAttribute("title", new RegExp(`${exactTokens}$`));
  const [integer, decimals] = peak.cost.toFixed(6).split(".");
  const cost = `$${Number(integer).toLocaleString("en-US")}.${decimals.slice(0, 2)}`;
  await expect(tooltip).toContainText(cost);
  if (peak.turns > 0) {
    await expect(tooltip).toContainText(peak.turns.toLocaleString("en-US"));
    await expect(tooltip).toContainText("Recorded turns");
  }
  await expectActiveDotAtPointer(page, pointer);
  await testInfo.attach("real-peak.json", {
    body: JSON.stringify({ day: peakDay, ...peak, buckets: byDay.size }),
    contentType: "application/json"
  });
  const screenshot = await page.screenshot({ animations: "disabled" });
  await testInfo.attach("real-peak.png", { body: screenshot, contentType: "image/png" });
  if (process.env.AR_OVERVIEW_REAL_DATA_SCREENSHOT) {
    await page.screenshot({ path: process.env.AR_OVERVIEW_REAL_DATA_SCREENSHOT, animations: "disabled" });
  }
});

test("monthly tooltip resolves the correct year when abbreviated month labels repeat", async ({ page }) => {
  await openChart(page, {
    period: "total",
    from: "2025-03-01",
    to: "2026-10-01",
    rows: [
      { month: "2025-09", total_tokens: 18_126_000, total_cost_usd: 8.38 },
      { month: "2026-09", total_tokens: 900_000_000, total_cost_usd: 419 }
    ]
  });
  const { tooltip, pointer } = await hoverBucket(page, 18, 20);
  await expect(tooltip).toContainText("Sep 2026");
  await expect(tooltip.locator('[title="900M · 900,000,000"]')).toHaveText("900M");
  await expect(tooltip).not.toContainText("Sep 2025");
  await expectActiveDotAtPointer(page, pointer);
});
