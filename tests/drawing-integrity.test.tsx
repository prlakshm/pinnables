import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DrawShape } from "@pinnables/shared";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function shape(id: string): DrawShape {
  return {
    id,
    kind: "freehand",
    color: "#292C33",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ],
    anchor: null,
  };
}

test("rapid drawing edits accumulate locally instead of rebuilding from stale props", async () => {
  const drawing = await import("../packages/extension/src/content/DrawLayer.tsx");
  assert.equal(typeof drawing.createDrawingBuffer, "function");

  const first = shape("first");
  const second = shape("second");
  const buffer = drawing.createDrawingBuffer([]);

  buffer.commit([first]);
  buffer.commit([...buffer.read(), second]);
  // A delayed response containing only the first edit must not roll back the
  // second stroke while this draw session is still dirty.
  buffer.sync([first]);

  assert.deepEqual(buffer.read().map((item: DrawShape) => item.id), ["first", "second"]);
});

test("drawing persistence serializes every edit but photographs only the last quiet state", async () => {
  const saves = await import("../packages/extension/src/content/drawing-save.ts").catch(
    () => null,
  );
  assert.ok(saves, "drawing save coordinator must exist");

  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  const calls: Array<{ ids: string[]; screenshot: boolean }> = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = saves.createDrawingSaveCoordinator(
    async (shapes: DrawShape[], screenshot: boolean) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      calls.push({ ids: shapes.map((item) => item.id), screenshot });
      active -= 1;
    },
    {
      schedule(callback: () => void) {
        nextTimer += 1;
        scheduled.set(nextTimer, callback);
        return nextTimer;
      },
      cancel(timer: number) {
        scheduled.delete(timer);
      },
    },
  );

  const first = shape("first");
  const second = shape("second");
  coordinator.update([first]);
  coordinator.update([first, second]);

  assert.equal(scheduled.size, 1, "rapid edits share one pending screenshot");
  [...scheduled.values()][0]();
  await coordinator.whenIdle();

  assert.deepEqual(calls, [
    { ids: ["first"], screenshot: false },
    { ids: ["first", "second"], screenshot: false },
    { ids: ["first", "second"], screenshot: true },
  ]);
  assert.equal(maxActive, 1, "board writes and screenshots never race each other");
});

test("clearing every mark persists the deletion without scheduling a screenshot", async () => {
  const saves = await import("../packages/extension/src/content/drawing-save.ts").catch(
    () => null,
  );
  assert.ok(saves, "drawing save coordinator must exist");

  const scheduled = new Map<number, () => void>();
  const calls: Array<{ count: number; screenshot: boolean }> = [];
  const coordinator = saves.createDrawingSaveCoordinator(
    async (shapes: DrawShape[], screenshot: boolean) => {
      calls.push({ count: shapes.length, screenshot });
    },
    {
      schedule(callback: () => void) {
        scheduled.set(1, callback);
        return 1;
      },
      cancel(timer: number) {
        scheduled.delete(timer);
      },
    },
  );

  coordinator.update([]);
  await coordinator.whenIdle();

  assert.deepEqual(calls, [{ count: 0, screenshot: false }]);
  assert.equal(scheduled.size, 0);
});

test("pen shortcuts leave editable page controls alone", async () => {
  const drawing = await import("../packages/extension/src/content/DrawLayer.tsx");
  assert.equal(typeof drawing.isEditableKeyboardTarget, "function");

  const editable = {
    closest(selector: string) {
      assert.match(selector, /input/);
      assert.match(selector, /contenteditable/);
      return this;
    },
  };
  const ordinary = { closest: () => null };

  assert.equal(drawing.isEditableKeyboardTarget(editable as unknown as EventTarget), true);
  assert.equal(drawing.isEditableKeyboardTarget(ordinary as unknown as EventTarget), false);

  const drawLayer = source("packages/extension/src/content/DrawLayer.tsx");
  assert.match(drawLayer, /if \(isEditableKeyboardTarget\(event\.target\)\) return/);
  assert.match(drawLayer, /event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey/);
});

test("drawing screenshots retain ink while hiding extension chrome and masking secrets", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const saveBlock = overlay.slice(
    overlay.indexOf("/* ------------------------------------------------------------------ ink */"),
    overlay.indexOf("/* --------------------------------------------------------- live preview */"),
  );
  const css = source("packages/extension/src/ui/ui.css");

  assert.match(saveBlock, /maskSensitive\(\)/);
  assert.match(saveBlock, /data-drawing-snapshot/);
  assert.match(saveBlock, /finally[\s\S]*unmask\?\.\(\)/);
  assert.match(css, /\[data-drawing-snapshot="true"\][\s\S]*\.pin-overlay/);
  assert.match(css, /\[data-drawing-snapshot="true"\][\s\S]*\.pin-ink\[data-draft="true"\]/);
  assert.doesNotMatch(css, /\[data-drawing-snapshot="true"\][^{]*>\s*\.pin-ink\s*\{/);
});

test("Go to pin restores a floating pin the user previously hid", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const reveal = overlay.slice(
    overlay.indexOf("/* --------------------------------------------------------- reveal a pin */"),
    overlay.indexOf("if (!state.enabled && !highlight) return null"),
  );

  assert.match(reveal, /handledReveal\.current === request/);
  assert.match(reveal, /claimRevealRequest\(handledReveal, request\)/);
  assert.match(reveal, /setDismissed\(\(previous\) =>[\s\S]*delete\(state\.reveal!\.pinId\)/);
});
