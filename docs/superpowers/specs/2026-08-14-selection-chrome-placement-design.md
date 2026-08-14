# Selection chrome placement

*2026-08-14 · approved in conversation with Pranavi*

## Problem

The annotation box and the version rail each place themselves with local rules
and no knowledge of one another. Three gaps line up whenever a pinned element
sits near the bottom of the viewport:

1. `placeGroupComposer` (overlay-geometry.ts) has no "above" concept. It
   places the box at `element bottom + 12` and clamps y to
   `viewport height − 120` — a guess at box height. A bottom-edge selection
   slides the box up on top of the element, and a box with chat history
   (~200px+) overflows the fold anyway.
2. `seatRail`'s ring (card-right → below → card-left) can have no legal seat
   for a bottom-edge element. Its fallback clamps blind to the viewport with
   no occupancy test.
3. Nothing checks collisions, so both clamped pieces stack on the element and
   on each other.

Observed live: pinning the film-set footer put the box over the element and
the rail over the box.

## Decisions

All made explicitly during design review:

- The box flips **above** the element when below does not fit. Its internal
  order never changes (input on top, history under it, newest first); when
  above, the box is **anchored by its bottom edge** — a fixed 12px gap to the
  element (clearing the floating label) — and each new history row makes the
  box taller **upward**. History's 132px cap bounds the travel.
- The rail's ring is **orientation-aware**. Box below → today's ring. Box
  above → the ring flips to the element's **top corners**: top-right first,
  top-left as mirror, both aligned to the element's top edge. The box–element
  gap stays clean; no rail between them.
- When the element spans the full viewport width in the flipped orientation
  (the footer case), the rail's guaranteed seat is **beside the annotation
  box**, flush with the box's **anchored bottom edge**, so box growth never
  moves it. Box-right first, box-left as mirror.
- In the below orientation the guaranteed seat stays the **slot above the
  box** (the existing scoot gap, `8 + rail height + 8`, becomes its formal
  definition and the scoot animation the motion into it).
- Last resort for the box when neither below nor above fits (element taller
  than the viewport): **docked** to the bottom viewport edge, covering the
  element's middle band. The only case where covering is unavoidable.
- One pure module owns all of it (approach chosen over patching the two
  existing solvers, and over a general constraint pass — the reserved seats
  are shared knowledge that only a single function can state as fact).

## The module

New file: `packages/extension/src/content/chrome-placement.ts`. Pure
geometry, no DOM, no React.

```ts
interface Box { x: number; y: number; width: number; height: number }

placeSelectionChrome(input: {
  element: Box;                       // live element rect, or group bounds
  labelAbove: number;                 // floating label height when above, else 0
  box: { width: number; height: number };   // measured dialog size
  rail: { width: number; height: number } | null; // null = no rail
  manualRail: { x: number; y: number } | null;    // dragged rail position
  preferred: { box: BoxSeat | null; rail: RailSeat | null }; // hysteresis
  viewport: { width: number; height: number };
}): {
  box: { x: number; y: number; seat: BoxSeat };
  rail: { x: number; y: number; seat: RailSeat } | null;
  /** Margin the dialog animates through — the scoot, both directions. */
  scoot: number;
}

type BoxSeat = "below" | "above" | "docked";
type RailSeat =
  | "card-right" | "below" | "card-left"   // below orientation
  | "top-right" | "top-left"               // above orientation
  | "slot"                                  // below orientation guarantee
  | "box-side"                              // above orientation guarantee
  | "moved";                                // user-dragged, clamp only
```

Placement order inside the function: box ladder first, then rail ring against
an occupancy list of `{element, box, viewport gutters}`. If the rail takes a
reserved seat that needs room from the box (`slot`), the box is re-placed
once with that allowance. Deterministic, first-fit, two passes maximum.

## The box ladder

1. **below** — top-anchored at `element.bottom + 12` (plus the existing
   flipped-label allowance). Legal when `y + box.height ≤ viewport − 12`.
2. **above** — bottom-anchored: `box.bottom = element.top − 12 − labelAbove`.
   Legal when `box.top ≥ 12`. Growth re-runs placement (box height is an
   input), so the top edge rises and the anchored gap holds.
3. **docked** — `box.bottom = viewport − 12`, x centered on the element as
   always. Chosen only when 1 and 2 are both illegal.

X placement is unchanged: centered on the element/group, clamped to 12px
gutters, single selections left-aligned per the existing rule.

## The rail rings

Below orientation: `card-right → below → card-left → slot`.
Above orientation: `top-right → top-left → box-side`.

- Every candidate must fit the viewport gutters **and** intersect neither the
  element nor the placed box. The blind clamp is deleted.
- `card-right`/`card-left` stay bottom-aligned to the element;
  `top-right`/`top-left` are their vertical mirrors, top-aligned.
- `slot` (below orientation): rail right-aligned to the box, sitting in the
  `8 + rail + 8` gap the box opens above itself. The box's `scoot` return
  makes that room; the existing margin-top transition animates it.
- `box-side` (above orientation): rail beside the box (right first, left as
  mirror), bottom edge flush with the box's bottom edge — the anchored edge,
  immune to growth.
- `moved`: a user-dragged rail is only clamped. Dragging across the seam
  between element and box still scoots the box by hand — the same formula,
  now defined once in this module. A manual rail overlapping the box body
  does not dodge; the user's arrangement wins.

## Hysteresis

Seats are sticky. The call receives the current seats as `preferred`; a
preferred seat is kept while it is legal within a 16px tolerance, and the
ladder/ring only runs when it is not. This stops above/below flapping while
scrolling near the boundary, and slot↔ring flapping while the box grows.

## Captures

Capture rails keep their own ring around their own card and gain the same
occupancy rejection (box, main rail). No guaranteed seat: a capture is placed
by hand, so a crowded capture is moved by hand. The shared intersection
helper makes this a few lines.

## Wiring

- `Overlay` measures the dialog (ref + ResizeObserver) and the rail
  (reported by the layer every measure pass — rail width changes as keys
  come and go), calls `placeSelectionChrome` per pass, and passes positions
  down.
- `SelectionDialog` stays presentational: `x`, `y`, `width`, `marginTop`
  (scoot). No internal reordering — the flip is pure positioning.
- `VersionLayer` renders the main rail at the given seat unless a drag is in
  flight; all drag/merge/capture logic is untouched.
- Deleted: `placeGroupComposer`'s y-guess, standalone `composerScoot`
  triggering, `seatRail`'s occupancy-blind fallback. Their jobs move into the
  module.

## Invariants and testing

Unit sweep (element rect grid × viewport sizes) asserting, for every
combination:

1. box ∩ element = ∅ unless seat is `docked`
2. rail ∩ box = ∅
3. rail ∩ element = ∅
4. box and rail inside viewport gutters
5. rail exists whenever `rail` input is non-null

Named regression: footer at the bottom edge → box `above`, rail `top-right`
(or `box-side` when the footer spans full width). Plus ladder/ring choice
tables, anchor math, hysteresis tolerance, label allowance, scoot equality
with the old formula in the below orientation.

Browser harness: re-drive the bottom-edge scenario visually on the film-set
page, pinning the actual footer; confirm drag-to-seam still animates.

## Out of scope

- Dragging the annotation box (stays fixed placement).
- Beside-the-element seats for the box (left/right) — above/below/docked
  covers the cases without changing the product's shape.
- Guaranteed seats for capture rails.
- Any change to `mocks/toggle-redesign.html` (untouchable reference).
