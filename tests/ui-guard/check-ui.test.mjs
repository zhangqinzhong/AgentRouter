import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareWithBaseline, countViolations, ruleIds, scanSource, stripComments } from "../../build/check-ui.mjs";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const pagePath = (name) => `packages/ui/src/pages/home/components/${name}`;
const sharedPath = (name) => `packages/ui/src/components/ui/${name}`;

function fixture(rule, kind) {
  return readFileSync(path.join(fixturesDir, rule, `${kind}.tsx`), "utf8");
}

function expectedCount(source) {
  const match = source.match(/Expected: (\d+) /);
  assert.ok(match, "fail fixture must declare `Expected: N <rule> violations.`");
  return Number(match[1]);
}

for (const rule of ruleIds) {
  test(`${rule}: fail fixture is flagged`, () => {
    const source = fixture(rule, "fail");
    const found = scanSource(source, pagePath(`${rule}.tsx`)).filter((item) => item.rule === rule);
    assert.equal(found.length, expectedCount(source), found.map((item) => `${item.line}: ${item.match}`).join("\n"));
  });

  test(`${rule}: pass fixture is clean`, () => {
    const found = scanSource(fixture(rule, "pass"), pagePath(`${rule}.tsx`));
    assert.deepEqual(found, []);
  });
}

test("shared components may use primitives, native controls and raw values", () => {
  for (const rule of ruleIds) {
    assert.deepEqual(scanSource(fixture(rule, "fail"), sharedPath(`${rule}.tsx`)), [], rule);
  }
});

test("native-control only applies to JSX files", () => {
  const source = 'export const html = "<button>ok</button>";';
  assert.equal(scanSource(source, pagePath("markup.ts")).filter((item) => item.rule === "native-control").length, 0);
  assert.equal(scanSource(source, pagePath("markup.tsx")).filter((item) => item.rule === "native-control").length, 1);
});

test("violations report the original line number", () => {
  const found = scanSource('/* one\n two */\n// three\nexport const c = "#fff";\n', pagePath("lines.ts"));
  assert.deepEqual(found.map((item) => [item.rule, item.line]), [["raw-color", 4]]);
});

test("stripComments keeps URLs and line breaks", () => {
  const stripped = stripComments('const url = "https://example.com"; // #fff\n/* rgb(0,0,0) */ const a = 1;');
  assert.match(stripped, /https:\/\/example\.com/);
  assert.doesNotMatch(stripped, /#fff|rgb\(/);
  assert.equal(stripped.split("\n").length, 2);
});

test("baseline comparison rejects increases and stale counts", () => {
  const file = pagePath("a.tsx");
  const baseline = { rules: { "raw-color": { [file]: 2 } } };
  const same = countViolations([{ file, rule: "raw-color" }, { file, rule: "raw-color" }]);
  assert.deepEqual(compareWithBaseline(same, baseline), { improvements: [], regressions: [] });

  const more = countViolations([
    { file, rule: "raw-color" }, { file, rule: "raw-color" }, { file, rule: "raw-color" },
    { file: pagePath("b.tsx"), rule: "native-control" }
  ]);
  const { regressions } = compareWithBaseline(more, baseline);
  assert.deepEqual(regressions.map((item) => [item.rule, item.file, item.before, item.after]), [
    ["raw-color", file, 2, 3],
    ["native-control", pagePath("b.tsx"), 0, 1]
  ]);

  const fewer = countViolations([{ file, rule: "raw-color" }]);
  assert.deepEqual(compareWithBaseline(fewer, baseline).improvements.map((item) => [item.before, item.after]), [[2, 1]]);
});
