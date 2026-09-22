import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let bundle: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(), entryPoints: ["tests/e2e/fixtures/heatmap-scroll.jsx"],
    bundle: true, write: false, format: "iife", jsx: "automatic", platform: "browser",
    define: { "process.env.NODE_ENV": '"test"' }, tsconfig: path.resolve("tsconfig.json"),
    loader: { ".png": "dataurl", ".svg": "dataurl", ".ico": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".webp": "dataurl", ".gif": "dataurl" }
  });
  bundle = result.outputFiles[0].text;
  const dir = mkdtempSync(path.join(tmpdir(), "ar-heatmap-scroll-"));
  try {
    const output = path.join(dir, "style.css");
    execFileSync(process.execPath, [path.resolve("node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i", "packages/ui/src/styles/globals.css", "-o", output, "--minify"]);
    css = readFileSync(output, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function prepare(page: Page, mode = "") {
  await page.route("http://heatmap-scroll.test/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    if (pathname === "/style.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ contentType: "text/html", body: '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
  });
  await page.goto(`http://heatmap-scroll.test/?mode=${mode}`);
  await expect(page.getByRole("region", { name: "Token activity" })).toBeVisible();
}

async function historyCalls(page: Page) {
  return page.evaluate(() => (window as any).__heatmapCalls.filter((call: any) => call.method === "history"));
}

test("wide heatmap preserves the original small cells and fits without forced scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await prepare(page);
  const viewport = page.getByRole("region", { name: "Token activity" });
  await expect(viewport.locator("button")).toHaveCount(53 * 7);
  await expect(viewport.locator("button").first()).toHaveCSS("width", "11px");
  await expect(viewport.locator("button").first()).toHaveCSS("height", "11px");
  await expect(viewport.locator(".grid")).toHaveCSS("row-gap", "3px");
  const geometry = await viewport.evaluate(node => ({ left: node.scrollLeft, width: node.clientWidth, content: node.scrollWidth }));
  expect(geometry.left).toBe(0);
  expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
  await expect(page.getByRole("button", { name: "Show earlier" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show later" })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  expect(await historyCalls(page)).toEqual([]);
});

test("narrow heatmap scrolls naturally without changing cell size or appending empty history", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await prepare(page);
  const viewport = page.getByRole("region", { name: "Token activity" });
  await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  expect(await viewport.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(viewport.locator("button").first()).toHaveCSS("width", "11px");
  await viewport.hover();
  await page.mouse.wheel(-1500, 0);
  await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBe(0);
  await page.mouse.wheel(-1500, 0);
  await expect(viewport.locator("button")).toHaveCount(53 * 7);
  expect(await historyCalls(page)).toEqual([]);
});

test("empty dates keep the original neutral colors in light and dark themes", async ({ page }) => {
  for (const [mode, color] of [["empty", "rgb(235, 237, 240)"], ["dark", "rgb(18, 18, 18)"]]) {
    await prepare(page, mode);
    const viewport = page.getByRole("region", { name: "Token activity" });
    await expect(viewport.locator('[data-heatmap-day][data-heatmap-level="0"]').first()).toHaveCSS("background-color", color);
    await expect(viewport.locator("button")).toHaveCount(53 * 7);
  }
});
