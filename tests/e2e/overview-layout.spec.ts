import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real overview + production CSS, isolated data. Geometry checks only: no
// screenshots, running gateway, user database or preview assets are involved.
let bundle: string;
let css: string;
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
  const dir = mkdtempSync(path.join(tmpdir(), "ar-overview-layout-"));
  try {
    const output = path.join(dir, "styles.css");
    execFileSync(process.execPath, [
      path.resolve("node_modules/@tailwindcss/cli/dist/index.mjs"),
      "-i", "packages/ui/src/styles/globals.css", "-o", output, "--minify"
    ]);
    css = readFileSync(output, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const language of ["en", "zh"]) {
  for (const width of [1280, 860, 390]) {
    test(`overview aligns dates right and distributes statistics (${language}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.route("http://overview-layout.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
        if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: css });
        return route.fulfill({
          contentType: "text/html",
          body: '<html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
        });
      });
      await page.goto(`http://overview-layout.test/?view=overview&language=${language}`);
      const shell = page.locator(".local-usage-page").first();
      const heading = shell.locator("h1");
      await expect(heading).toBeVisible();
      const header = heading.locator("..");
      const tabs = header.getByRole("tablist");
      const grid = shell.locator(":scope > .grid");
      await expect(grid.locator(":scope > div")).toHaveCount(4);

      const headingBox = (await heading.boundingBox())!;
      const tabsBox = (await tabs.boundingBox())!;
      const gridBox = (await grid.boundingBox())!;
      expect(Math.abs(tabsBox.x + tabsBox.width - gridBox.x - gridBox.width)).toBeLessThan(2);
      if (width >= 640) {
        expect(Math.abs(headingBox.y + headingBox.height / 2 - tabsBox.y - tabsBox.height / 2)).toBeLessThan(2);
        expect(tabsBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
      }
      const cells = await grid.locator(":scope > div").evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          const value = element.querySelector("span:nth-child(2)")!.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, valueLeft: value.x, valueRight: value.right };
        })
      );
      expect(Math.abs(cells[0].x - gridBox.x)).toBeLessThan(1);
      expect(Math.abs(cells[0].valueLeft - gridBox.x)).toBeLessThan(1);
      expect(Math.abs(cells[3].valueRight - gridBox.x - gridBox.width)).toBeLessThan(1);
      if (width >= 640) {
        const gaps = cells.slice(1).map((cell, index) => cell.x - cells[index].x - cells[index].width);
        for (const gap of gaps) expect(Math.abs(gap - gaps[0])).toBeLessThan(1);
      }
      const columns = width >= 640 ? 4 : 2;
      expect(Math.abs(cells[columns - 1].x + cells[columns - 1].width - gridBox.x - gridBox.width)).toBeLessThan(1);
      expect(new Set(cells.map((cell) => Math.round(cell.y))).size).toBe(4 / columns);
      const headerOverflow = await header.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(headerOverflow).toBeLessThanOrEqual(1);
    });
  }
}
