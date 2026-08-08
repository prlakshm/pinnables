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
  /*
   * `width` does not decide a flex item's width — `flex-basis` and `flex-grow`
   * do, and a `flex: 1` card ignores any width you hand it. Capturing only the
   * measured size meant the diff emitted `width: 232.5px` for an element that
   * could never honour it: the preview applied it and nothing moved, and an
   * agent writing the same line would have shipped a no-op.
   *
   * Capturing the properties that actually control the axis makes the diff
   * carry `flex-grow: 1 → 0` and `flex-basis: 0% → auto` alongside the width,
   * which is the change that works — in the preview and in the source file.
   */
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
 *
 * **Anything expanding this must run `applicabilityGuard` itself.** This is the
 * function that makes the two shapes interchangeable, so it is where the
 * assumption gets made and where it goes wrong. Expanding a group hands back
 * every longhand under it — `"border"` yields `border-color` whether or not the
 * source draws a border — and the fact that the panel only ever *stores*
 * guarded properties says nothing about what a board authored elsewhere holds.
 * The checked-in fixture stores group names; so does anything hand-written.
 *
 * The live preview learned this the expensive way: it expanded, read the
 * source's value and wrote it as `!important`, painting a black border from a
 * borderless card. Upstream filtering is not a guarantee when the input has two
 * shapes, and the guard belongs where the value is written.
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

/** Which of the named groups actually differ between two pins. */
export function differingGroups(source: Pin, target: Pin, groups: readonly string[]): string[] {
  return groups.filter((group) => computeStyleDiff(source, target, [group]).length > 0);
}

export interface StyleDiffEntry {
  property: string;
  from: string;
  to: string;
}

export interface Applicability {
  /** Whether writing this property to the target would actually do anything. */
  applicable: boolean;
  /** Why not, in words — so a caller can say it rather than silently drop it. */
  reason: string | null;
}

const APPLICABLE: Applicability = { applicable: true, reason: null };

/**
 * Whether a property can be applied to this target at all.
 *
 * Two rules used to live as bare `if`s inside the diff loop, and they are the
 * same rule twice: a value that differs on paper but cannot manifest on the
 * element. An undrawn border reports a colour it does not paint; a flex-stretched
 * card reports a width nobody wrote and that it would ignore if you set it.
 *
 * They belong together because *anything ranking these changes has to consult
 * them*. Perceptibility scoring in particular — a width difference alters layout
 * in principle, so a naive "layout always counts" rule will confidently promote
 * a change that is inert. The guard is the thing that stops that, and it is the
 * place the third case goes when it turns up.
 *
 * Returns a closure so the facts each rule depends on are computed once per
 * pair rather than once per property.
 */
export function applicabilityGuard(
  source: Pin,
  target: Pin,
): (property: string) => Applicability {
  const sourceBordered = hasVisibleBorder(source.computedStyles);

  return (property) => {
    if (property === "border-color" && !sourceBordered) {
      return { applicable: false, reason: "the source draws no border" };
    }
    return APPLICABLE;
  };
}

/** One-off form, for callers holding a single entry rather than a whole diff. */
export function applicabilityOf(property: string, source: Pin, target: Pin): Applicability {
  return applicabilityGuard(source, target)(property);
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
  const applicable = applicabilityGuard(source, target);
  for (const property of expandProperties(properties)) {
    // A change that cannot manifest is not a change. See `applicabilityGuard`.
    if (!applicable(property).applicable) continue;
    const to = source.computedStyles[property];
    const from = target.computedStyles[property];
    if (to === undefined || from === undefined) continue;
    if (to === from) continue;
    diff.push({ property, from, to });
  }
  return collapseShorthands(diff);
}

export interface BlockedChange extends StyleDiffEntry {
  applicability: Applicability;
}

/**
 * The differences the guard threw away, for the one caller that wants them.
 *
 * A sibling rather than a flag on `computeStyleDiff`, because the three
 * consumers of that function do not want the same thing and only one of them
 * wants these. The brief must not carry them — `width: 232.5px` on a flex item
 * is an instruction that does nothing, and an agent quietly doing nothing is a
 * failure nobody sees in review. The live preview must not apply them for the
 * same reason. Only the panel should show them, greyed, with the reason.
 *
 * So the default stays safe and the exception opts in. Inverting that — return
 * everything flagged, let callers filter — would put the burden on three call
 * sites to remember, and the one that forgets fails silently and ships.
 *
 * Note the second condition: blocked is not the same as blocked *and*
 * differing. `border-color` is inert on a borderless source whether or not the
 * two pins disagree about it, and a greyed row for two identical colours is a
 * row about nothing.
 */
export function computeBlockedChanges(
  source: Pin,
  target: Pin,
  properties: readonly string[],
): BlockedChange[] {
  const blocked: BlockedChange[] = [];
  const applicable = applicabilityGuard(source, target);

  for (const property of expandProperties(properties)) {
    const applicability = applicable(property);
    if (applicability.applicable) continue;
    const to = source.computedStyles[property];
    const from = target.computedStyles[property];
    if (to === undefined || from === undefined) continue;
    if (to === from) continue;
    blocked.push({ property, from, to, applicability });
  }
  return blocked;
}

/**
 * Whether an element actually draws a border.
 *
 * `border-color` resolves to `currentColor` when nothing is drawn, so a card
 * with no border reports its *text* colour — near-black on a white card. The
 * diff then reads that as a deliberate choice and offers to apply it, which
 * paints a real black border onto a target that only had a hairline.
 *
 * Matching a source with no border means removing the target's border, and
 * `border-width` and `border-style` already say exactly that. The colour is
 * inert on the result, so it stays out of the diff.
 *
 * Values can be per-side (`"1px 0px 1px 0px"`, `"none solid none solid"`), so
 * each is checked component-wise: a border is visible when some side has both
 * a non-zero width and a style that draws.
 */
function hasVisibleBorder(styles: Record<string, string>): boolean {
  const widths = styles["border-width"]?.split(/\s+/) ?? [];
  const styleNames = styles["border-style"]?.split(/\s+/) ?? [];
  if (widths.length > 0 && !widths.some((w) => parseFloat(w) > 0)) return false;
  if (styleNames.length > 0 && !styleNames.some((n) => n !== "none" && n !== "hidden")) return false;
  return true;
}

/**
 * The real properties behind a row of the diff.
 *
 * A row says `padding` because four longhands collapsed into it, and selection
 * has to be stored in the longhands — they are what `computedStyles` holds and
 * what the diff actually compares. Anything that did not collapse is itself.
 */
export function rawPropertiesFor(property: string): readonly string[] {
  return SHORTHANDS[property] ?? [property];
}

/** Which named group a property belongs to, if any. */
export function groupOf(property: string): string | null {
  const raw = rawPropertiesFor(property);
  for (const [group, members] of Object.entries(STYLE_GROUPS)) {
    if (raw.some((p) => (members as readonly string[]).includes(p))) return group;
  }
  return null;
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
