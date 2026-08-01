import type { Pin } from "./schema.js";

/**
 * The capture allowlist.
 *
 * getComputedStyle returns ~340 properties in Chrome, nearly all resolved
 * defaults. Capturing everything buries the handful that matter and blows up
 * the agent payload. This list is fixed and identical for every pin — style
 * diffing depends on both sides having the same keys.
 */
export const STYLE_GROUPS = {
  layout: [
    "display",
    "position",
    "flex-direction",
    "justify-content",
    "align-items",
    "grid-template-columns",
  ],
  size: ["width", "height"],
  spacing: [
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "gap",
  ],
  typography: [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
  ],
  color: ["color", "background-color"],
  border: ["border-width", "border-style", "border-color"],
  radius: ["border-radius"],
  shadow: ["box-shadow"],
} as const satisfies Record<string, readonly string[]>;

export type StyleGroup = keyof typeof STYLE_GROUPS;

export const STYLE_ALLOWLIST: readonly string[] = Object.values(STYLE_GROUPS).flat();

/**
 * Expand a relationship's `properties` — which may hold friendly group names
 * ("spacing") or bare CSS properties ("border-radius") — into CSS properties.
 * Unknown entries pass through so a hand-written board still works.
 */
export function expandProperties(properties: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of properties) {
    const group = STYLE_GROUPS[entry as StyleGroup];
    if (group) out.push(...group);
    else out.push(entry);
  }
  return [...new Set(out)];
}

export interface StyleDiffEntry {
  property: string;
  from: string;
  to: string;
}

/**
 * The differentiator, computed rather than stored.
 *
 * "Make target match source" — so each entry reads as the change the agent
 * should apply to the *target*. Derived live so it can never drift from the
 * pins it describes.
 */
export function computeStyleDiff(
  source: Pin,
  target: Pin,
  properties: readonly string[],
): StyleDiffEntry[] {
  const diff: StyleDiffEntry[] = [];
  for (const property of expandProperties(properties)) {
    const to = source.computedStyles[property];
    const from = target.computedStyles[property];
    if (to === undefined || from === undefined) continue;
    if (to === from) continue;
    diff.push({ property, from, to });
  }
  return collapseShorthands(diff);
}

const SHORTHANDS: Record<string, readonly string[]> = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
};

/**
 * Collapse the four longhand box properties into one row when all four differ.
 * `padding: 32px 24px → 16px 20px` reads far better than four separate lines,
 * and costs the agent a quarter of the tokens.
 */
function collapseShorthands(diff: StyleDiffEntry[]): StyleDiffEntry[] {
  const byProperty = new Map(diff.map((e) => [e.property, e]));
  const out: StyleDiffEntry[] = [];
  const consumed = new Set<string>();

  for (const [shorthand, longhands] of Object.entries(SHORTHANDS)) {
    const entries = longhands.map((p) => byProperty.get(p));
    if (entries.some((e) => e === undefined)) continue;
    const present = entries as StyleDiffEntry[];
    out.push({
      property: shorthand,
      from: boxShorthand(present.map((e) => e.from)),
      to: boxShorthand(present.map((e) => e.to)),
    });
    longhands.forEach((p) => consumed.add(p));
  }

  for (const entry of diff) {
    if (!consumed.has(entry.property)) out.push(entry);
  }
  return out;
}

/** [top, right, bottom, left] → the shortest equivalent CSS shorthand. */
function boxShorthand(values: string[]): string {
  const [top, right, bottom, left] = values;
  if (top === right && right === bottom && bottom === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return values.join(" ");
}

/**
 * Render a pin's captured styles as one compact line, collapsing box
 * longhands the same way the diff does.
 */
export function formatStyles(styles: Record<string, string>): string {
  const parts: string[] = [];
  const consumed = new Set<string>();

  for (const [shorthand, longhands] of Object.entries(SHORTHANDS)) {
    const values = longhands.map((p) => styles[p]);
    if (values.some((v) => v === undefined)) continue;
    parts.push(`${shorthand}: ${boxShorthand(values as string[])}`);
    longhands.forEach((p) => consumed.add(p));
  }

  for (const [property, value] of Object.entries(styles)) {
    if (!consumed.has(property)) parts.push(`${property}: ${value}`);
  }
  return parts.join(" · ");
}
