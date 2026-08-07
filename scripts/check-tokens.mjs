/**
 * Prove that brand/tokens.json and ui.css still say the same thing.
 *
 * This exists because they already drifted once. Every colour in the extension
 * had been sampled off a rendered artboard instead of read from the Paper file,
 * and four of them were wrong — sky, cobalt, red, and a grey that did not exist
 * as a token at all. Nothing failed, because nothing was checking. The values
 * were plausible, so the drift survived a full build and a visual review.
 *
 * What this checks:
 *   1. Every primitive in tokens.json is defined in ui.css with the same value.
 *   2. Every semantic in tokens.json resolves to the primitive it claims.
 *   3. No semantic in ui.css hardcodes a hex where an alias belongs.
 *   4. Nothing references a --pin-* token that is never defined.
 *
 * What it deliberately does not check: whether Paper still agrees. That needs
 * the MCP server and a running app, so it stays a human step — but the
 * `paperToken` field in tokens.json is what makes that step mechanical.
 *
 *   node scripts/check-tokens.mjs
 */
import { readFileSync } from "node:fs";

const tokens = JSON.parse(readFileSync("brand/tokens.json", "utf8"));
const css = readFileSync("packages/extension/src/ui/ui.css", "utf8");

/** The `:where(.pin-root) { … }` block — the light scheme is the source of truth. */
const rootBlock = (() => {
  const start = css.indexOf(":where(.pin-root) {");
  if (start === -1) throw new Error("could not find the :where(.pin-root) block");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error("unterminated :where(.pin-root) block");
})();

/** Declared custom properties in that block, comments stripped. */
const declared = new Map();
for (const [, name, value] of rootBlock
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .matchAll(/(--pin-[\w-]+)\s*:\s*([^;]+);/g)) {
  declared.set(name, value.trim());
}

const problems = [];

for (const [name, spec] of Object.entries(tokens.primitive)) {
  const key = `--pin-${name}`;
  const actual = declared.get(key);
  if (!actual) problems.push(`primitive ${key} is in tokens.json but not in ui.css`);
  else if (actual.toLowerCase() !== spec.value.toLowerCase()) {
    problems.push(`primitive ${key}: tokens.json says ${spec.value}, ui.css says ${actual}`);
  }
}

for (const [name, spec] of Object.entries(tokens.semantic)) {
  const key = `--pin-${name}`;
  const actual = declared.get(key);
  if (!actual) {
    problems.push(`semantic ${key} is in tokens.json but not in ui.css`);
    continue;
  }
  const wantedRef = `--pin-${spec.ref}`;
  if (!actual.includes(wantedRef)) {
    problems.push(`semantic ${key}: should reference ${wantedRef}, but is "${actual}"`);
  }
  // A semantic that spells out a hex has cut its own reference — the exact
  // failure the two-layer split exists to prevent.
  if (/#[0-9a-f]{3,8}\b/i.test(actual)) {
    problems.push(`semantic ${key} hardcodes a hex ("${actual}") — alias a primitive instead`);
  }
  if (spec.alpha !== undefined && !actual.includes("color-mix")) {
    problems.push(`semantic ${key} declares alpha ${spec.alpha} but does not color-mix a primitive`);
  }
}

/**
 * Properties a component sets inline at runtime, so they never appear in the
 * stylesheet as a declaration. Each needs a reason — an unexplained entry here
 * is how a genuine typo gets waved through.
 */
const SET_AT_RUNTIME = new Map([
  ["--pin-card-radius", "PinObject.tsx — the pinned card takes its element's captured border-radius"],
  ["--pin-label-radius", "PinObject.tsx — the floating name bar follows the card's corners, capped at 8px"],
]);

/** Anything used across the whole stylesheet but never defined anywhere in it. */
const definedAnywhere = new Set([
  ...[...css.matchAll(/(--pin-[\w-]+)\s*:/g)].map((m) => m[1]),
  ...SET_AT_RUNTIME.keys(),
]);
const used = new Set([...css.matchAll(/var\((--pin-[\w-]+)/g)].map((m) => m[1]));
for (const name of used) {
  if (!definedAnywhere.has(name)) problems.push(`${name} is referenced but never defined`);
}

for (const [name, why] of SET_AT_RUNTIME) {
  if (!css.includes(`var(${name}`)) {
    problems.push(`${name} is allowlisted as runtime-set (${why}) but the stylesheet never reads it`);
  }
}

/** Tokens nothing uses. Not an error — dead weight worth seeing. */
const unused = [...definedAnywhere].filter(
  (name) => !used.has(name) && !name.startsWith("--pin-font") && !name.startsWith("--pin-mono"),
);

if (problems.length > 0) {
  console.error(`\n${problems.length} token problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

console.log(
  `tokens ok — ${Object.keys(tokens.primitive).length} primitives, ` +
    `${Object.keys(tokens.semantic).length} semantics, ${used.size} referenced`,
);
if (unused.length > 0) console.log(`unused: ${unused.join(", ")}`);
