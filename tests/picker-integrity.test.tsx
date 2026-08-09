import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

test("the picker refuses document-sized fallback elements", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  assert.equal(typeof overlay.isCapturablePageElement, "function");

  const html = {} as Element;
  const body = {} as Element;
  const card = {} as Element;
  const roots = { documentElement: html, body };

  assert.equal(overlay.isCapturablePageElement(null, roots), false);
  assert.equal(overlay.isCapturablePageElement(html, roots), false);
  assert.equal(overlay.isCapturablePageElement(body, roots), false);
  assert.equal(overlay.isCapturablePageElement(card, roots), true);
});

test("keyboard activation captures the focused eligible element, not the page origin", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  assert.equal(typeof overlay.pickerTargetForActivation, "function");

  const html = {} as Element;
  const body = {} as Element;
  const focused = {} as Element;
  const pageOrigin = {} as Element;
  let pointReads = 0;
  const roots = {
    documentElement: html,
    body,
    activeElement: focused,
    elementFromPoint() {
      pointReads += 1;
      return pageOrigin;
    },
  };

  assert.equal(
    overlay.pickerTargetForActivation(
      { detail: 0, clientX: 0, clientY: 0 },
      roots,
    ),
    focused,
  );
  assert.equal(pointReads, 0, "keyboard capture must not consult elementFromPoint(0, 0)");
  assert.equal(
    overlay.pickerTargetForActivation(
      { detail: 1, clientX: 14, clientY: 22 },
      roots,
    ),
    pageOrigin,
  );
  assert.equal(pointReads, 1);

  roots.activeElement = body;
  assert.equal(
    overlay.pickerTargetForActivation(
      { detail: 0, clientX: 0, clientY: 0 },
      roots,
    ),
    null,
  );
});

test("picker press interception protects the page before its handlers run", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const picker = overlay.slice(
    overlay.indexOf("/* ----------------------------------------------------------------- picker */"),
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
  );

  assert.match(picker, /addEventListener\("pointerdown", onPickerPointerDown, true\)/);
  assert.match(picker, /addEventListener\("mousedown", onPickerMouseDown, true\)/);
  assert.match(picker, /event\.preventDefault\(\)/);
  assert.match(picker, /event\.stopImmediatePropagation\(\)/);
  // Shift adds to the selection, Cursor-style; a plain click replaces it.
  assert.match(picker, /void capture\(target, \{ kind: "select", additive: event\.shiftKey \}\)/);
  assert.match(picker, /if \(!isCapturablePageElement\(target\)\) return/);
});

test("a capture failure is announced in the overlay instead of only logged", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const capture = overlay.slice(
    overlay.indexOf("const capture = useCallback"),
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
  );

  assert.match(overlay, /const \[captureError, setCaptureError\] = useState<string \| null>\(null\)/);
  assert.match(capture, /setCaptureError\(null\)/);
  assert.match(capture, /setCaptureError\(/);
  assert.match(overlay, /className="pin-capture-error"/);
  assert.match(overlay, /role="alert"/);
  assert.match(
    overlay,
    /onClick=\{\(\) => \{[\s\S]*setCaptureError\(null\)[\s\S]*setOperationError\(null\)/,
  );

  const css = source("packages/extension/src/ui/ui.css");
  assert.match(css, /\.pin-capture-error\s*\{/);
  assert.match(css, /var\(--pin-red-tint\)/);
});

test("drawing autosave and relationship failures use the visible overlay alert", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const drawing = overlay.slice(
    overlay.indexOf("const persistShapes = useCallback"),
    overlay.indexOf("/* --------------------------------------------------------- live preview */"),
  );
  const relationships = overlay.slice(
    overlay.indexOf("const reportRelationshipFailure"),
    overlay.indexOf("/* ----------------------------------------------------------------- picker */"),
  );

  assert.match(
    overlay,
    /const \[operationError, setOperationError\] = useState<OverlayOperationError \| null>\(null\)/,
  );
  assert.match(
    drawing,
    /setOperationError\([\s\S]*operationFailure\([\s\S]*"Drawing wasn.t saved"/,
  );
  assert.match(
    relationships,
    /setOperationError\([\s\S]*operationFailure\([\s\S]*"Relationship wasn.t created"/,
  );
  assert.match(overlay, /captureError \? "Capture failed" : operationError\?\.title/);
  assert.match(overlay, /role="alert"/);
  assert.match(overlay, /setOperationError\(null\)/);
});
