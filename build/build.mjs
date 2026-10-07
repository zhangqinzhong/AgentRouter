import {buildMacOSAppLauncher} from "./macos-app-launcher.mjs";
import {buildNativeAppIcon} from "./native-app-icon.mjs";
import { bundleMemoryRuntime } from "./ai-memory-runtime.mjs";
import {buildNativeWidget} from "./native-widget.mjs";
import {syncBrand} from "./brand.mjs";
import { buildNativeTray } from "./native-tray.mjs";
import { buildBrowserRenderer, buildMain, buildRenderer, buildRequestLogBodyWorker, buildStyles, buildTrayRenderer, buildWebClientBridge, cleanDist, copyAppAssets, copyBrowserRendererHtml, copyBundledClaudeRuntimePlugins, copyModelCatalog, copyRendererHtml, copyTrayRendererHtml, syncUiRendererToRuntimeDists } from "./esbuild.config.mjs";

const mode = process.argv.includes("--dev") ? "development" : "production";

cleanDist();
buildMacOSAppLauncher();
buildNativeAppIcon();
syncBrand();
copyAppAssets();
copyBundledClaudeRuntimePlugins();
copyModelCatalog();
copyBrowserRendererHtml();
copyRendererHtml();
copyTrayRendererHtml();

await Promise.all([
  buildMain({ mode }),
  buildBrowserRenderer({ mode }),
  buildRenderer({ mode }),
  buildRequestLogBodyWorker({ mode }),
  buildTrayRenderer({ mode }),
  buildWebClientBridge({ mode }),
  buildStyles({ minify: mode === "production" })
]);

syncUiRendererToRuntimeDists();
await bundleMemoryRuntime({ platform: process.env.AR_BUILD_PLATFORM || process.platform, arch: process.env.AR_BUILD_ARCH || process.arch });
buildNativeTray();
buildNativeWidget();

console.log(`Built monorepo package assets in ${mode} mode.`);
