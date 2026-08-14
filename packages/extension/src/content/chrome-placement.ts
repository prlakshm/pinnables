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

type Orientation = "below" | "above";

function orientationOf(seat: BoxSeat, element: Box, boxY: number): Orientation {
  if (seat === "below") return "below";
  if (seat === "above" || seat === "docked") return "above";
  /* moved: whichever side of the element the box actually sits on */
  return boxY >= element.y + element.height / 2 ? "below" : "above";
}

interface RailCandidate { seat: RailSeat; x: number; y: number }

function railCandidates(
  orientation: Orientation,
  input: ChromeInput,
  boxRect: Box,
  rail: Size,
): RailCandidate[] {
  const { element } = input;
  if (orientation === "below") {
    return [
      { seat: "card-right", x: element.x + element.width + RAIL_GAP, y: element.y + element.height - rail.height },
      { seat: "below", x: element.x + element.width - rail.width, y: boxRect.y + boxRect.height + RAIL_GAP },
      { seat: "card-left", x: element.x - RAIL_GAP - rail.width, y: element.y + element.height - rail.height },
    ];
  }
  return [
    { seat: "top-right", x: element.x + element.width + RAIL_GAP, y: element.y },
    { seat: "top-left", x: element.x - RAIL_GAP - rail.width, y: element.y },
  ];
}

function legalRail(c: RailCandidate, rail: Size, input: ChromeInput, boxRect: Box, slack = 0): boolean {
  const { viewport, element } = input;
  const r: Box = { x: c.x, y: c.y, width: rail.width, height: rail.height };
  const inViewport =
    r.x >= RAIL_GUTTER - slack &&
    r.y >= RAIL_GUTTER - slack &&
    r.x + r.width <= viewport.width - RAIL_GUTTER + slack &&
    r.y + r.height <= viewport.height - RAIL_GUTTER + slack;
  return inViewport && !intersects(r, boxRect) && !intersects(r, element);
}

/**
 * The seam formula, shared by the reserved slot and a hand-dragged rail:
 * how far the box steps away so the rail can sit against the element's
 * box-facing edge. Positive pushes a below-box down; negative lifts an
 * above-box up. The ceiling is the shipped `8 + rail + 8`.
 */
function seamScoot(railRect: Box, element: Box, noteRect: Box, orientation: Orientation): number {
  const ceiling = SLOT_PAD + railRect.height + SLOT_PAD;
  const across = railRect.x < noteRect.x + noteRect.width && railRect.x + railRect.width > noteRect.x;
  if (!across) return 0;
  if (orientation === "below") {
    const hangs = railRect.y + railRect.height - (element.y + element.height);
    if (hangs <= 0) return 0;
    const above = Math.max(0, railRect.y - (element.y + element.height));
    return Math.min(ceiling, Math.max(SLOT_PAD, hangs + above));
  }
  const rises = element.y - railRect.y;
  if (rises <= 0) return 0;
  const gap = Math.max(0, element.y - (railRect.y + railRect.height));
  return -Math.min(ceiling, Math.max(SLOT_PAD, rises + gap));
}

export function placeSelectionChrome(input: ChromeInput): ChromePlacement {
  const box = placeBox(input);
  const { rail, element, viewport, manualRail, preferred } = input;
  if (!rail) return { box, rail: null, scoot: 0 };

  const boxRect: Box = { x: box.x, y: box.y, width: box.width, height: input.box.height };
  const orientation = orientationOf(box.seat, element, box.y);

  if (manualRail) {
    const x = clamp(element.x + manualRail.x, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width);
    const y = clamp(element.y + manualRail.y, RAIL_GUTTER, viewport.height - RAIL_GUTTER - rail.height);
    const scoot = seamScoot({ x, y, width: rail.width, height: rail.height }, element, boxRect, orientation);
    return { box, rail: { x, y, seat: "moved" }, scoot };
  }

  const ring = railCandidates(orientation, input, boxRect, rail);
  const kept = ring.find((c) => c.seat === preferred.rail && legalRail(c, rail, input, boxRect, TOLERANCE));
  const chosen = kept ?? ring.find((c) => legalRail(c, rail, input, boxRect));
  if (chosen) return { box, rail: { x: chosen.x, y: chosen.y, seat: chosen.seat }, scoot: 0 };

  /* Guaranteed seats. Below orientation: the slot the box opens above
     itself (the shipped scoot ceiling). Above orientation: beside the box,
     flush with its anchored bottom edge, right side first. */
  if (orientation === "below") {
    const scoot = SLOT_PAD + rail.height + SLOT_PAD;
    return {
      box,
      rail: {
        x: clamp(box.x + box.width - rail.width, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width),
        y: element.y + element.height + SLOT_PAD,
        seat: "slot",
      },
      scoot,
    };
  }
  /* Beside the box, right side first, flush with the anchored bottom edge.
     Narrow viewports can fit neither side of a 380px box; the guarantee
     outranks the side preference, so the rail then rides the box's outer
     top edge instead — still seat "box-side", still growth-immune because
     it re-derives from the box rect placement returns. */
  const rightX = box.x + box.width + SLOT_PAD;
  const leftX = box.x - SLOT_PAD - rail.width;
  const flushY = box.y + input.box.height - rail.height;
  if (rightX + rail.width <= viewport.width - RAIL_GUTTER) {
    return { box, rail: { x: rightX, y: flushY, seat: "box-side" }, scoot: 0 };
  }
  if (leftX >= RAIL_GUTTER) {
    return { box, rail: { x: leftX, y: flushY, seat: "box-side" }, scoot: 0 };
  }
  return {
    box,
    rail: {
      x: clamp(box.x + box.width - rail.width, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width),
      y: Math.max(RAIL_GUTTER, box.y - SLOT_PAD - rail.height),
      seat: "box-side",
    },
    scoot: 0,
  };
}
