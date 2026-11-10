import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
let bundle: string, css: string;
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['tests/e2e/fixtures/page-defaults.jsx'], plugins: process.env.AR_CAPTURE_BEFORE ? [{name:'baseline-overview',setup(build) {
    build.onLoad({filter:/packages\/ui\/src\/pages\/home\/(App|components\/overview)\.tsx$/}, args => ({contents:execFileSync('git',['show',`HEAD:${path.relative(process.cwd(),args.path)}`],{encoding:'utf8'}),loader:'tsx',resolveDir:path.dirname(args.path)}));
  }}] : [], bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', tsconfig: path.resolve('tsconfig.json'), define: {'process.env.NODE_ENV':'"test"'}, loader: {'.png':'dataurl','.svg':'dataurl','.ico':'dataurl','.jpg':'dataurl','.jpeg':'dataurl','.webp':'dataurl','.gif':'dataurl'} })).outputFiles[0].text;
  css = execFileSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs','-i','packages/ui/src/styles/globals.css','--minify'], {encoding:'utf8',maxBuffer:10*1024*1024});
});
for (const mode of ['light', 'dark', 'narrow'] as const) {
  test(`local model filter persists and keeps other models available (${mode})`, async ({page}) => {
    await page.setViewportSize({width:mode === 'narrow' ? 390 : 1440,height:1000});
    await page.emulateMedia({colorScheme:mode === 'dark' ? 'dark' : 'light'});
    await page.route('http://overview-filter.test/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill(url.pathname === '/app.js' ? {contentType:'application/javascript',body:bundle} : url.pathname === '/styles.css' ? {contentType:'text/css',body:css} : {contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'});
    });
    await page.goto('http://overview-filter.test/?modelFilters=1');
    const select = page.getByRole('combobox', {name:'Model',exact:true});
    await expect(select.locator('option')).toHaveCount(3);
    await select.selectOption('local-claude-model');
    // Allow the old configuration-validation effect (if present) to reset the selection.
    await page.waitForTimeout(300);
    const dir = 'output/overview-model-filter'; mkdirSync(dir,{recursive:true});
    await page.screenshot({path:`${dir}/${process.env.AR_CAPTURE_BEFORE ? 'before' : 'after'}-${mode}.png`,fullPage:true});
    if (process.env.AR_CAPTURE_BEFORE) return;
    await expect(select).toHaveValue('local-claude-model');
    await expect(select.locator('option')).toHaveCount(3);
    const totals = page.locator('.local-usage-page > .grid').first();
    await expect(totals).toContainText('4,800');
    await expect(totals).toContainText('$2.00');
    await select.selectOption('local-codex-model');
    await expect(totals).toContainText('7,200');
    await expect(totals).toContainText('$1.00');
    // Empty filtered ranges keep the chosen model visible rather than clearing it.
    await page.getByRole('tab',{name:'24h',exact:true}).click();
    await expect(select).toHaveValue('local-codex-model');
    await expect(page.getByText('No model usage yet', {exact:true})).toBeVisible();
    await select.selectOption('');
    await expect(totals).toContainText('12K');
    await expect(select.locator('option')).toHaveCount(3);
  });
}
