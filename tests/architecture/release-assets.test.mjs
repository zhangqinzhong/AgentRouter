import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { validateReleaseAssets, verifyPublishedAssets } from '../../build/release-assets.mjs';

test('publication requires every platform and validates updater hashes before exposing a release', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ar-release-assets-'));
  const version = '1.12.0-rc.1';
  const names = ['mac-Apple-Silicon-arm64.zip', 'mac-Apple-Silicon-arm64.dmg', 'mac-Intel-x64.zip', 'mac-Intel-x64.dmg', 'win.exe', 'linux.AppImage'].map(name => `AgentRouter_${version}-${name}`);
  try {
    const files = names.map(name => {
      const bytes = Buffer.from(name); writeFileSync(path.join(root, name), bytes);
      return { url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') };
    });
    for (const [name, selected] of [['latest-mac.yml', files.slice(0, 4)], ['latest.yml', [files[4]]], ['latest-linux.yml', [files[5]]]]) writeFileSync(path.join(root, name), yaml.dump({ version, files: selected, path: selected[0].url, sha512: selected[0].sha512 }));
    const expected = validateReleaseAssets(root, version);
    const published = expected.map(asset => ({ name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}` }));
    verifyPublishedAssets(expected, published);
    assert.throws(() => verifyPublishedAssets(expected, published.slice(1)), /verification failed/);
    assert.throws(() => verifyPublishedAssets(expected, published.map((asset, i) => i ? asset : { ...asset, digest: 'sha256:invalid' })), /verification failed/);
    writeFileSync(path.join(root, names[0]), 'corrupt artifact');
    assert.throws(() => validateReleaseAssets(root, version), /checksum or size mismatch/);
    rmSync(path.join(root, names[5]));
    assert.throws(() => validateReleaseAssets(root, version), /Missing release platform/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
