import {execFileSync} from 'node:child_process';
import {mkdirSync, copyFileSync} from 'node:fs';
import path from 'node:path';
export function buildMacOSAppLauncher() {
  if (process.platform !== 'darwin') return;
  const root = path.resolve(import.meta.dirname, '..');
  const output = path.join(root, 'packages/core/dist/main/app-launcher');
  mkdirSync(output, {recursive:true});
  const files = ['arm64', 'x86_64'].map(arch => {
    const file = path.join(output, `AgentRouterAppLauncher-${arch}`);
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx11.0`,
      path.join(root, 'native/AppLauncher/main.swift'), '-o', file], {stdio:'inherit'});
    return file;
  });
  const binary = path.join(output, 'AgentRouterAppLauncher');
  execFileSync('/usr/bin/lipo', ['-create', ...files, '-output', binary]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
  for (const pkg of ['electron', 'cli']) {
    const directory = path.join(root, `packages/${pkg}/dist/main/app-launcher`);
    mkdirSync(directory, {recursive:true});
    copyFileSync(binary, path.join(directory, 'AgentRouterAppLauncher'));
  }
}
if (process.argv[1] === import.meta.filename) buildMacOSAppLauncher();
