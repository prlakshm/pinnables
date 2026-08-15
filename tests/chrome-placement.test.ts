import assert from "node:assert/strict";
import test from "node:test";

import {
  placeSelectionChrome,
  intersects,
  type ChromeInput,
  type Box,
  type Size,
} from "../packages/extension/src/content/chrome-placement";

const VIEWPORT = { width: 1280, height: 800 };

function input(overrides: Partial<ChromeInput> = {}): ChromeInput {
  return {
    element: { x: 400, y: 200, width: 240, height: 160 },
    labelAbove: 48,
    labelBelow: 0,
    loneLeft: 400,
    box: { width: 380, height: 120 },
    rail: null,
    manualBox: null,
    manualRail: null,
    preferred: { box: null, rail: null },
    viewport: VIEWPORT,
    ...overrides,
  };
}

test("below: box sits 12px under the element, lone selections left-aligned", () => {
  const p = placeSelectionChrome(input());
  assert.equal(p.box.seat, "below");
  assert.equal(p.box.y, 200 + 160 + 0 + 12);
  assert.equal(p.box.x, 400);
  assert.equal(p.box.width, 380);
});

test("below honours the flipped-label allowance", () => {
  const p = placeSelectionChrome(input({ labelAbove: 0, labelBelow: 42 }));
  assert.equal(p.box.y, 200 + 160 + 42 + 12);
});

test("group selections center the box on the element span", () => {
  const p = placeSelectionChrome(input({ loneLeft: null }));
  assert.equal(p.box.x, Math.round(400 + 240 / 2 - 380 / 2));
});

test("above: bottom-anchored 12px over the element, clearing the label", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const p = placeSelectionChrome(input({ element }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.box.y + 120, 620 - 12 - 48, "bottom edge anchored");
});

test("above: growth shifts the top up, the anchor holds", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const small = placeSelectionChrome(input({ element, box: { width: 380, height: 120 } }));
  const tall = placeSelectionChrome(input({ element, box: { width: 380, height: 200 } }));
  assert.equal(small.box.y + 120, tall.box.y + 200, "same bottom edge");
});

test("docked: element taller than the viewport pins the box to the bottom edge", () => {
  const element = { x: 100, y: -50, width: 1000, height: 900 };
  const p = placeSelectionChrome(input({ element, loneLeft: 100 }));
  assert.equal(p.box.seat, "docked");
  assert.equal(p.box.y + 120, VIEWPORT.height - 12);
});

test("moved: a manual box is an element-relative offset, clamped only", () => {
  const p = placeSelectionChrome(input({ manualBox: { x: -20, y: 300 } }));
  assert.equal(p.box.seat, "moved");
  assert.equal(p.box.x, 400 - 20);
  assert.equal(p.box.y, 200 + 300);
  const clamped = placeSelectionChrome(input({ manualBox: { x: 5000, y: 5000 } }));
  assert.ok(clamped.box.x + 380 <= VIEWPORT.width - 12);
  assert.ok(clamped.box.y + 120 <= VIEWPORT.height - 12);
});

test("hysteresis: a preferred seat survives while legal within 16px", () => {
  /* below legality boundary: element.bottom + 12 + 120 = 788 → height 456 */
  const element = { x: 400, y: 200, width: 240, height: 456 };
  const first = placeSelectionChrome(input({ element }));
  assert.equal(first.box.seat, "below");
  const nudged = { ...element, height: 466 };
  const kept = placeSelectionChrome(
    input({ element: nudged, preferred: { box: "below", rail: null } }),
  );
  assert.equal(kept.box.seat, "below", "10px past legal is inside tolerance");
  const far = { ...element, height: 560 };
  const flipped = placeSelectionChrome(
    input({ element: far, preferred: { box: "below", rail: null } }),
  );
  assert.equal(flipped.box.seat, "above", "past tolerance the ladder runs");
});

test("rail ring below: card-right bottom-aligned beside the element", () => {
  const p = placeSelectionChrome(input({ rail: { width: 140, height: 27 } }));
  assert.ok(p.rail);
  assert.equal(p.rail!.seat, "card-right");
  assert.equal(p.rail!.x, 400 + 240 + 10);
  assert.equal(p.rail!.y, 200 + 160 - 27);
  assert.equal(p.scoot, 0);
});

test("rail ring above: top-right beside the element, top-aligned", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const p = placeSelectionChrome(input({ element, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.rail!.seat, "top-right");
  assert.equal(p.rail!.x, 400 + 240 + 10);
  assert.equal(p.rail!.y, 620);
});

test("slot: nothing fits around a low full-width element in below orientation", () => {
  /* Full width kills card-right/left; y=430 puts the below seat past the
     fold (box bottom 762 + 10 + 27 > 796) while the box itself still fits. */
  const element = { x: 0, y: 430, width: 1280, height: 200 };
  const p = placeSelectionChrome(input({ element, loneLeft: 0, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "below");
  assert.equal(p.rail!.seat, "slot");
  assert.equal(p.rail!.y, 430 + 200 + 8, "rail tucked just under the element");
  assert.equal(p.rail!.x, p.box.x + p.box.width - 140, "right-aligned to the box");
  assert.equal(p.scoot, 27 + 16, "box steps down by the shipped ceiling");
});

test("box-side: full-width element at the bottom edge, rail beside the box", () => {
  const element = { x: 0, y: 700, width: 1280, height: 100 };
  const p = placeSelectionChrome(input({ element, loneLeft: 0, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.rail!.seat, "box-side");
  assert.equal(p.rail!.y, p.box.y + 120 - 27, "flush with the anchored bottom edge");
  assert.ok(
    p.rail!.x === p.box.x + p.box.width + 8 || p.rail!.x === p.box.x - 8 - 140,
    "beside the box, right first then left",
  );
  assert.equal(p.scoot, 0);
});

test("box-side stays put while the box grows", () => {
  const element = { x: 0, y: 700, width: 1280, height: 100 };
  const short = placeSelectionChrome(
    input({ element, loneLeft: 0, rail: { width: 140, height: 27 }, box: { width: 380, height: 120 } }),
  );
  const tall = placeSelectionChrome(
    input({ element, loneLeft: 0, rail: { width: 140, height: 27 }, box: { width: 380, height: 200 } }),
  );
  assert.equal(short.rail!.y, tall.rail!.y, "anchored edge, growth is upward");
});

test("a manual rail is an element-relative offset and drives the seam scoot", () => {
  const p = placeSelectionChrome(
    input({ rail: { width: 140, height: 27 }, manualRail: { x: 60, y: 172 } }),
  );
  assert.equal(p.rail!.seat, "moved");
  assert.equal(p.rail!.x, 460);
  assert.equal(p.rail!.y, 372, "12px past the element bottom");
  assert.ok(p.scoot > 0, "the box steps down for a rail on its doorstep");
  assert.ok(p.scoot <= 27 + 16, "never past the ceiling");
});

test("occupancy: a rail candidate never intersects the placed box", () => {
  const element = { x: 900, y: 200, width: 240, height: 160 };
  const p = placeSelectionChrome(
    input({ element, loneLeft: 900, rail: { width: 140, height: 27 } }),
  );
  assert.ok(p.rail);
  const railBox = { x: p.rail!.x, y: p.rail!.y, width: 140, height: 27 };
  const boxBox = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: 120 };
  assert.equal(intersects(railBox, boxBox), false);
});

test("finding A's original input: the docked guaranteed seat clears the box", () => {
  /* Verbatim repro from the report. This 900px element starts 50px above
     an 800px viewport, so it spans past both edges vertically — every
     on-screen y falls inside it — but it is only 500px wide in the 1280px
     viewport, leaving room beside it on the x axis. The docked box sits at
     {x:12,y:668}. Originally, with guaranteed candidates keyed only off
     the box, the pick was box-side-right at {x:400,y:761}: clear of the
     box by its raw 8px gap, but still inside the element's vertical span,
     so only tier 2 — "tier 1 was never reachable here" was true then.
     Adding the element-side candidates (this task's sweep fix) changed
     that: right-of-element clamps to {x:508,y:4}, clear of the element on
     the x axis alone (508 sits past its right edge at 500) regardless of
     y, and it happens to clear the box too — this exact input now reaches
     tier 1. The assertion below only ever checks box-clearance through
     intersects(), never a seat name or a coordinate, which is exactly why
     it kept passing, unchanged, across that shift — and is the right way
     to have written it. */
  const element = { x: 0, y: -50, width: 500, height: 900 };
  const p = placeSelectionChrome(
    input({ element, loneLeft: 0, rail: { width: 140, height: 27 } }),
  );
  assert.equal(p.box.seat, "docked");
  assert.ok(p.rail);
  const railBox = { x: p.rail!.x, y: p.rail!.y, width: 140, height: 27 };
  const boxBox = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: 120 };
  assert.equal(intersects(railBox, boxBox), false, "clears the box");
});

test("finding B's original input: the above guaranteed seat clears the element", () => {
  /* Verbatim repro from the report (a 200x40 rail). This size needs 208px
     of clearance beside a 380px box; splitting a 768px viewport around
     that box never offers more than ~190px on either side, and box-outer
     has under 12px of headroom above the box. No candidate here clears the
     box either — box-clearance is not a floor this exact input reaches, so
     this asserts what does hold, element-clearance, rather than the box
     tier the fix's design otherwise targets (see the report). */
  const element = { x: 200, y: 200, width: 500, height: 900 };
  const p = placeSelectionChrome(
    input({
      element,
      loneLeft: 200,
      rail: { width: 200, height: 40 },
      viewport: { width: 768, height: 1024 },
    }),
  );
  assert.equal(p.box.seat, "above");
  assert.ok(p.rail);
  const railBox = { x: p.rail!.x, y: p.rail!.y, width: 200, height: 40 };
  assert.equal(intersects(railBox, element), false, "clears the element");
});

test("narrow viewport: the above guaranteed seat still clears the box near its legal top", () => {
  /* At 320px wide, a 296px box leaves neither side room for a 140px rail,
     and box-outer clamps its y down into the box whenever box.y sits near
     its legal minimum (12px) — this exercises the fourth guaranteed
     candidate, below the box's own bottom edge, clear of it by
     construction regardless of clamping. The full-width element denies
     the ring on x alone, independent of y. */
  const element = { x: 0, y: 200, width: 1280, height: 500 };
  const p = placeSelectionChrome(
    input({
      element,
      loneLeft: 0,
      rail: { width: 140, height: 27 },
      viewport: { width: 320, height: 700 },
    }),
  );
  assert.equal(p.box.seat, "above");
  assert.ok(p.rail);
  const railBox = { x: p.rail!.x, y: p.rail!.y, width: 140, height: 27 };
  const boxBox = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: 120 };
  assert.equal(intersects(railBox, boxBox), false, "clears the box");
});

test("no candidate clears the box: no rail rather than one drawn on top of it", () => {
  /* Reviewer's exact repro. At 320x155 the docked box occupies nearly the
     whole viewport (x 12..308, y 23..143); the free strips are at most 8px
     wide and 19px tall, nowhere near a 140x27 rail. No position clears the
     box, so there is no honest seat to return. */
  const element = { x: 100, y: -50, width: 1000, height: 900 };
  const p = placeSelectionChrome(
    input({
      element,
      loneLeft: 100,
      rail: { width: 140, height: 27 },
      viewport: { width: 320, height: 155 },
    }),
  );
  assert.equal(p.box.seat, "docked");
  assert.equal(p.rail, null);
});

test("invariant sweep: no auto seat overlaps, everything stays on screen", () => {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 900, height: 600 },
    { width: 480, height: 800 },
    { width: 375, height: 667 },
    { width: 320, height: 480 },
  ];
  const rails = [
    { width: 140, height: 27 },
    { width: 60, height: 27 },
  ];
  const boxes = [
    { width: 380, height: 96 },
    { width: 380, height: 240 },
  ];
  let combos = 0;
  let nullRails = 0;
  let elementSkips = 0;

  /* Could a rail of this size sit anywhere on screen clear of the element?
     If not, element overlap is unavoidable and the module's tier 2 is
     right to accept it — so the assertion is skipped on geometry, never on
     the seat's name. The four strips around the element are the only
     candidates worth testing: anything clear of the element lies in one. */
  const clearRoomExists = (element: Box, rail: Size, viewport: Size): boolean => {
    const g = 4;
    const strips = [
      { w: viewport.width - g * 2, h: element.y - g },
      { w: viewport.width - g * 2, h: viewport.height - g - (element.y + element.height) },
      { w: element.x - g, h: viewport.height - g * 2 },
      { w: viewport.width - g - (element.x + element.width), h: viewport.height - g * 2 },
    ];
    return strips.some((s) => s.w >= rail.width && s.h >= rail.height);
  };

  for (const viewport of viewports) {
    for (const rail of rails) {
      for (const box of boxes) {
        for (let ex = -80; ex <= viewport.width; ex += 140) {
          for (let ey = -80; ey <= viewport.height; ey += 140) {
            for (const size of [
              { width: 240, height: 160 },
              { width: viewport.width, height: 120 },
              { width: 300, height: viewport.height + 200 },
            ]) {
              combos += 1;
              const element = { x: ex, y: ey, ...size };
              const p = placeSelectionChrome({
                element,
                labelAbove: 48,
                labelBelow: 0,
                loneLeft: ex,
                box,
                rail,
                manualBox: null,
                manualRail: null,
                preferred: { box: null, rail: null },
                viewport,
              });
              const where = `element ${ex},${ey} ${size.width}x${size.height} rail ${rail.width}x${rail.height} box h${box.height} in ${viewport.width}x${viewport.height}`;

              const boxRect = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: box.height };
              if (p.box.seat !== "docked") {
                assert.equal(intersects(boxRect, element), false, `box clear of element — ${where}`);
              }
              assert.ok(
                p.box.x >= 12 && p.box.x + p.box.width <= viewport.width - 12,
                `box inside gutters — ${where}`,
              );

              if (!p.rail) {
                nullRails += 1;
                continue;
              }
              const railRect = { x: p.rail.x, y: p.rail.y, width: rail.width, height: rail.height };
              assert.equal(intersects(railRect, boxRect), false, `rail clear of box — ${where}`);
              assert.ok(
                railRect.x >= 4 &&
                  railRect.y >= 4 &&
                  railRect.x + railRect.width <= viewport.width - 4 &&
                  railRect.y + railRect.height <= viewport.height - 4,
                `rail on screen — ${where}`,
              );
              if (clearRoomExists(element, rail, viewport)) {
                assert.equal(intersects(railRect, element), false, `rail clear of element — ${where}`);
              } else {
                elementSkips += 1;
              }
            }
          }
        }
      }
    }
  }

  /* Printed, not asserted on exact values: a regression that quietly nulled
     every rail would otherwise pass a suite that only checks overlaps. */
  console.log(`sweep: ${combos} combinations, ${nullRails} null rails, ${elementSkips} element skips`);
  assert.ok(combos > 2000, "the sweep actually swept");
  assert.ok(nullRails < combos / 2, "most combinations still produce a rail");
});

test("regression: the film-set footer at the bottom edge", () => {
  const viewport = { width: 1440, height: 900 };
  const footer = { x: 0, y: 830, width: 1440, height: 120 };
  const box = { width: 380, height: 180 };
  const rail = { width: 100, height: 27 };
  const p = placeSelectionChrome({
    element: footer,
    labelAbove: 48,
    labelBelow: 0,
    loneLeft: 0,
    box,
    rail,
    manualBox: null,
    manualRail: null,
    preferred: { box: null, rail: null },
    viewport,
  });
  assert.equal(p.box.seat, "above", "box flips over the footer");
  assert.ok(p.rail, "the footer case has room for a rail");
  const railRect = { x: p.rail!.x, y: p.rail!.y, width: rail.width, height: rail.height };
  const boxRect = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: box.height };
  assert.equal(intersects(railRect, boxRect), false, "rail clear of the box");
  assert.equal(intersects(railRect, footer), false, "rail clear of the footer");
  assert.equal(intersects(boxRect, footer), false, "box clear of the footer");
});
