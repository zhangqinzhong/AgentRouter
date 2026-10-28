import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let bundle: string, css: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/e2e/fixtures/data-sources.jsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', tsconfig: path.resolve('tsconfig.json'), define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ico': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' } });
  bundle = result.outputFiles[0].text;
  const root = mkdtempSync(path.join(os.tmpdir(), 'ar-data-sources-css-'));
  try { const output = path.join(root, 'styles.css'); execFileSync(process.execPath, [path.resolve('node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', 'packages/ui/src/styles/globals.css', '-o', output, '--minify']); css = readFileSync(output, 'utf8'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
async function open(page: Page) {
  await page.addInitScript(() => {
    const state: any = { sources: [{ agent: 'claude-code', name: 'Claude Code', paths: ['/home/test/.claude/projects'], enabled: true, available: true }], locations: [] };
    (window as any).__calls = [];
    (window as any).agentrouter = { sessionWorkspace: async (q: any) => {
      (window as any).__calls.push(q);
      if (q.op === 'settings') return structuredClone(state);
      if (q.op === 'location-add') {
        if (q.path === '/missing') throw new Error('Directory not found');
        state.locations.push([q.agent, q.path]); state.sources.push({ agent: q.agent, name: 'Claude Code', paths: [q.path + '/projects'], enabled: true, available: true });
      }
      if (q.op === 'location-state') state.sources.find((s: any) => s.paths.includes(q.path)).enabled = q.enabled;
      if (q.op === 'location-remove') { state.locations = state.locations.filter((x: any) => x[1] !== q.path); state.sources = state.sources.filter((s: any) => s.paths[0] !== q.path + '/projects'); }
      if (q.op === 'collection-refresh' && (window as any).__slowCollect) return new Promise(resolve => { (window as any).__finishCollection = resolve; });
      return { ok: true };
    } };
  });
  await page.route('http://data-sources.test/**', route => {
    const name = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: name === '/app.js' ? 'application/javascript' : name === '/styles.css' ? 'text/css' : 'text/html', body: name === '/app.js' ? bundle : name === '/styles.css' ? css : '<html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
  });
  await page.goto('http://data-sources.test/');
  await expect(page.getByText('/home/test/.claude/projects', { exact: true })).toBeVisible();
}
test('add, disable, re-enable and remove an isolated Claude directory', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: '数据目录' }).fill('/private/Claude Official/code');
  await page.getByRole('button', { name: '添加目录' }).click();
  const root = '/private/Claude Official/code/projects';
  await expect(page.getByText(root, { exact: true })).toBeVisible();
  const toggle = page.getByRole('switch', { name: '采集目录 ' + root });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '移除 ' + root }).click();
  await expect(page.getByText(root, { exact: true })).toHaveCount(0);
  await expect(page.getByText('/home/test/.claude/projects', { exact: true })).toBeVisible();
});
test('invalid paths keep the form and existing rows; slow collection never clears the page', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: '数据目录' }).fill('/missing'); await page.getByRole('button', { name: '添加目录' }).click();
  await expect(page.getByRole('alert')).toContainText('目录不存在');
  await expect(page.getByRole('textbox', { name: '数据目录' })).toHaveValue('/missing');
  await page.evaluate(() => { (window as any).__slowCollect = true; });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.getByRole('button', { name: '正在更新本地用量…' })).toBeDisabled();
  await expect(page.getByText('/home/test/.claude/projects', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__finishCollection({ ok: true }));
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeEnabled();
});
test('directory settings remain usable at a narrow window width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 }); await open(page);
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await expect(page.getByRole('textbox', { name: '数据目录' })).toBeVisible();
});
