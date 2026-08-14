import assert from "node:assert/strict";
import test from "node:test";

import { composerScoot, seatRail } from "../packages/extension/src/content/VersionRail";
import { versionKeyFor } from "@pinnables/shared";

/**
 * The rail's seating ring and the composer's scoot, held to the mock's
 * geometry: right edge on the bottom, then underneath right-aligned to the
 * card, then the left edge — and the composer steps down exactly far enough
 * for gap, rail, gap, never further.
 */

const RAIL = { width: 140, height: 27 };
const VIEWPORT = { width: 1280, height: 800 };

test("the ring: card-right first, sitting on the card's bottom edge", () => {
  const card = { x: 200, y: 200, width: 240, height: 160 };
  const seat = seatRail(RAIL, card, null, null, VIEWPORT);
  assert.equal(seat.placed, "card-right");
  assert.equal(seat.x, card.x + card.width + 10);
  assert.equal(seat.y, card.y + card.height - RAIL.height);
});

test("pushed to the right edge, the rail drops below, right-aligned to the card", () => {
  const card = { x: VIEWPORT.width - 250, y: 200, width: 240, height: 160 };
  const foot = { x: card.x, y: card.y + card.height + 8, width: 240, height: 44 };
  const seat = seatRail(RAIL, card, foot, null, VIEWPORT);
  assert.equal(seat.placed, "below");
  assert.equal(seat.x, card.x + card.width - RAIL.width);
  /* Below clears the FOOT (the composer), not merely the card. */
  assert.equal(seat.y, foot.y + foot.height + 10);
});

test("cornered, the rail takes the left edge", () => {
  const card = {
    x: VIEWPORT.width - 250,
    y: VIEWPORT.height - 170,
    width: 240,
    height: 160,
  };
  const seat = seatRail(RAIL, card, null, null, VIEWPORT);
  assert.equal(seat.placed, "card-left");
  assert.equal(seat.x, card.x - 10 - RAIL.width);
});

test("a dragged rail keeps its place and is only clamped", () => {
  const card = { x: 200, y: 200, width: 240, height: 160 };
  const seat = seatRail(RAIL, card, null, { x: 9999, y: -50 }, VIEWPORT);
  assert.equal(seat.placed, "moved");
  assert.equal(seat.x, VIEWPORT.width - RAIL.width - 4);
  assert.equal(seat.y, 4);
});

test("the composer steps down for a rail on its doorstep, and no further", () => {
  const card = { x: 200, y: 200, width: 240, height: 160 };
  const note = { x: 200, y: 372, width: 380, height: 44 };
  /* Rail dragged onto the card's bottom edge, hanging 20px past it. */
  const rail = { x: 260, y: card.y + card.height - 7, width: 140, height: 27 };
  const hangs = rail.y + rail.height - (card.y + card.height);
  assert.equal(hangs, 20);
  const scoot = composerScoot(rail, card, note);
  assert.equal(scoot, 20); /* hangs + above(0), under the ceiling */

  /* Dragged far below: capped at gap + rail + gap, never tracking it down. */
  const far = { ...rail, y: card.y + card.height + 200 };
  assert.equal(composerScoot(far, card, note), 8 + 27 + 8);

  /* Off to the side: no overlap across, no scoot. */
  const aside = { ...rail, x: note.x + note.width + 50 };
  assert.equal(composerScoot(aside, card, note), 0);

  /* Fully above the card's bottom edge: nothing hangs, nothing moves. */
  const seated = { ...rail, y: card.y };
  assert.equal(composerScoot(seated, card, note), 0);
});

test("numerals ring 1..5 and start over", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 11].map(versionKeyFor), [1, 2, 3, 4, 5, 1, 2, 1]);
});
