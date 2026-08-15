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

/* Guaranteed seats reuse the ring's shape (right, left, then an outer edge)
   but are keyed off the box, not the element — the box is always where the
   rail wants to sit when nothing in the ring cleared. At narrow viewports a
   380px box leaves neither side room for the rail, and there's not always
   headroom above it either (box-outer clamps down into the box once box.y
   drops under RAIL_GUTTER + rail.height) — the last resort is below the
   box's own bottom edge, clear of it on the y axis by construction
   regardless of clamping. It will often cost element-clearance; that is
   exactly what tier 2 is for. Even four candidates aren't always enough —
   when the box itself nearly fills the viewport there may be nowhere left
   that clears it either, which is what pickGuaranteed's null path is for. */
function guaranteedCandidates(orientation: Orientation, boxRect: Box, element: Box, rail: Size): RailCandidate[] {
  if (orientation === "below") {
    return [{ seat: "slot", x: boxRect.x + boxRect.width - rail.width, y: element.y + element.height + SLOT_PAD }];
  }
  const flushY = boxRect.y + boxRect.height - rail.height;
  return [
    { seat: "box-side", x: boxRect.x + boxRect.width + SLOT_PAD, y: flushY },
    { seat: "box-side", x: boxRect.x - SLOT_PAD - rail.width, y: flushY },
    { seat: "box-side", x: boxRect.x + boxRect.width - rail.width, y: boxRect.y - SLOT_PAD - rail.height },
    { seat: "box-side", x: boxRect.x + boxRect.width - rail.width, y: boxRect.y + boxRect.height + SLOT_PAD },
  ];
}

/* A ring seat is legal only where it lands raw — off-screen means dropped,
   not dragged into view, or "card-right" stops reading as beside the card.
   `slack` is the existing hysteresis tolerance for a sticky preferred seat;
   unchanged from before this fix, since the ring was never the problem. */
function ringLegal(c: RailCandidate, rail: Size, viewport: Size, boxRect: Box, element: Box, slack = 0): boolean {
  const r: Box = { x: c.x, y: c.y, width: rail.width, height: rail.height };
  const onScreen =
    r.x >= RAIL_GUTTER - slack &&
    r.y >= RAIL_GUTTER - slack &&
    r.x + r.width <= viewport.width - RAIL_GUTTER + slack &&
    r.y + r.height <= viewport.height - RAIL_GUTTER + slack;
  return onScreen && !intersects(r, boxRect) && !intersects(r, element);
}

type Tier = 1 | 2;

function clampRail(c: RailCandidate, rail: Size, viewport: Size): Box {
  return {
    x: clamp(c.x, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width),
    y: clamp(c.y, RAIL_GUTTER, viewport.height - RAIL_GUTTER - rail.height),
    width: rail.width,
    height: rail.height,
  };
}

/**
 * A guaranteed seat is judged by where it will actually render — after the
 * viewport clamp, never before, so a candidate that lands a few px off raw
 * but clears everything once clamped isn't punished for the raw miss. Tier
 * 1: clear of the box and the element. Tier 2: clear of the box (an element
 * can span the whole viewport and leave nothing tier-1 legal). Null when
 * neither holds — a box that nearly fills the viewport can leave no
 * rail-sized rectangle clear of it anywhere on screen, and that is not a
 * solvable placement problem, so there is no tier below 2 to fall back to.
 * The invariant this module keeps: if a rail is returned, it clears the
 * box; when nothing can, there is no rail.
 */
function guaranteedTier(c: RailCandidate, rail: Size, viewport: Size, boxRect: Box, element: Box): Tier | null {
  const r = clampRail(c, rail, viewport);
  if (!intersects(r, boxRect) && !intersects(r, element)) return 1;
  if (!intersects(r, boxRect)) return 2;
  return null;
}

/** First candidate to reach the best tier anyone in the list reaches, or
    null when nobody clears the box even after tier 2's element allowance. */
function pickGuaranteed(candidates: RailCandidate[], rail: Size, viewport: Size, boxRect: Box, element: Box): RailCandidate | null {
  for (const tier of [1, 2] as const) {
    const hit = candidates.find((c) => guaranteedTier(c, rail, viewport, boxRect, element) === tier);
    if (hit) return hit;
  }
  return null;
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

  /* Ring first, unchanged from before this fix: a sticky preferred seat
     survives while legal within hysteresis slack, otherwise the first
     legal candidate in ring order wins. Nothing legal in the ring falls
     through to the guaranteed list, which is built to always answer. */
  const ring = railCandidates(orientation, input, boxRect, rail);
  const sticky = ring.find((c) => c.seat === preferred.rail && ringLegal(c, rail, viewport, boxRect, element, TOLERANCE));
  const ringPick = sticky ?? ring.find((c) => ringLegal(c, rail, viewport, boxRect, element));
  if (ringPick) {
    return { box, rail: { x: ringPick.x, y: ringPick.y, seat: ringPick.seat }, scoot: 0 };
  }

  /* Guaranteed seats. Below orientation: the slot the box opens above
     itself (the shipped scoot ceiling). Above orientation: beside the box,
     right first then left, flush with its anchored bottom edge; failing
     both, above its top edge; failing that, below its own bottom edge.
     Every candidate is tier-tested and then clamped into the viewport. The
     invariant is not "there is always a rail" — it's that a returned rail
     always clears the box. A box that nearly fills the viewport can leave
     no candidate that does, and a rail drawn over the box a user types into
     is worse than none: the version keys it would have shown stay reachable
     from the chat rows' own keycaps, so there is nothing to lose by
     omitting it.

     The slot is tested against where the box will render, not where it
     sits now: the box hasn't stepped down for it yet (that's the scoot,
     applied by the caller), so testing the pre-scoot box would always see
     the overlap the scoot exists to resolve. */
  const guaranteed = guaranteedCandidates(orientation, boxRect, element, rail);
  const willRenderAt: Box =
    orientation === "below" ? { ...boxRect, y: boxRect.y + SLOT_PAD + rail.height + SLOT_PAD } : boxRect;
  const chosen = pickGuaranteed(guaranteed, rail, viewport, willRenderAt, element);
  if (!chosen) return { box, rail: null, scoot: 0 };
  const r = clampRail(chosen, rail, viewport);
  const scoot = chosen.seat === "slot" ? SLOT_PAD + rail.height + SLOT_PAD : 0;
  return { box, rail: { x: r.x, y: r.y, seat: chosen.seat }, scoot };
}
