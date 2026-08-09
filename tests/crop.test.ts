import assert from "node:assert/strict";
import test from "node:test";

import { bitmapCropRect, visibleElementFrame } from "../packages/extension/src/lib/crop.ts";

test("bitmap crop intersects a partially offscreen element with the visible frame", () => {
  assert.deepEqual(
    bitmapCropRect({ x: -40, y: -10, width: 140, height: 60 }, 2, 800, 600),
    { x: 0, y: 0, width: 200, height: 100 },
  );
});

test("bitmap crop clamps elements that extend beyond the right and bottom edges", () => {
  assert.deepEqual(
    bitmapCropRect({ x: 360, y: 260, width: 80, height: 80 }, 2, 800, 600),
    { x: 720, y: 520, width: 80, height: 80 },
  );
});

test("bitmap crop always leaves a drawable pixel at an out-of-frame edge", () => {
  assert.deepEqual(
    bitmapCropRect({ x: 500, y: 400, width: 20, height: 20 }, 2, 800, 600),
    { x: 799, y: 599, width: 1, height: 1 },
  );
});

test("visible element frames record where a partial screenshot belongs inside the element", () => {
  assert.deepEqual(
    visibleElementFrame(
      { x: -40, y: 30, width: 900, height: 700 },
      { width: 800, height: 600 },
    ),
    { x: 40, y: 0, width: 800, height: 570 },
  );
  assert.equal(
    visibleElementFrame(
      { x: 900, y: 700, width: 100, height: 100 },
      { width: 800, height: 600 },
    ),
    null,
  );
});
