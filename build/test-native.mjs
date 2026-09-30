import { readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packagePath = path.join(root, 'native/AgentRouterTray');
function swift(args) {
  const result = spawnSync('swift', [...args, '--package-path', packagePath], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (swift(['package', 'resolve']) !== 0) process.exit(1);

// Vortex's pinned manifest relies on Xcode implicitly compiling Assets.xcassets.
// Native SwiftPM does not infer this resource and cannot synthesize Bundle.module.
// Model tests only need the bundle accessor; use an explicit copy rule for this
// test run, then restore the dependency. Production builds still compile assets
// with Xcode, and the upstream dependency revision remains unchanged.
const manifest = path.join(packagePath, '.build/checkouts/Vortex/Package.swift');
const originalMode = statSync(manifest).mode;
const original = readFileSync(manifest, 'utf8');
const expected = '.target(\n            name: "Vortex")';
if (original.split(expected).length !== 2) throw new Error('Vortex manifest changed; review native test resource handling');
try {
  chmodSync(manifest, originalMode | 0o200);
  writeFileSync(manifest, original.replace(expected, '.target(\n            name: "Vortex", resources: [.copy("Resources/Assets.xcassets")])'));
  process.exitCode = swift(['test', '--build-system', 'native']);
} finally {
  writeFileSync(manifest, original);
  chmodSync(manifest, originalMode);
}
