import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseVersion, validateReleasePlan, validateReleaseDocuments, validatePromotionFiles, validatePromotionContent } from '../../build/release-policy.mjs';

test('release increments follow the declared compatibility impact', () => {
  const plan = change => ({ baseVersion: '1.11.0', change, reason: 'Fixture change', candidate: change === 'major' ? 'v2.0.0-rc.1' : 'v1.12.0-rc.1' });
  for (const [version, change] of [['1.11.1', 'patch'], ['1.12.0', 'minor'], ['2.0.0', 'major']]) assert.equal(validateReleasePlan(version, plan(change)).core, version);
  assert.throws(() => validateReleasePlan('1.11.1', plan('minor')), /must be 1.12.0/);
  assert.throws(() => validateReleasePlan('1.12.1', plan('minor')), /must be 1.12.0/);
  assert.throws(() => validateReleasePlan('2.1.0', plan('major')), /must be 2.0.0/);
});
test('prereleases share a stable baseline and never masquerade as stable', () => {
  const plan = { baseVersion: '1.11.0', change: 'minor', reason: 'New collection settings', candidate: 'v1.12.0-rc.1' };
  assert.equal(validateReleasePlan('1.12.0-rc.1', plan).prerelease, true);
  assert.equal(validateReleasePlan('1.12.0-beta.2', plan).channel, 'beta');
  assert.equal(validateReleasePlan('1.12.0', plan).prerelease, false);
  for (const version of ['01.12.0', '1.12', '1.12.0-rc.0', '1.12.0-rc', '1.12.0;echo bad']) assert.throws(() => parseReleaseVersion(version));
});
test('release requests and dated notes must agree before tagging', () => {
  const docs = { request: '1.12.0\n', changelog: '## 1.12.0 - 2026-10-27\n', notes: 'New directory management.' };
  validateReleaseDocuments('1.12.0', docs);
  for (const patch of [{ request: '1.11.0' }, { notes: '' }, { changelog: '## 1.12.1 - 2026-10-27' }]) assert.throws(() => validateReleaseDocuments('1.12.0', { ...docs, ...patch }));
});

test('stable promotion only accepts tested code and patch notes cannot hide features', () => {
  validatePromotionFiles(['package.json', 'package-lock.json', '.github/release-request', 'docs/releases/1.12.0.md']);
  assert.throws(() => validatePromotionFiles(['packages/core/src/collector/service.ts']), /another candidate/);
  assert.throws(() => validateReleasePlan('1.12.0', { baseVersion: '1.11.0', change: 'minor', reason: 'New features' }));
  assert.throws(() => validateReleaseDocuments('1.11.1', { request: '1.11.1', changelog: '## 1.11.1 - 2026-10-27\n\n### Features\n- New panel', notes: 'Features', change: 'patch' }), /cannot use a patch/);
});

test('stable promotion cannot smuggle dependency changes through version files', () => {
  const before = JSON.stringify({ version: '1.12.0-rc.1', dependencies: { sdk: '1.0.0' } });
  validatePromotionContent('package.json', before, JSON.stringify({ version: '1.12.0', dependencies: { sdk: '1.0.0' } }));
  assert.throws(() => validatePromotionContent('package.json', before, JSON.stringify({ version: '1.12.0', dependencies: { sdk: '2.0.0' } })), /Dependencies/);
});
