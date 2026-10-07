const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { signAsync } = require('@electron/osx-sign');

module.exports = async function sign(options) {
  const widget = path.join(options.app, 'Contents/PlugIns/AgentRouterWidget.appex');
  if (!fs.existsSync(widget)) throw new Error('WidgetKit extension is required for macOS packaging');
  const launcher = path.join(options.app, 'Contents/Resources/app-launcher/AgentRouterAppLauncher');
  if (!fs.existsSync(launcher)) throw new Error('LaunchServices application launcher is required for macOS packaging');
  const originalIgnore = options.ignore;
  const originalOptions = options.optionsForFile;
  const memory = path.join(options.app, 'Contents/Resources/ai-memory/ai-memory');
  if (!fs.existsSync(memory)) throw new Error('Memory runtime is required for macOS packaging');
  // Sign the nested runtime first, record its signed bytes, then seal that
  // manifest with the outer app. Do not let osx-sign rewrite it a second time.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', options.identity || '-', '--options', 'runtime',
    '--entitlements', path.join(__dirname, 'entitlements.mac.inherit.plist'), memory]);
  const manifestFile = path.join(path.dirname(memory), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.releaseBinarySha256 = manifest.binarySha256;
  manifest.binarySha256 = crypto.createHash('sha256').update(fs.readFileSync(memory)).digest('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const isWidget = file => file === widget || file.startsWith(widget + path.sep);
  await signAsync({
    ...options,
    // osx-sign discovers executables but does not seal .appex bundles itself.
    binaries: [...(options.binaries || []), launcher, widget],
    ignore: file => file === memory ? true : isWidget(file) ? false : typeof originalIgnore === 'function' ? originalIgnore(file) : false,
    optionsForFile: file => ({
      ...(originalOptions ? originalOptions(file) : {}),
      ...(isWidget(file) ? {entitlements:path.join(__dirname,'../native/AgentRouterWidget/Widget.entitlements')} : {})
    })
  });
};
