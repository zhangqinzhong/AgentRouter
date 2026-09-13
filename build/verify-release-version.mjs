import { readFileSync } from 'node:fs';
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const root = read('package.json');
const lock = read('package-lock.json');
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${root.version}`) throw new Error(`Tag ${tag} does not match version ${root.version}`);
for (const dir of ['packages/core', 'packages/ui', 'packages/cli', 'packages/electron']) {
  if (read(`${dir}/package.json`).version !== root.version || lock.packages[dir].version !== root.version) {
    throw new Error(`Version mismatch in ${dir}`);
  }
}
if (lock.version !== root.version || lock.packages[''].version !== root.version) throw new Error('Root lockfile version mismatch');
console.log(`AgentRouter ${root.version}: package and lockfile versions agree${tag ? ` with ${tag}` : ''}.`);
