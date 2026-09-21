import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

// Mount the real page components with isolated usage stubs. No gateway, user
// database, desktop instance, external server, or production build is involved.
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: ["tests/e2e/fixtures/date-range.jsx"],
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
});

async function prepare(page: Page, view: string, language = "en") {
  await page.clock.install({ time: new Date("2026-09-21T12:00:00Z") });
  await page.route("http://date-range.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/app.js") {
      return route.fulfill({ contentType: "application/javascript", body: bundle });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    });
  });
  await page.goto(`http://date-range.test/?view=${view}&language=${language}`);
  await expect.poll(() => queries(page)).not.toEqual([]);
}

async function queries(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __dateQueries: Array<{ period?: string; from?: string; to?: string }>;
  }).__dateQueries);
}

function day(page: Page, value: string) {
  return page.locator(`[data-day="${value}"] button`).first();
}

for (const view of ["overview", "usage", "trend"]) {
  test(`${view}: calendar drafts commit only on Apply and reset after dismissal`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await prepare(page, view);
    const original = await queries(page);
    const selected = await page.locator('[role="tab"][aria-selected="true"]').textContent();
    const custom = page.getByRole("tab", { name: "Custom", exact: true });
    await custom.click();
    await expect(page.locator(".rdp-oai")).toBeVisible();
    await expect(page.locator(".rdp-oai table")).toHaveCount(2);
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText(selected!);
    expect(await queries(page)).toEqual(original);

    await day(page, "2026-09-10").click();
    await day(page, "2026-09-12").click();
    expect(await queries(page)).toEqual(original);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".rdp-oai")).toHaveCount(0);
    expect(await queries(page)).toEqual(original);

    await custom.click();
    await expect(page.locator('[data-day="2026-09-10"]')).not.toHaveAttribute("data-selected", "true");
    await day(page, "2026-09-10").click();
    await day(page, "2026-09-12").click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(custom).toHaveAttribute("aria-selected", "true");
    await expect(custom).toHaveText("Sep 10 — Sep 12");
    await expect(page.locator(".rdp-oai")).toHaveCount(0);
    await expect.poll(async () => (await queries(page)).at(-1)).toMatchObject({ from: "2026-09-10", to: "2026-09-12" });
    expect((await queries(page)).length).toBe(original.length + 1);

    for (const dismissal of ["escape", "outside"]) {
      await custom.click();
      await day(page, "2026-09-18").click();
      if (dismissal === "escape") await page.keyboard.press("Escape");
      else await page.getByRole("heading", { level: 1 }).click();
      await expect(page.locator(".rdp-oai")).toHaveCount(0);
      await expect(custom).toHaveText("Sep 10 — Sep 12");
      expect((await queries(page)).length).toBe(original.length + 1);
    }
    expect(errors).toEqual([]);
  });
}

test("overview: Chinese calendar labels, keyboard access and single-day selection", async ({ page }) => {
  await prepare(page, "overview", "zh");
  const original = await queries(page);
  await page.locator('[role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press("End");
  await expect(page.locator(".rdp-oai")).toBeVisible();
  expect(await queries(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeDisabled();
  await day(page, "2026-09-10").click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByRole("tab", { name: "自定义", exact: true })).toHaveText("9月 10");
  await expect.poll(async () => (await queries(page)).at(-1)).toMatchObject({ period: "custom", from: "2026-09-10", to: "2026-09-10" });
});

test("zoom: range and day controls use the same picker and Escape keeps the chart open", async ({ page }) => {
  await prepare(page, "zoom");
  const original = await queries(page);
  await page.getByRole("button", { name: "Pick a date range" }).click();
  await expect(page.locator(".rdp-oai table")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".rdp-oai")).toHaveCount(0);
  await expect(page.getByTestId("zoom-closed")).toHaveCount(0);
  expect(await queries(page)).toEqual(original);

  await page.getByRole("tab", { name: "30 min", exact: true }).click();
  await page.getByRole("button", { name: "Pick a day" }).click();
  await expect(page.locator(".rdp-oai table")).toHaveCount(2);
  await day(page, "2026-09-10").click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await queries(page)).at(-1)).toMatchObject({ period: "day", from: "2026-09-10", to: "2026-09-10" });
});
