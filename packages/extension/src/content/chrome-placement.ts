import { COMPOSER_WIDTH } from "./overlay-geometry";

/**
 * Every piece of selection chrome, seated by one function.
 *
 * The box ladder is below, above, docked; the rail rings around whichever
 * orientation the box took. Reserved seats are shared knowledge: the box
 * makes room the rail can count on, which is why this is one module and not
 * two solvers agreeing by luck.
 */

export interface Box { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Offset { x: number; y: number }

export type BoxSeat = "below" | "above" | "docked" | "moved";
export type RailSeat =
  | "card-right" | "below" | "card-left" | "slot"
  | "top-right" | "top-left" | "box-side"
  | "moved";

export interface ChromeInput {
  element: Box;
  /** Height reserved above the element by the floating label (0 when the
      label is flipped below). */
  labelAbove: number;
  /** Allowance under the element when the label is flipped below. */
  labelBelow: number;
  /** Single selection: left-align the box to this x. Null = center. */
  loneLeft: number | null;
  box: Size;
  rail: Size | null;
  manualBox: Offset | null;
  manualRail: Offset | null;
  preferred: { box: BoxSeat | null; rail: RailSeat | null };
  viewport: Size;
}

export interface ChromePlacement {
  box: { x: number; y: number; width: number; seat: BoxSeat };
  rail: { x: number; y: number; seat: RailSeat } | null;
  scoot: number;
}

const BOX_GUTTER = 12;
const RAIL_GUTTER = 4;
const BOX_GAP = 12;
const RAIL_GAP = 10;
const SLOT_PAD = 8;
const TOLERANCE = 16;

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function boxX(input: ChromeInput, width: number): number {
  const { element, loneLeft, viewport } = input;
  const centered = Math.round(element.x + element.width / 2 - width / 2);
  const x = loneLeft !== null ? loneLeft : centered;
  return clamp(x, BOX_GUTTER, viewport.width - BOX_GUTTER - width);
}

function placeBox(input: ChromeInput): { x: number; y: number; width: number; seat: BoxSeat } {
  const { element, viewport, box, labelAbove, labelBelow, manualBox, preferred } = input;
  const width = Math.max(0, Math.min(COMPOSER_WIDTH, viewport.width - BOX_GUTTER * 2));

  if (manualBox) {
    return {
      x: clamp(element.x + manualBox.x, BOX_GUTTER, viewport.width - BOX_GUTTER - width),
      y: clamp(element.y + manualBox.y, BOX_GUTTER, viewport.height - BOX_GUTTER - box.height),
      width,
      seat: "moved",
    };
  }

  const belowY = element.y + element.height + labelBelow + BOX_GAP;
  const aboveY = element.y - BOX_GAP - labelAbove - box.height;
  const legal: Record<"below" | "above", (slack: number) => boolean> = {
    below: (slack) => belowY + box.height <= viewport.height - BOX_GUTTER + slack,
    above: (slack) => aboveY >= BOX_GUTTER - slack,
  };
  const position: Record<"below" | "above" | "docked", number> = {
    below: belowY,
    above: aboveY,
    docked: viewport.height - BOX_GUTTER - box.height,
  };

  /* Seats are sticky: the current one survives while tolerably legal. */
  const kept =
    preferred.box === "below" || preferred.box === "above"
      ? legal[preferred.box](TOLERANCE)
        ? preferred.box
        : null
      : null;
  const seat: BoxSeat =
    kept ?? (legal.below(0) ? "below" : legal.above(0) ? "above" : "docked");
  return { x: boxX(input, width), y: position[seat], width, seat };
}

export function placeSelectionChrome(input: ChromeInput): ChromePlacement {
  const box = placeBox(input);
  return { box, rail: null, scoot: 0 };
}
