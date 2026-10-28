import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateReleaseAssets, verifyPublishedAssets } from './release-assets.mjs';
import { parseReleaseVersion } from './release-policy.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tagged = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (head !== tagged) throw new Error('Release tag does not point to the checked-out commit.');
const prerelease = parseReleaseVersion(version).channel !== 'stable';
const artifactRoot = process.argv[2];
if (!artifactRoot) throw new Error('Usage: node build/publish-release.mjs <downloaded-artifacts>');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const repository = process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const stage = mkdtempSync(path.join(os.tmpdir(), 'ar-publish-'));
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []);
try {
  const files = walk(artifactRoot);
  const macMetadata = files.filter(file => path.basename(file) === 'latest-mac.yml');
  if (macMetadata.length !== 2) throw new Error('Both macOS architectures must be available before publication.');
  execFileSync(process.execPath, ['build/merge-macos-update-metadata.mjs', path.join(stage, 'latest-mac.yml'), ...macMetadata], { stdio: 'inherit' });
  for (const file of files) {
    const name = path.basename(file);
    if (!/^AgentRouter_.*\.(?:dmg|zip|exe|AppImage)(?:\.blockmap)?$/.test(name) && !['latest.yml', 'latest-linux.yml'].includes(name)) continue;
    if (existsSync(path.join(stage, name))) throw new Error(`Duplicate release asset: ${name}`);
    copyFileSync(file, path.join(stage, name));
  }
  let assets = validateReleaseAssets(stage, version);
  writeFileSync(path.join(stage, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n');
  assets = validateReleaseAssets(stage, version);
  const endpoint = `repos/${repository}/releases/tags/${tag}`;
  let release;
  try { release = JSON.parse(gh(['api', endpoint])); } catch { /* A new tag has no release yet. */ }
  if (release && !release.draft) {
    verifyPublishedAssets(assets, release.assets);
    if (release.prerelease !== prerelease) throw new Error('Published release channel differs from the requested channel.');
    console.log(`${tag} is already published with matching assets; no files were overwritten.`);
  } else {
    if (!release) gh(['release', 'create', tag, '--repo', repository, '--draft', '--title', `AgentRouter ${tag}`, '--notes-file', `docs/releases/${version}.md`, ...(prerelease ? ['--prerelease'] : [])]);
    gh(['release', 'upload', tag, '--repo', repository, '--clobber', ...assets.map(asset => path.join(stage, asset.name))]);
    release = JSON.parse(gh(['api', endpoint]));
    verifyPublishedAssets(assets, release.assets);
    gh(['release', 'edit', tag, '--repo', repository, '--draft=false', `--prerelease=${prerelease}`, `--latest=${!prerelease}`]);
    console.log(`Published ${tag} (${prerelease ? 'prerelease' : 'stable'}), ${assets.length} verified assets.`);
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
