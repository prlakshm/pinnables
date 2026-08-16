import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  composerScoot,
  flightMode,
  LOCAL_FLIGHT_MIN_PX,
  seatRail,
  versionShortcutDigit,
} from "../packages/extension/src/content/VersionRail";
import { versionInChapter, versionKeyFor } from "@pinnables/shared";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

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

test("flightMode still classifies distance; live flight ignores it and always translates", () => {
  const origin = { left: 0, top: 0 };
  assert.equal(flightMode(origin, { left: 0, top: 0 }), "fly");
  assert.equal(flightMode(origin, { left: 100, top: 0 }), "fly");
  assert.equal(flightMode(origin, { left: LOCAL_FLIGHT_MIN_PX, top: 0 }), "local");
  assert.equal(flightMode(origin, { left: 800, top: 0 }), "local");
});

test("a null chapter head keeps stored keys visible", () => {
  assert.equal(versionInChapter({ head: "H1" }, null), true);
  assert.equal(versionInChapter({ head: null }, "H2"), true);
  assert.equal(versionInChapter({ head: "H1" }, "H2"), false);
  assert.equal(versionInChapter({ head: "H2" }, "H2"), true);
});

test("Done flash, flight hold, and ghost parenting match the handoff", () => {
  const dialog = source("../packages/extension/src/content/SelectionDialog.tsx");
  const rail = source("../packages/extension/src/content/VersionRail.tsx");
  assert.match(dialog, /DONE_FLASH_MS = 540/);
  assert.doesNotMatch(dialog, /setTimeout\(\(\) => \{[\s\S]*flyKeyToRail[\s\S]*\}, 220\)/);
  assert.match(dialog, /const startDoneHandoff = useCallback/);
  assert.match(dialog, /takeIsFresh/);
  const poll = dialog.slice(dialog.indexOf("const poll = useCallback"), dialog.indexOf("const staging ="));
  assert.doesNotMatch(poll, /setCompletedFlash/);
  assert.doesNotMatch(poll, /flyKeyToRail/);
  assert.match(rail, /DONE_FLASH_MS = 540/);
  assert.match(rail, /ENTER_HOLD_MS = DONE_FLASH_MS \+ ROW_LAYOUT_MS \+ FLIGHT_MS \+ ENTER_HOLD_SLACK_MS/);
  assert.match(rail, /root instanceof ShadowRoot \? root : document\.body/);
  assert.match(rail, /querySelector\("\.pin-key__mod"\)\?\.remove\(\)/);
});

test("fly starts when versionNo appears even if the poll never set justSettled", () => {
  const dialog = source("../packages/extension/src/content/SelectionDialog.tsx");
  assert.match(dialog, /prevVersionNos/);
  assert.match(dialog, /flownIds/);
  assert.match(dialog, /newlyMinted/);
  assert.match(dialog, /waitForKeysAndFly/);
  assert.doesNotMatch(dialog, /setJustSettled/);
  const poll = dialog.slice(dialog.indexOf("const poll = useCallback"), dialog.indexOf("const staging ="));
  assert.doesNotMatch(poll, /justSettled/);
  assert.doesNotMatch(poll, /flyKeyToRail/);
});

test("Option+DigitN restores even when e.key is the Mac Option glyph", () => {
  assert.equal(versionShortcutDigit({ code: "Digit1", key: "¡" }), 1);
  assert.equal(versionShortcutDigit({ code: "Digit2", key: "™" }), 2);
  assert.equal(versionShortcutDigit({ code: "Digit1", key: "1" }), 1);
  assert.equal(versionShortcutDigit({ code: "", key: "3" }), 3);
  assert.equal(versionShortcutDigit({ code: "", key: "¡" }), null);
});

test("flyKeyToRail always translates and waits for the rail key", () => {
  const rail = source("../packages/extension/src/content/VersionRail.tsx");
  const fly = rail.slice(rail.indexOf("export function flyKeyToRail"), rail.indexOf("function launchMintFlight"));
  const launch = rail.slice(rail.indexOf("function launchMintFlight"));
  assert.match(rail, /RAIL_KEY_WAIT_MS = 800/);
  assert.match(fly, /RAIL_KEY_WAIT_MS/);
  assert.match(fly, /getBoundingClientRect/);
  assert.match(fly, /requestAnimationFrame\(tryFly\)/);
  assert.doesNotMatch(fly, /flightMode\(/);
  assert.doesNotMatch(launch, /flightMode\(/);
  assert.doesNotMatch(launch, /scale\(0\.55\)/);
  assert.doesNotMatch(launch, /opacity = "0"/);
  assert.match(launch, /translate\(\$\{to\.left - from\.left\}px, \$\{to\.top - from\.top\}px\)/);
  assert.match(launch, /transition:transform 420ms var\(--ease\), width 420ms var\(--ease\)/);
  assert.match(launch, /ghost\.style\.width = `\$\{to\.width\}px`/);
});
