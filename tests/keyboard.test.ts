import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  arrowsShouldStepVersions,
  isEditableKeyboardTarget,
  stepVersionNo,
  versionJumpDigit,
  versionShortcutDigit,
} from "../packages/extension/src/lib/keyboard.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("versionJumpDigit treats Mac Option glyphs as the chord even when altKey is false", () => {
  assert.equal(versionJumpDigit({ code: "Digit1", key: "¡", altKey: false }), 1);
  assert.equal(versionJumpDigit({ code: "Digit2", key: "™", altKey: false }), 2);
  assert.equal(versionJumpDigit({ code: "Digit3", key: "£", altKey: true }), 3);
  assert.equal(versionJumpDigit({ code: "Digit1", key: "1", altKey: true }), 1);
  assert.equal(versionJumpDigit({ code: "Numpad5", key: "5", altKey: true }), 5);
  assert.equal(
    versionJumpDigit({ code: "Digit1", key: "1", altKey: false }),
    null,
    "plain 1 is typing, not a jump",
  );
});

test("versionShortcutDigit still reads the physical key", () => {
  assert.equal(versionShortcutDigit({ code: "Digit1", key: "¡" }), 1);
  assert.equal(versionShortcutDigit({ code: "", key: "™" }), 2);
  assert.equal(versionShortcutDigit({ code: "", key: "3" }), 3);
});

test("stepVersionNo walks the rail and wraps", () => {
  assert.equal(stepVersionNo(1, [1, 2, 3], 1), 2);
  assert.equal(stepVersionNo(3, [1, 2, 3], 1), 1);
  assert.equal(stepVersionNo(1, [1, 2, 3], -1), 3);
  assert.equal(stepVersionNo(null, [1, 2], 1), 1);
  assert.equal(stepVersionNo(2, [], 1), null);
});

test("isEditableKeyboardTarget sees composedPath inside a shadow host", () => {
  const textarea = {
    matches: (sel: string) => sel.includes("textarea"),
    closest: () => null,
  };
  const host = { closest: () => null, matches: () => false };
  const event = { composedPath: () => [textarea, host] };
  assert.equal(isEditableKeyboardTarget(host as unknown as EventTarget, event as unknown as Event), true);
  assert.equal(isEditableKeyboardTarget(host as unknown as EventTarget), false);
});

test("arrowsShouldStepVersions yields to a page field", () => {
  const pageInput = {
    matches: (sel: string) => sel.includes("input"),
    closest: () => null,
    classList: { contains: () => false },
  };
  const prev = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: pageInput },
  });
  try {
    assert.equal(arrowsShouldStepVersions(), false);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: prev });
  }
});

test("the rail listens whenever versions exist, not only when the rail is seated", () => {
  const rail = source("../packages/extension/src/content/VersionRail.tsx");
  assert.match(rail, /if \(versions\.length === 0\)/);
  assert.match(rail, /versionJumpDigit\(e\)/);
  assert.match(rail, /ArrowLeft/);
  assert.doesNotMatch(
    rail.slice(rail.indexOf("/* ------------------------------------------------------------ keyboard */")),
    /if \(!showMain\) \{\s*setArmed\(false\);\s*return;/,
  );
});

test("the annotation box handles Option+digit so a focused draft cannot swallow the jump", () => {
  const dialog = source("../packages/extension/src/content/SelectionDialog.tsx");
  assert.match(dialog, /versionJumpDigit\(event\.nativeEvent\)/);
  assert.match(dialog, /pressVersion\(jump\)/);
  assert.match(dialog, /ArrowLeft/);
});
