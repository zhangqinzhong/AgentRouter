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
type Source = { agent: string; name: string; paths: string[]; enabled: boolean; available: boolean };
const source = (agent: string, path: string, available = true, enabled = true): Source => ({ agent, name: agent === 'codex' ? 'Codex' : 'Claude Code', paths: [path], available, enabled });
async function open(page: Page, sources: Source[] = [], locations: string[][] = []) {
  await page.addInitScript(({ sources, locations }) => {
    const state: any = { sources: [{ agent: 'claude-code', name: 'Claude Code', paths: ['/home/test/.claude/projects'], enabled: true, available: true }, ...sources], locations };
    (window as any).__state = state;
    (window as any).__calls = [];
    (window as any).agentrouter = { sessionWorkspace: async (q: any) => {
      (window as any).__calls.push(q);
      if (q.op === 'settings') return structuredClone(state);
      if (q.op === 'location-add') {
        if (q.path === '/missing') throw new Error('Directory not found');
        state.locations.push([q.agent, q.path]); state.sources.push({ agent: q.agent, name: 'Claude Code', paths: [q.path + '/projects'], enabled: true, available: true });
      }
      if (q.op === 'location-state') state.sources.find((s: any) => s.paths.includes(q.path)).enabled = q.enabled;
      if (q.op === 'location-remove') { state.locations = state.locations.filter((x: any) => x[1] !== q.path); state.sources = state.sources.filter((s: any) => !(s.agent === q.agent && (s.paths[0] === q.path || s.paths[0].startsWith(q.path + '/')))); }
      if (q.op === 'collection-refresh' && (window as any).__slowCollect) return new Promise(resolve => { (window as any).__finishCollection = resolve; });
      return { ok: true };
    } };
  }, { sources, locations });
  await page.route('http://data-sources.test/**', route => {
    const name = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: name === '/app.js' ? 'application/javascript' : name === '/styles.css' ? 'text/css' : 'text/html', body: name === '/app.js' ? bundle : name === '/styles.css' ? css : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
  });
  await page.goto('http://data-sources.test/');
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeVisible();
}
test('add, disable, re-enable and remove an isolated Claude directory', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '添加目录' }).click();
  await page.getByRole('textbox', { name: '数据目录' }).fill('/private/Claude Official/code');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  const root = '/private/Claude Official/code';
  await expect(page.getByText(root, { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '采集目录 /home/test/.claude', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '数据目录' })).toHaveCount(0);
  const toggle = page.getByRole('switch', { name: '采集目录 ' + root });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeEnabled();
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByText(root, { exact: true }).click();
  await page.getByRole('button', { name: '移除 ' + root }).click();
  await expect(page.getByText(root, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeVisible();
});
test('invalid paths keep the form and existing rows; slow collection never clears the page', async ({ page }) => {
  await open(page, [source('claude-code', '/private/existing/projects')], [['claude-code', '/private/existing']]);
  await page.getByRole('button', { name: '添加目录' }).click();
  await page.getByRole('textbox', { name: '数据目录' }).fill('/missing'); await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('目录不存在');
  await expect(page.getByRole('textbox', { name: '数据目录' })).toHaveValue('/missing');
  await page.evaluate(() => { (window as any).__slowCollect = true; });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.getByRole('button', { name: '正在更新本地用量…' })).toBeDisabled();
  await expect(page.getByText('/private/existing', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__finishCollection({ ok: true }));
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeEnabled();
});
test('only manually added roots appear, including after refreshing automatic locations', async ({ page }) => {
  const root = '/home/test/.agentrouter/profiles/default-codex/codex';
  await open(page, [source('codex', '/home/test/.codex/sessions'), source('codex', root + '/sessions', false)]);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(page.getByText('尚未添加自定义目录', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__state.sources[2].available = true; });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeEnabled();
  await expect(page.getByRole('switch')).toHaveCount(0);
  const state = await page.evaluate(() => ({ calls: (window as any).__calls, sources: (window as any).__state.sources }));
  expect(state.calls.filter((q: any) => q.op === 'location-state')).toHaveLength(0);
  expect(state.sources.every((s: any) => s.enabled)).toBe(true);
});
test('Codex session and archive roots share a switch; missing archives retain their future scan preference', async ({ page }) => {
  await open(page, [source('codex', '/home/test/.codex/sessions'), source('codex', '/home/test/.codex/archived_sessions', false)], [['codex', '/home/test/.codex']]);
  const codex = page.getByRole('region', { name: 'Codex', exact: true });
  const toggle = codex.getByRole('switch', { name: '采集目录 /home/test/.codex' });
  await expect(codex.getByRole('switch')).toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(codex.getByText('~/.codex', { exact: true })).toBeVisible();
  await codex.getByText('自定义目录', { exact: true }).click();
  await expect(codex.getByText('/home/test/.codex/sessions', { exact: true })).toBeVisible();
  await expect(codex.getByText('目录不存在', { exact: true })).toBeVisible();
  await expect(codex.getByText('/home/test/.codex/archived_sessions', { exact: true })).toBeVisible();
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: '刷新用量' })).toBeEnabled();
  const calls = await page.evaluate(() => (window as any).__calls.filter((q: any) => q.op === 'location-state'));
  expect(calls.map((q: any) => [q.path, q.enabled])).toEqual([
    ['/home/test/.codex/sessions', false], ['/home/test/.codex/archived_sessions', false],
    ['/home/test/.codex/sessions', true], ['/home/test/.codex/archived_sessions', true]
  ]);
});
test('missing custom directories remain removable and refresh discovers newly created locations', async ({ page }) => {
  const root = '/private/isolated';
  await open(page, [source('claude-code', root + '/projects', false)], [['claude-code', root]]);
  const toggle = page.getByRole('switch', { name: '采集目录 ' + root });
  await expect(toggle).toBeVisible(); await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByText(root, { exact: true }).click();
  await expect(page.getByRole('button', { name: '移除 ' + root })).toBeEnabled();
  await page.evaluate(() => { (window as any).__state.sources[1].available = true; });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(toggle).toBeEnabled(); await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '移除 ' + root }).click();
  await expect(toggle).toHaveCount(0);
});
test('directory settings remain usable at a narrow window width with long paths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const root = '/home/test/Library/Application Support/Claude Official/extra-long-directory-name/code';
  await open(page, [source('claude-code', root + '/projects')], [['claude-code', root]]);
  await page.getByRole('button', { name: '添加目录' }).click();
  await expect(page.getByRole('textbox', { name: '数据目录' })).toBeVisible();
  const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await expect(page.getByRole('switch', { name: '采集目录 ' + root })).toBeVisible();
});
test('switches align without a delete column; removal lives in directory details and toggles never collect', async ({ page }) => {
  await open(page, [source('claude-code', '/private/isolated/projects'), source('claude-code', '/private/second/projects')], [['claude-code', '/private/isolated'], ['claude-code', '/private/second']]);
  const switches = page.getByRole('region', { name: 'Claude Code', exact: true }).getByRole('switch');
  await expect(page.getByRole('button', { name: '移除 /private/isolated', exact: true })).toBeHidden();
  await page.getByText('/private/isolated', { exact: true }).click();
  await expect(page.getByRole('button', { name: '移除 /private/isolated', exact: true })).toBeVisible();
  await expect(switches).toHaveCount(2);
  const left = await switches.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
  expect(Math.max(...left) - Math.min(...left)).toBeLessThanOrEqual(0.5);
  const toggle = page.getByRole('switch', { name: '采集目录 /private/isolated', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const calls = await page.evaluate(() => (window as any).__calls);
  expect(calls.filter((q: any) => q.op === 'location-state')).toHaveLength(2);
  expect(calls.filter((q: any) => q.op === 'collection-refresh')).toHaveLength(0);
});
