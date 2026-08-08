/**
 * Keep the extension's typography native and intentional.
 *
 * The UI should use the platform's own interface face: SF Pro through Apple's
 * system aliases, and Segoe UI on Windows. This check also holds the small
 * tracking system together as one contract.
 *
 *   node scripts/check-typography.mjs
 */
import { readFileSync } from "node:fs";

const css = readFileSync("packages/extension/src/ui/ui.css", "utf8");
const extensionPackage = JSON.parse(
  readFileSync("packages/extension/package.json", "utf8"),
);

const problems = [];
const geistDependency = extensionPackage.dependencies?.["@fontsource-variable/geist"];

if (geistDependency) {
  problems.push("@fontsource-variable/geist is still an extension dependency");
}

if (css.includes("@fontsource-variable/geist")) {
  problems.push("ui.css still imports Geist");
}

if (
  !css.includes(
    '--pin-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif;',
  )
) {
  problems.push("--pin-font does not use the SF Pro / Segoe UI native system stack");
}

for (const [token, value] of [
  ["--pin-tracking-ui", "-0.01em"],
  ["--pin-tracking-label", "0.06em"],
]) {
  if (!css.includes(`${token}: ${value};`)) {
    problems.push(`${token} is missing or is not ${value}`);
  }
}

for (const selector of [".pin-btn", ".pin-tab", ".pin-tab-action", ".pin-row__title", ".pin-rename"]) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escaped}\\s*\\{[^}]*letter-spacing:\\s*var\\(--pin-tracking-ui\\)`, "s");
  if (!block.test(css)) problems.push(`${selector} does not use --pin-tracking-ui`);
}

if (!/\.pin-section-label\s*\{[^}]*letter-spacing:\s*var\(--pin-tracking-label\)/s.test(css)) {
  problems.push(".pin-section-label does not use --pin-tracking-label");
}

if (problems.length > 0) {
  console.error(`\n${problems.length} typography problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("typography ok — native SF Pro / Segoe UI stack; restrained UI and label tracking");
