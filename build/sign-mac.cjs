const path = require('node:path');
const fs = require('node:fs');
const { signAsync } = require('@electron/osx-sign');

module.exports = async function sign(options) {
  const widget = path.join(options.app, 'Contents/PlugIns/AgentRouterWidget.appex');
  if (!fs.existsSync(widget)) throw new Error('Packaged WidgetKit extension is missing');
  const originalIgnore = options.ignore;
  const originalOptions = options.optionsForFile;
  const isWidget = file => file === widget || file.startsWith(widget + path.sep);
  await signAsync({
    ...options,
    // osx-sign discovers executables but does not seal .appex bundles itself.
    binaries: [...(options.binaries || []), widget],
    ignore: file => isWidget(file) ? false : typeof originalIgnore === 'function' ? originalIgnore(file) : false,
    optionsForFile: file => ({
      ...(originalOptions ? originalOptions(file) : {}),
      ...(isWidget(file) ? {entitlements:path.join(__dirname,'../native/AgentRouterWidget/Widget.entitlements')} : {})
    })
  });
};
