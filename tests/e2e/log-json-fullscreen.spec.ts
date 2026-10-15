import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let bundle: string;
let css: string;

test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    bundle: true,
    define: { "process.env.NODE_ENV": '"test"' },
    entryPoints: ["tests/e2e/fixtures/log-json-fullscreen.jsx"],
    format: "iife",
    jsx: "automatic",
    loader: { ".gif": "dataurl", ".ico": "dataurl", ".jpeg": "dataurl", ".jpg": "dataurl", ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    platform: "browser",
    plugins: [{
      name: "ui-alias",
      setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => ({ path: resolveUiFile(path.resolve("packages/ui/src", args.path.slice(2))) }));
        build.onResolve({ filter: /^@agentrouter\/core\// }, (args) => ({ path: resolveUiFile(path.resolve("packages/core/src", args.path.slice("@agentrouter/core/".length))) }));
      }
    }],
    tsconfig: path.resolve("tsconfig.json"),
    write: false
  });
  bundle = result.outputFiles[0].text;
  const dir = mkdtempSync(path.join(tmpdir(), "ar-log-json-fullscreen-"));
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

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`log JSON fullscreen fills the window (${theme}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.route("http://log-json-fullscreen.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/app.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
        if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: css });
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><head><link rel=\"stylesheet\" href=\"/styles.css\"></head><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>"
        });
      });
      await page.goto(`http://log-json-fullscreen.test/?theme=${theme}`);
      const pane = page.locator(".network-pane-body").first();
      await expect(pane).toBeVisible();
      await expect.poll(() => pane.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

      await page.getByRole("button", { name: "全屏查看 JSON" }).first().click();
      const dialog = page.getByRole("dialog", { name: "请求 全屏 JSON 查看器" });
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
      await expect(page.locator(".network-detail-panes [role='dialog']")).toHaveCount(0);

      const box = await dialog.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeLessThan(1);
      expect(box!.y).toBeLessThan(1);
      expect(box!.width).toBeGreaterThan(width - 2);
      expect(box!.height).toBeGreaterThan(798);
      const panel = await page.locator(".network-json-fullscreen-panel").boundingBox();
      expect(panel!.x).toBeLessThan(1);
      expect(panel!.y).toBeLessThan(1);
      expect(panel!.width).toBeGreaterThan(width - 2);
      expect(panel!.height).toBeGreaterThan(798);
      const jsonBody = await page.locator(".network-json-fullscreen-body").boundingBox();
      expect(jsonBody!.width).toBeGreaterThan(width - 2);
      expect(jsonBody!.height).toBeGreaterThan(640);

      const expected = theme === "dark" ? "rgb(20, 20, 20)" : "rgb(255, 255, 255)";
      const colors = await dialog.evaluate((element) => {
        const body = element.querySelector(".network-json-fullscreen-body");
        return {
          body: body ? getComputedStyle(body).backgroundColor : "",
          overlay: getComputedStyle(element).backgroundColor
        };
      });
      expect(colors.overlay).toBe(expected);
      expect(colors.body).toBe(expected);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

      const bottom = await page.evaluate(() => {
        const hit = document.elementFromPoint(20, window.innerHeight - 12);
        return Boolean(hit?.closest("[role='dialog']"));
      });
      expect(bottom).toBe(true);

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    });
  }
}

function resolveUiFile(filePath: string): string {
  const candidates = [
    filePath,
    `${filePath}.tsx`,
    `${filePath}.ts`,
    `${filePath}.jsx`,
    `${filePath}.js`,
    path.join(filePath, "index.tsx"),
    path.join(filePath, "index.ts")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return filePath;
}
