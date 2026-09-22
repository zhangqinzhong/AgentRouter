import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(), entryPoints: ["tests/e2e/fixtures/page-defaults.jsx"],
    bundle: true, write: false, format: "iife", jsx: "automatic", platform: "browser",
    define: { "process.env.NODE_ENV": '"test"' }, tsconfig: path.resolve("tsconfig.json"),
    loader: { ".png": "dataurl", ".svg": "dataurl", ".ico": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".webp": "dataurl", ".gif": "dataurl" }
  });
  bundle = result.outputFiles[0].text;
});

async function calls(page: Page, method: string) {
  return page.evaluate(name => (window as any).__pageCalls.filter((call: any) => call.method === name), method);
}

test("four page defaults persist independently and control the first data requests", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://page-defaults.test/**", route => route.fulfill(
    new URL(route.request().url()).pathname === "/app.js"
      ? { contentType: "application/javascript", body: bundle }
      : { contentType: "text/html", body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' }
  ));
  await page.goto("http://page-defaults.test/");
  await expect.poll(async () => (await calls(page, "getUsageStats"))[0]?.args[0]).toBe("7d");
  expect((await calls(page, "getUsageStats")).every((call: any) => call.args[0] === "7d")).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Heatmap · Default time range", exact: true })).toHaveCount(0);
  const choices = { Overview: "today", Usage: "month", Sessions: "7d", Trend: "day" };
  for (const [label, value] of Object.entries(choices)) {
    await page.getByRole("combobox", { name: `${label} · Default time range`, exact: true }).selectOption(value);
  }
  const expected = { overview: "today", usage: "month", sessions: "7d", trend: "day" };
  await expect.poll(() => page.evaluate(() => (window as any).__savedPageDefaults)).toEqual(expected);
  await page.reload();
  await expect.poll(async () => (await calls(page, "getUsageStats"))[0]?.args[0]).toBe("today");

  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getLocalUsagePage"))[0]?.args[0]?.from).toMatch(/^\d{4}-\d{2}-01$/);
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getLocalUsageSessions"))[0]?.args[0]?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole("tablist", { name: "Filter by date range" }).getByRole("tab", { name: "All", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getLocalUsageSessions")).at(-1)?.args[0]?.from).toBeUndefined();
  await page.getByRole("button", { name: "Trend", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getLocalUsageTrend"))[0]?.args[0]?.period).toBe("day");
  await page.getByRole("button", { name: "Heatmap", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getLocalUsageHeatmap"))[0]?.args[0]?.weeks).toBe(53);
  await expect(page.getByRole("combobox", { name: "Heatmap time range" })).toHaveCount(0);
  expect((await calls(page, "getLocalUsageCategories")).every((call: any) => call.args[0].from === "")).toBe(true);

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect.poll(async () => (await calls(page, "getUsageStats")).at(-1)?.args[0]).toBe("today");
  expect(await calls(page, "startGateway")).toEqual([]);
  expect(await calls(page, "restartGateway")).toEqual([]);
  expect(errors).toEqual([]);
});

test("slow overview queries do not overlap or discard the first result on every poll", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-22T12:00:00Z") });
  await page.route("http://page-defaults.test/**", route => route.fulfill(
    new URL(route.request().url()).pathname === "/app.js"
      ? { contentType: "application/javascript", body: bundle }
      : { contentType: "text/html", body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' }
  ));
  await page.goto("http://page-defaults.test/?slowUsage=1");
  await page.clock.runFor(500);
  await expect.poll(async () => (await calls(page, "getUsageStats")).length).toBe(1);
  await page.clock.runFor(15000);
  expect((await calls(page, "getUsageStats")).length).toBe(1);
  await page.evaluate(() => (window as any).__releaseUsage());
  await expect(page.locator(".local-usage-page > .grid").first()).toContainText("128");
});
