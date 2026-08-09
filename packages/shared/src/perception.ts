import type { Applicability, StyleDiffEntry } from "./styles.js";

/**
 * Which differences a person can actually see — to order them, not to drop them.
 *
 * The distinction matters more here than it would in most products. A diff
 * between two cards runs to a dozen rows and only three of them are legible at
 * a glance, so a flat table makes the reader do the sorting. But the illegible
 * rows are not noise: "these look identical and one is 15px, the other 16px" is
 * drift, and catching drift is the reason this tool exists. Suppressing that
 * would be suppressing the finding.
 *
 * So `perceptible` means *demote*, never *discard*. The panel renders the three
 * you can see and keeps the rest one click away, still selected, still in the
 * brief. And `computeStyleDiff` is untouched either way — the agent receives
 * every row exact, because it is applying them rather than looking at them.
 */

/** Below this, two colours are the same colour to a person. CIE76, just-noticeable. */
const DELTA_E_JND = 2.3;

/**
 * How far a length has to move to register, in px and as a ratio.
 *
 * Both, because neither works alone: 1px → 2px doubles and nobody notices,
 * while 40px → 44px is a tenth and reads immediately at that size.
 */
const LENGTH_ABSOLUTE = 2;
const LENGTH_RELATIVE = 0.25;

/** Properties where a smaller move still reads, because they are set in fractions. */
const FINE_LENGTHS: Record<string, number> = {
  "letter-spacing": 0.4,
  "border-width": 0.75,
};

/**
 * Properties whose change is structural rather than a matter of degree. Any
 * difference at all rearranges the element, so there is no threshold to apply.
 *
 * This list is only safe because the applicability guard runs before it. "Alters
 * layout, therefore counts" is exactly the reasoning that would promote a
 * flex-derived width — a difference that is structural on paper and produces
 * nothing on screen, because the element would ignore the value. `flex-grow` and
 * `flex-basis` belong here for the same reason that width does not: they are the
 * properties that actually decide the axis, so changing them does something.
 */
const ALWAYS_PERCEPTIBLE = new Set([
  "display",
  "position",
  "flex-direction",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "text-align",
  "font-family",
  "font-weight",
  "border-style",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
]);

/** What a value is, for the purpose of drawing it rather than spelling it. */
export type ValueKind = "color" | "shadow" | "radius" | "box" | "gap" | "type" | "text";

export interface TokenChange {
  /** What this slot is called, when the value has named slots. */
  label: string | null;
  from: string;
  to: string;
  changed: boolean;
}

export interface DiffDetail extends StyleDiffEntry {
  /**
   * Whether a person can see this change at a glance. False demotes the row
   * behind a count — it never removes it, and never removes it from the brief.
   */
  perceptible: boolean;
  /**
   * Whether the change can manifest at all. An inapplicable change is never
   * perceptible, whatever its numbers say.
   */
  applicability: Applicability;
  kind: ValueKind;
  /**
   * The parts of a compound value, paired and marked. Null when the value is
   * a single token and there is nothing to break apart.
   */
  tokens: TokenChange[] | null;
  /** Only the parts that moved, as `y 1→4px · blur 2→12px`. Null when trivial. */
  summary: string | null;
}

/**
 * Classify and decompose one row of a computed diff.
 *
 * `applicability` is a parameter rather than something derived here, because
 * answering it needs both pins and this function only has the row. Callers
 * holding the pins should pass `applicabilityGuard(source, target)(property)`;
 * the default assumes applicable, which is correct for anything that already
 * came out of `computeStyleDiff` — the guard ran there.
 */
export function describeChange(
  entry: StyleDiffEntry,
  applicability: Applicability = { applicable: true, reason: null },
): DiffDetail {
  const kind = kindOf(entry.property);
  const tokens = kind === "shadow" ? shadowTokens(entry) : null;
  return {
    ...entry,
    kind,
    applicability,
    // An inert change cannot be a perceptible one, whatever its numbers say —
    // this is the guard that stops "layout always counts" promoting a width
    // that the flex row would override the moment it was written.
    perceptible: applicability.applicable && isPerceptible(entry, kind),
    tokens,
    summary: tokens ? summarize(tokens) : null,
  };
}

/**
 * Order a described diff into what to render and what to collapse behind a
 * count. Both halves are kept: this decides prominence, not inclusion.
 */
export function partitionByPerception(details: DiffDetail[]): {
  perceptible: DiffDetail[];
  subtle: DiffDetail[];
} {
  return {
    perceptible: details.filter((d) => d.perceptible),
    subtle: details.filter((d) => !d.perceptible),
  };
}

function kindOf(property: string): ValueKind {
  if (property === "box-shadow") return "shadow";
  if (property === "border-radius") return "radius";
  if (property === "gap") return "gap";
  if (property.endsWith("color")) return "color";
  if (property === "padding" || property === "margin") return "box";
  if (property.startsWith("padding-") || property.startsWith("margin-")) return "box";
  if (property.startsWith("font-") || property === "line-height" || property === "letter-spacing") {
    return "type";
  }
  return "text";
}

/**
 * Anything that cannot be parsed counts as perceptible.
 *
 * The failure modes are not symmetric: demoting a real change buries something
 * the reader wanted, while promoting a quiet one costs a row.
 */
function isPerceptible(entry: StyleDiffEntry, kind: ValueKind): boolean {
  if (ALWAYS_PERCEPTIBLE.has(entry.property)) return true;
  if (entry.from === "none" || entry.to === "none") return true;

  if (kind === "color") {
    const from = parseColor(entry.from);
    const to = parseColor(entry.to);
    if (!from || !to) return true;
    return deltaE(from, to) >= DELTA_E_JND;
  }

  if (kind === "shadow") {
    const tokens = shadowTokens(entry);
    if (!tokens) return true;
    return tokens.some((t) => t.changed && slotMoved(t));
  }

  return lengthListMoved(entry.property, entry.from, entry.to);
}

/** A shadow slot moves the shadow if the blur, the drop, or the colour moved. */
function slotMoved(token: TokenChange): boolean {
  if (token.label === "color") {
    const from = parseColor(token.from);
    const to = parseColor(token.to);
    return !from || !to || deltaE(from, to) >= DELTA_E_JND;
  }
  return lengthListMoved(token.label === "spread" ? "border-width" : "gap", token.from, token.to);
}

/**
 * `32px 24px → 16px 20px` is four numbers, and the row is worth showing if any
 * one of them moved enough. Lists of unequal length are a structural change.
 */
function lengthListMoved(property: string, from: string, to: string): boolean {
  const a = from.trim().split(/\s+/);
  const b = to.trim().split(/\s+/);
  if (a.length !== b.length) return true;
  return a.some((value, i) => lengthMoved(property, value, b[i]));
}

function lengthMoved(property: string, from: string, to: string): boolean {
  const a = parseFloat(from);
  const b = parseFloat(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return from !== to;
  const delta = Math.abs(a - b);
  if (delta === 0) return false;

  const floor = FINE_LENGTHS[property] ?? LENGTH_ABSOLUTE;
  if (delta >= floor) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && delta / base >= LENGTH_RELATIVE;
}

/* --------------------------------------------------------------- shadows */

/** Computed `box-shadow` in Chrome: `rgba(0, 0, 0, 0.08) 0px 4px 12px 0px`. */
const SHADOW_SLOTS = ["color", "x", "y", "blur", "spread"] as const;
const EMPTY_SHADOW = ["rgba(0, 0, 0, 0)", "0px", "0px", "0px", "0px"];

/**
 * Break both shadows into their slots and pair them.
 *
 * Two shadow strings differing in one number look identical until you compare
 * them character by character, which is work the reader should never be doing.
 * Named slots turn that into "the blur went from 2 to 12".
 */
function shadowTokens(entry: StyleDiffEntry): TokenChange[] | null {
  const from = splitShadow(entry.from);
  const to = splitShadow(entry.to);
  if (!from || !to) return null;

  return SHADOW_SLOTS.map((label, i) => ({
    label,
    from: from[i] ?? "0px",
    to: to[i] ?? "0px",
    changed: (from[i] ?? "0px") !== (to[i] ?? "0px"),
  })).filter((t) => t.from !== "0px" || t.to !== "0px" || t.changed);
}

/** Tokenize on whitespace without cutting `rgba(0, 0, 0, 0.08)` at its commas. */
function splitShadow(value: string): string[] | null {
  // `none` is still a complete side of the comparison. Treating it as an
  // unparsable value threw away the concise y/blur summary exactly when a
  // shadow was being added or removed.
  if (value.trim() === "none") return [...EMPTY_SHADOW];
  // More than one shadow layer is beyond what named slots can describe.
  if (value.split(/\),|,(?![^(]*\))/).length > 1 && !/^rgba?\(/.test(value)) return null;

  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens.length >= 3 ? tokens : null;
}

/** `y 1→4px · blur 2→12px` — only the slots that moved. */
function summarize(tokens: TokenChange[]): string | null {
  const moved = tokens.filter((t) => t.changed && t.label !== "color");
  if (moved.length === 0) return null;
  return moved
    .map((t) => `${t.label} ${stripUnit(t.from)}→${t.to}`)
    .join(" · ");
}

function stripUnit(value: string): string {
  return value.replace(/px$/, "");
}

/* ---------------------------------------------------------------- colour */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/**
 * Perceptual distance, with alpha composited first.
 *
 * The alpha matters more than it looks: `rgba(0,0,0,0.06)` and
 * `rgba(0,0,0,0.08)` are different strings and identical greys once they are
 * over a background. Comparing the raw channels would call that a change; the
 * eye does not. Compositing over white is an assumption, but it is the right
 * one for the surfaces this product is pointed at.
 */
function deltaE(from: Rgba, to: Rgba): number {
  const [l1, a1, b1] = toLab(over(from));
  const [l2, a2, b2] = toLab(over(to));
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function over(color: Rgba): [number, number, number] {
  const blend = (channel: number) => channel * color.a + 255 * (1 - color.a);
  return [blend(color.r), blend(color.g), blend(color.b)];
}

function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];

  // sRGB → XYZ (D65), then XYZ → Lab against the D65 white point.
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) * 100;
  const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) * 100;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) * 100;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x / 95.047), f(y / 100), f(z / 108.883)];

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
