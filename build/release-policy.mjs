import { isDeepStrictEqual } from 'node:util';
export function parseReleaseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.([1-9]\d*))?$/.exec(value);
  if (!match || ![match[1], match[2], match[3], match[5] || '1'].every(n => Number.isSafeInteger(Number(n)))) {
    throw new Error(`Invalid release version: ${value}. Use x.y.z, x.y.z-beta.N or x.y.z-rc.N.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), channel: match[4] || 'stable', sequence: Number(match[5] || 0), core: match.slice(1, 4).join('.') };
}

export function validateReleasePlan(version, plan) {
  const target = parseReleaseVersion(version);
  const base = parseReleaseVersion(plan?.baseVersion || '');
  if (base.channel !== 'stable') throw new Error('The release baseline must be a stable version.');
  if (!['major', 'minor', 'patch'].includes(plan?.change)) throw new Error('Declare major, minor or patch in .github/release-plan.json.');
  if (typeof plan.reason !== 'string' || !plan.reason.trim()) throw new Error('Explain the user-visible release change in release-plan.json.');
  const expected = plan.change === 'major' ? `${base.major + 1}.0.0`
    : plan.change === 'minor' ? `${base.major}.${base.minor + 1}.0`
    : `${base.major}.${base.minor}.${base.patch + 1}`;
  if (target.core !== expected) throw new Error(`${plan.change} release after ${plan.baseVersion} must be ${expected}, received ${version}.`);
  if (target.channel === 'stable' && plan.change !== 'patch') {
    const candidate = parseReleaseVersion(String(plan.candidate || '').replace(/^v/, ''));
    if (candidate.core !== target.core || candidate.channel !== 'rc') throw new Error('Feature and breaking releases must promote a matching RC candidate.');
  }
  return { ...target, version, tag: `v${version}`, prerelease: target.channel !== 'stable', baseVersion: plan.baseVersion, candidate: plan.candidate };
}

export function validateReleaseDocuments(version, { request, changelog, notes, change }) {
  if (request.trim() !== version) throw new Error('.github/release-request must match package.json.');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## ${escaped} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) throw new Error(`CHANGELOG.md has no dated entry for ${version}.`);
  const entry = changelog.split(new RegExp(`^## ${escaped} - .*\\n`, 'm'))[1]?.split(/^## /m)[0] || '';
  if (change === 'patch' && /^### (Features|New features|新增功能)/m.test(entry)) throw new Error('A feature release cannot use a patch increment.');
  if (!notes.trim()) throw new Error(`docs/releases/${version}.md is missing or empty.`);
}

export function validatePromotionFiles(files) {
  const metadata = /^(?:package(?:-lock)?\.json|packages\/(?:core|ui|cli|electron)\/package\.json|CHANGELOG\.md|docs\/releases\/[^/]+\.md|\.github\/release-(?:plan\.json|request))$/;
  const changed = files.filter(file => !metadata.test(file));
  if (changed.length) throw new Error(`Code changed since the RC; publish another candidate first: ${changed.join(', ')}`);
}

export function validatePromotionContent(file, before, after) {
  if (!/(?:^|\/)package(?:-lock)?\.json$/.test(file)) return;
  const strip = text => {
    const value = JSON.parse(text);
    delete value.version;
    if (file === 'package-lock.json') {
      for (const key of ['', 'packages/core', 'packages/ui', 'packages/cli', 'packages/electron']) {
        if (value.packages?.[key]) delete value.packages[key].version;
      }
    }
    return value;
  };
  if (!isDeepStrictEqual(strip(before), strip(after))) throw new Error(`Dependencies or package contents changed after the RC: ${file}`);
}
