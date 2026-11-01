#!/usr/bin/env node
// UI consistency guard for the renderer (packages/ui).
//
// Page code must take colours, sizes and controls from the design tokens
// (packages/ui/src/styles/tokens.css) and the shared components
// (packages/ui/src/components/ui). Existing violations are recorded per rule
// and per file in build/check-ui-baseline.json; the counts may only go down.
//
//   npm run check:ui                      check against the baseline
//   npm run check:ui -- --update-baseline lower the baseline after a cleanup
//
// See UI-STYLE-GUIDE.md §0 for the rules and how to fix each one.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");
export const baselinePath = path.join(projectRoot, "build", "check-ui-baseline.json");

const uiSrc = "packages/ui/src";
// Page code: everything the renderer ships except the shared components,
// third-party copies, generated files and static assets.
const scanRoots = [`${uiSrc}/pages`, `${uiSrc}/lib`];
const sharedComponentsDir = `${uiSrc}/components/ui/`;
const codeExtensions = /\.(?:[cm]?[jt]sx?)$/;

const paletteFamilies = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const paletteUtilities = "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow|inset-shadow|drop-shadow";

export const rules = {
  "raw-color": {
    summary: "Hex/rgb/hsl/oklch colour literal in page code",
    fix: "Use a semantic colour token (text-foreground, bg-muted, text-brand-ink, bg-status-ok, var(--data-input), …) from styles/tokens.css.",
    patterns: [
      /(?<![\w&#/.%-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
      /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g
    ]
  },
  "arbitrary-value": {
    summary: "Tailwind arbitrary value in page code",
    fix: "Use a token utility (text-body, max-w-page, rounded-md, …) or add a token to styles/tokens.css; reusable layout belongs in a shared component.",
    patterns: [
      // w-[13px], text-[#fff], grid-cols-[1fr_auto]; not arbitrary variants like data-[state=open]:
      /(?<![\w$.\-[])-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s'"`]+\](?!:)/g,
      // opacity/size modifiers: bg-emerald-500/[0.045]
      /(?<=[\w)\]])\/\[[^\]\s'"`]+\](?!:)/g,
      // arbitrary properties: [mask-type:luminance]
      /(?<=^|[\s"'`{:!])\[(?:--)?[a-z][a-z-]*:[^\]\s'"`]+\](?!:)/g
    ]
  },
  "palette-color": {
    summary: "Raw Tailwind palette colour in page code",
    fix: "Use a semantic colour (brand, brand-ink, brand-soft, status-*, data-*, destructive, muted-foreground, …). Add a semantic token if none fits.",
    patterns: [new RegExp(`(?<![\\w-])(?:${paletteUtilities})-(?:${paletteFamilies})-(?:50|[1-9]00|950)(?![\\w-])`, "g")]
  },
  "primitive-import": {
    summary: "Direct Radix/Base UI/lucide import outside the shared components",
    fix: "Import controls from @/components/ui/* and icons from @/components/ui/icons.",
    patterns: [/\bfrom\s*["'](?:@radix-ui\/[^"']+|@base-ui\/react[^"']*|lucide-react)["']|\bimport\s*\(?\s*["'](?:@radix-ui\/[^"']+|@base-ui\/react[^"']*|lucide-react)["']|\brequire\(\s*["'](?:@radix-ui\/[^"']+|lucide-react)["']\)/g]
  },
  "native-control": {
    summary: "Native <button>/<select> in page code",
    fix: "Use Button (variant/size props) or Select from @/components/ui; extend the shared component if a variant is missing.",
    jsxOnly: true,
    patterns: [/<(?:button|select)(?=[\s>/])/g]
  }
};

export const ruleIds = Object.keys(rules);

// Blank out comments while keeping line numbers. Comment markers inside
// strings are left alone as long as they are not preceded by whitespace.
export function stripComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, (match, lead) => lead + blank(match.slice(lead.length)))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (match, lead) => lead + blank(match.slice(lead.length)));
}

function isShared(relativePath) {
  return relativePath.replaceAll("\\", "/").startsWith(sharedComponentsDir);
}

// Scan one file's source. `relativePath` (repo-relative, forward slashes)
// decides which rules apply.
export function scanSource(source, relativePath) {
  const shared = isShared(relativePath);
  const jsx = /\.[cm]?[jt]sx$/.test(relativePath);
  const text = stripComments(source);
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const violations = [];
  for (const [rule, definition] of Object.entries(rules)) {
    if (shared) continue;
    if (definition.jsxOnly && !jsx) continue;
    for (const pattern of definition.patterns) {
      for (const match of text.matchAll(pattern)) {
        violations.push({ file: relativePath, line: lineOf(match.index), match: match[0].trim(), rule });
      }
    }
  }
  return violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function listFiles(root, relativeDir) {
  const absolute = path.join(root, relativeDir);
  if (!existsSync(absolute)) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (codeExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(relative);
  }
  return files;
}

export function scanProject(root = projectRoot) {
  return scanRoots.flatMap((dir) => listFiles(root, dir)).sort().flatMap((file) => scanSource(readFileSync(path.join(root, file), "utf8"), file));
}

export function countViolations(violations) {
  const counts = Object.fromEntries(ruleIds.map((rule) => [rule, {}]));
  for (const violation of violations) {
    counts[violation.rule][violation.file] = (counts[violation.rule][violation.file] || 0) + 1;
  }
  for (const rule of ruleIds) {
    counts[rule] = Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return counts;
}

// Compare current counts with the baseline. Any increase (including a new
// file) is a regression; any decrease means the baseline is stale and must be
// lowered so the improvement cannot be undone later.
export function compareWithBaseline(counts, baseline) {
  const regressions = [];
  const improvements = [];
  for (const rule of ruleIds) {
    const current = counts[rule] || {};
    const allowed = baseline.rules?.[rule] || {};
    for (const file of new Set([...Object.keys(current), ...Object.keys(allowed)])) {
      const now = current[file] || 0;
      const before = allowed[file] || 0;
      if (now > before) regressions.push({ after: now, before, file, rule });
      else if (now < before) improvements.push({ after: now, before, file, rule });
    }
  }
  return { improvements, regressions };
}

export function totals(counts) {
  return Object.fromEntries(ruleIds.map((rule) => [rule, Object.values(counts[rule] || {}).reduce((sum, value) => sum + value, 0)]));
}

export function readBaseline(file = baselinePath) {
  if (!existsSync(file)) return { rules: {} };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function formatBaseline(counts) {
  return `${JSON.stringify({
    $comment: "Per-rule, per-file counts of existing UI guard violations. Counts may only go down; regenerate with `npm run check:ui -- --update-baseline` after fixing violations.",
    totals: totals(counts),
    rules: counts
  }, null, 2)}\n`;
}

function main(argv) {
  const update = argv.includes("--update-baseline");
  // Only the very first run may create the baseline; after that it can only go down.
  const initialize = update && !existsSync(baselinePath);
  const violations = scanProject();
  const counts = countViolations(violations);
  const baseline = readBaseline();
  const { improvements, regressions } = compareWithBaseline(counts, baseline);

  if (initialize) {
    writeFileSync(baselinePath, formatBaseline(counts));
    console.log(`check:ui: wrote ${path.relative(projectRoot, baselinePath)}`, totals(counts));
    return 0;
  }

  if (regressions.length) {
    console.error("check:ui: new UI guard violations (the baseline may only go down):\n");
    for (const regression of regressions) {
      const definition = rules[regression.rule];
      console.error(`  [${regression.rule}] ${regression.file}: ${regression.before} -> ${regression.after}`);
      for (const violation of violations.filter((item) => item.rule === regression.rule && item.file === regression.file)) {
        console.error(`      ${violation.file}:${violation.line}  ${violation.match}`);
      }
      console.error(`      fix: ${definition.fix}`);
    }
    console.error("\nSee UI-STYLE-GUIDE.md §0. The baseline cannot be raised; fix the code instead.");
    return 1;
  }

  if (update) {
    writeFileSync(baselinePath, formatBaseline(counts));
    console.log("check:ui: baseline lowered", totals(counts));
    return 0;
  }

  if (improvements.length) {
    console.error("check:ui: violations went down; lock in the improvement with `npm run check:ui -- --update-baseline`:\n");
    for (const improvement of improvements) {
      console.error(`  [${improvement.rule}] ${improvement.file}: ${improvement.before} -> ${improvement.after}`);
    }
    return 1;
  }

  const summary = Object.entries(totals(counts)).map(([rule, count]) => `${rule}=${count}`).join(" ");
  console.log(`check:ui: OK (baseline: ${summary})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
