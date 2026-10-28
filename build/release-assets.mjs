import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { parseReleaseVersion } from './release-policy.mjs';

export function validateReleaseAssets(directory, version) {
  parseReleaseVersion(version);
  const names = readdirSync(directory).filter(name => statSync(path.join(directory, name)).isFile());
  const required = [/mac-Apple-Silicon-arm64\.zip$/, /mac-Apple-Silicon-arm64\.dmg$/, /mac-Intel-x64\.zip$/, /mac-Intel-x64\.dmg$/, /\.exe$/, /\.AppImage$/];
  for (const pattern of required) if (!names.some(name => name.includes(version) && pattern.test(name))) throw new Error(`Missing release platform artifact: ${pattern}`);
  for (const metadataName of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
    const metadata = yaml.load(readFileSync(path.join(directory, metadataName), 'utf8'));
    if (metadata?.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error(`Invalid update version/files: ${metadataName}`);
    for (const entry of metadata.files) {
      const name = decodeURIComponent(String(entry.url || ''));
      if (path.basename(name) !== name || !names.includes(name)) throw new Error(`Missing or unsafe update artifact: ${name}`);
      const bytes = readFileSync(path.join(directory, name));
      if (entry.size !== bytes.length || entry.sha512 !== createHash('sha512').update(bytes).digest('base64')) throw new Error(`Update checksum or size mismatch: ${name}`);
    }
    if (metadata.path && (!metadata.files.some(entry => entry.url === metadata.path && entry.sha512 === metadata.sha512))) throw new Error(`Default update artifact mismatch: ${metadataName}`);
  }
  return names.map(name => {
    const bytes = readFileSync(path.join(directory, name));
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

export function verifyPublishedAssets(expected, published) {
  for (const asset of expected) {
    const remote = published.find(item => item.name === asset.name);
    if (!remote || remote.size !== asset.size || remote.digest !== `sha256:${asset.sha256}`) throw new Error(`Published asset verification failed: ${asset.name}`);
  }
}
