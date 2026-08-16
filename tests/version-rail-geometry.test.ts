import assert from "node:assert/strict";
import test from "node:test";

import {
  composerScoot,
  mintFlightLimit,
  MINT_FLY_MAX_PX,
  MINT_FLY_VIEWPORT_FRACTION,
  seatRail,
  shouldFlyMintKey,
} from "../packages/extension/src/content/VersionRail";
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

test("a nearby mint still flies; a long hop dissolves", () => {
  const viewport = { width: 1280, height: 800 };
  /* 30% of 800 is 240, so the cap is the 240px ceiling. */
  assert.equal(mintFlightLimit(viewport), MINT_FLY_MAX_PX);

  const from = { left: 100, top: 400 };
  assert.equal(shouldFlyMintKey(from, { left: 220, top: 280 }, viewport), true);
  assert.equal(shouldFlyMintKey(from, { left: 100 + MINT_FLY_MAX_PX, top: 400 }, viewport), true);
  assert.equal(shouldFlyMintKey(from, { left: 100 + MINT_FLY_MAX_PX + 1, top: 400 }, viewport), false);
  /* Diagonal past the cap — the old always-fly path would slide this. */
  assert.equal(shouldFlyMintKey(from, { left: 500, top: 80 }, viewport), false);
});

test("a short viewport tightens the flight cap to 30% of its shorter side", () => {
  const viewport = { width: 400, height: 300 };
  const cap = mintFlightLimit(viewport);
  assert.equal(cap, MINT_FLY_VIEWPORT_FRACTION * 300);
  assert.ok(cap < MINT_FLY_MAX_PX);

  const from = { left: 20, top: 20 };
  assert.equal(shouldFlyMintKey(from, { left: 20 + cap, top: 20 }, viewport), true);
  assert.equal(shouldFlyMintKey(from, { left: 20 + cap + 1, top: 20 }, viewport), false);
});
