import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import semver from "semver";

test("#1957 the npm Electron lock satisfies the patched desktop runtime floor", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const npm = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const range = manifest.devDependencies.electron;
  assert.ok(semver.gte(semver.minVersion(range), "42.11.18"));
  const npmVersion = npm.packages["node_modules/electron"].version;
  assert.ok(semver.satisfies(npmVersion, range));
  assert.equal(npm.packages[""].devDependencies.electron, range);
});
