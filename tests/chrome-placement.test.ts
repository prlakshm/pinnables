import assert from "node:assert/strict";
import test from "node:test";

import {
  placeSelectionChrome,
  type ChromeInput,
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
