import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateReleasePlan, validateReleaseDocuments, parseReleaseVersion, validatePromotionFiles, validatePromotionContent } from './release-policy.mjs';
const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const read = file => JSON.parse(text(file));
const root = read('package.json');
const lock = read('package-lock.json');
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${root.version}`) throw new Error(`Tag ${tag} does not match version ${root.version}`);
for (const dir of ['packages/core', 'packages/ui', 'packages/cli', 'packages/electron']) {
  if (read(`${dir}/package.json`).version !== root.version || lock.packages[dir].version !== root.version) throw new Error(`Version mismatch in ${dir}`);
}
if (lock.version !== root.version || lock.packages[''].version !== root.version) throw new Error('Root lockfile version mismatch');
const plan = read('.github/release-plan.json');
const info = validateReleasePlan(root.version, plan);
validateReleaseDocuments(root.version, { request: text('.github/release-request'), changelog: text('CHANGELOG.md'), notes: text(`docs/releases/${root.version}.md`), change: plan.change });
const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], { encoding: 'utf8' }).trim().split('\n');
const baselines = tags.flatMap(tag => {
  try { const v = parseReleaseVersion(tag.slice(1)); return v.channel === 'stable' && v.core !== info.core ? [v] : []; } catch { return []; }
}).sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
if (!baselines.length || baselines[0].core !== info.baseVersion) throw new Error(`Release baseline ${info.baseVersion} must match the latest reachable stable tag. Fetch complete tags before checking.`);
if (!info.prerelease && info.candidate) {
  const candidate = `v${parseReleaseVersion(info.candidate.replace(/^v/, '')).core}-rc.${parseReleaseVersion(info.candidate.replace(/^v/, '')).sequence}`;
  execFileSync('git', ['merge-base', '--is-ancestor', candidate, 'HEAD']);
  const files = execFileSync('git', ['diff', '--name-only', `${candidate}..HEAD`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  validatePromotionFiles(files);
  for (const file of ['package.json', 'package-lock.json', ...['core', 'ui', 'cli', 'electron'].map(pkg => `packages/${pkg}/package.json`)]) {
    const before = execFileSync('git', ['show', `${candidate}:${file}`], { encoding: 'utf8' });
    validatePromotionContent(file, before, text(file));
  }
}
console.log(`AgentRouter ${root.version}: versions, ${info.channel} channel, ${read('.github/release-plan.json').change} increment and release documents verified.`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${info.tag}\nversion=${info.version}\nprerelease=${info.prerelease}\n`);
