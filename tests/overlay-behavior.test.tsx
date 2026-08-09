import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Pin } from "@pinnables/shared";
import { PinObject } from "../packages/extension/src/content/PinObject.tsx";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function elementPin(id: string, computedStyles: Record<string, string> = {}): Pin {
  return {
    id,
    schemaVersion: 1,
    boardId: "board-overlay",
    kind: "element",
    drawings: [],
    order: id === "source" ? 1 : 2,
    groupId: null,
    url: "http://localhost:5180/#/dashboard",
    route: "/dashboard",
    viewport: { width: 900, height: 700 },
    elementSize: { width: 220, height: 96 },
    screenshotPath: `pins/${id}.png`,
    thumbnailPath: `pins/${id}.thumb.webp`,
    selector: `[data-id="${id}"]`,
    domPath: `body > [data-id="${id}"]`,
    outerHtml: `<div data-id="${id}">${id}</div>`,
    classList: [],
    elementText: id,
    componentName: id === "source" ? "SourceCard" : "TargetCard",
    name: null,
    sourceFile: `src/${id}.tsx:1`,
    computedStyles,
    styleEdits: {},
    annotation: "",
    liveSends: [],
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function relationshipBoard(sourcePin: Pin, targetPin: Pin): Board {
  return {
    id: "board-overlay",
    schemaVersion: 1,
    projectId: "local",
    title: "Overlay regressions",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [sourcePin, targetPin],
    relationships: [
      {
        id: "rel-overlay",
        boardId: "board-overlay",
        type: "match",
        sourcePinId: sourcePin.id,
        targetPinIds: [targetPin.id],
        properties: ["padding-top", "border-radius", "box-shadow", "background-color"],
        exception: "",
        instruction: "",
      },
    ],
  };
}

test("initial placement prefers the right, falls back left, and remains in the viewport", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts").catch(
    () => null,
  );
  assert.ok(geometry, "overlay geometry helpers must exist");

  const viewport = { width: 800, height: 600 };
  const floating = { width: 200, height: 140 };

  assert.deepEqual(
    geometry.placeFloatingPinBeside(
      { x: 100, y: 80, width: 120, height: 60 },
      floating,
      viewport,
    ),
    { x: 232, y: 80 },
  );
  assert.deepEqual(
    geometry.placeFloatingPinBeside(
      { x: 700, y: 80, width: 80, height: 60 },
      floating,
      viewport,
    ),
    { x: 488, y: 80 },
  );
  assert.deepEqual(
    geometry.placeFloatingPinBeside(
      { x: 20, y: 10, width: 80, height: 40 },
      { width: 900, height: 700 },
      viewport,
    ),
    { x: 4, y: 4 },
  );
});

test("drag clamping accounts for an absolute label above the floating card", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts").catch(
    () => null,
  );
  assert.ok(geometry, "overlay geometry helpers must exist");

  assert.deepEqual(
    geometry.clampFloatingPosition(
      { x: -30, y: 0 },
      { left: 0, top: -42, right: 320, bottom: 260 },
      { width: 800, height: 600 },
    ),
    { x: 4, y: 46 },
  );
  assert.deepEqual(
    geometry.clampFloatingPosition(
      { x: 900, y: 700 },
      { left: 0, top: -42, right: 320, bottom: 260 },
      { width: 800, height: 600 },
    ),
    { x: 476, y: 336 },
  );
});

test("the multi-pin composer fits narrow review viewports without a negative origin", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts");

  assert.deepEqual(
    geometry.placeGroupComposer(
      { left: 24, right: 336, bottom: 180 },
      { width: 360, height: 640 },
    ),
    { x: 12, y: 192, width: 336 },
  );
  assert.deepEqual(
    geometry.placeGroupComposer(
      { left: 100, right: 700, bottom: 520 },
      { width: 900, height: 700 },
    ),
    { x: 210, y: 532, width: 380 },
  );
});

test("the selected identity label is taken out of flow so selection cannot move the card", () => {
  const css = source("packages/extension/src/ui/ui.css");
  const labelRule = css.slice(
    css.indexOf(".pin-object__label {"),
    css.indexOf(".pin-object__label .pin-icon-btn"),
  );

  assert.match(labelRule, /position:\s*absolute/);
  assert.match(labelRule, /top:\s*0/);
  assert.match(labelRule, /translateY\(calc\(-100% - var\(--pin-label-gap\)\)\)/);
  assert.doesNotMatch(labelRule, /margin-bottom/);
});

test("relationship previews restore omitted initial values", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  assert.equal(typeof overlay.computeLivePreviews, "function");

  const sourcePin = elementPin("source");
  const targetPin = elementPin("target", {
    "padding-top": "16px",
    "border-radius": "10px",
    "box-shadow": "rgba(0, 0, 0, 0.12) 0px 4px 12px 0px",
    "background-color": "rgb(255, 255, 255)",
  });
  const previews = overlay.computeLivePreviews(relationshipBoard(sourcePin, targetPin));

  assert.deepEqual(previews.get("target"), {
    "padding-top": "0px",
    "border-radius": "0px",
    "box-shadow": "none",
    "background-color": "rgba(0, 0, 0, 0)",
  });
});

test("child-list changes rebind live targets without observing preview style attributes", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const observerBlock = overlay.slice(
    overlay.indexOf("const [domRevision"),
    overlay.indexOf("/* ------------------------------------------------------------- board sync */"),
  );

  assert.match(observerBlock, /new MutationObserver/);
  assert.match(observerBlock, /requestAnimationFrame/);
  assert.match(
    observerBlock,
    /observe\(document\.documentElement,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/s,
  );
  assert.doesNotMatch(observerBlock, /attributes:\s*true/);
  assert.match(overlay, /\[board, route, previews, domRevision, capturing\]/);
});

test("Go to source can render its temporary highlight while capture mode is off", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");

  assert.match(overlay, /if \(!state\.enabled && !highlight\) return null/);
  assert.match(overlay, /if \(!state\.enabled\)\s*return\s*\([\s\S]*<HighlightOutline/);
});

test("leaving the page clears a stale capture hover outline", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const picker = overlay.slice(
    overlay.indexOf("/* ----------------------------------------------------------------- picker */"),
    overlay.indexOf("const capture = useCallback"),
  );

  assert.match(picker, /window\.addEventListener\("blur", clearHover\)/);
  assert.match(picker, /document\.documentElement\.addEventListener\("mouseleave", clearHover\)/);
  assert.match(picker, /setHighlight\(null\)/);
  assert.match(picker, /hovered\.current = null/);
});

test("a same-id recapture invalidates and safely reloads the floating screenshot", () => {
  const pinObject = source("packages/extension/src/content/PinObject.tsx");
  const shotEffect = pinObject.slice(
    pinObject.indexOf("useEffect(() =>"),
    pinObject.indexOf("const onPointerDown"),
  );

  assert.match(shotEffect, /let cancelled = false/);
  assert.match(shotEffect, /setShot\(null\)/);
  assert.match(shotEffect, /if \(!cancelled\) setShot/);
  assert.match(shotEffect, /return \(\) => \{\s*cancelled = true/);
  assert.match(shotEffect, /\[pin\.id, pin\.updatedAt\]/);
});

test("position storage is scoped to board identity and exact pin ids", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  const boardA = {
    ...relationshipBoard(elementPin("source"), elementPin("target")),
    id: "board-a",
  };
  const boardB = {
    ...relationshipBoard(elementPin("replacement"), elementPin("other")),
    id: "board-b",
  };

  assert.notEqual(overlay.positionScopeKey(boardA), overlay.positionScopeKey(boardB));
  assert.deepEqual(
    overlay.storedPositionsForBoard(boardB, {
      "pos:source": { x: 10, y: 20 },
      "pos:replacement": { x: 30, y: 40 },
      "pos:deleted": { x: 50, y: 60 },
    }),
    { replacement: { x: 30, y: 40 } },
  );

  const overlaySource = source("packages/extension/src/content/Overlay.tsx");
  const positionEffect = overlaySource.slice(
    overlaySource.indexOf("const positionScope"),
    overlaySource.indexOf("Keep each floating pin"),
  );
  assert.match(positionEffect, /if \(!preserveCurrent\) setPositions\(\{\}\)/);
  assert.match(positionEffect, /mergeStoredPositionsForBoard\(currentBoard, bag, current, preserveCurrent\)/);
  assert.doesNotMatch(positionEffect, /\{ \.\.\.next, \.\.\.prev/);
  assert.match(positionEffect, /\[positionScope\]/);
});

test("a same-board storage refresh cannot overwrite a freshly captured position", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  const board = {
    ...relationshipBoard(elementPin("source"), elementPin("new-pin")),
    id: "board-a",
  };
  const local = {
    source: { x: 12, y: 20 },
    "new-pin": { x: 440, y: 72 },
    deleted: { x: 900, y: 900 },
  };

  assert.deepEqual(
    overlay.mergeStoredPositionsForBoard(
      board,
      { "pos:source": { x: 30, y: 40 } },
      local,
      true,
    ),
    { source: { x: 12, y: 20 }, "new-pin": { x: 440, y: 72 } },
  );
  assert.deepEqual(
    overlay.mergeStoredPositionsForBoard(
      board,
      { "pos:source": { x: 30, y: 40 } },
      local,
      false,
    ),
    { source: { x: 30, y: 40 } },
  );
});

test("board refreshes prune ids and hiding a pin removes it from active flows", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const pruneEffect = overlay.slice(
    overlay.indexOf("const positionScope"),
    overlay.indexOf("Live position, per frame"),
  );
  assert.match(pruneEffect, /setSelected\(\(previous\) => retainExistingPinIds/);
  // Both halves of the focus context prune with the board, like selection.
  assert.match(pruneEffect, /setLiveSelected\(\(previous\) => retainExistingPinIds/);
  assert.match(pruneEffect, /setFocusCards\(\(previous\) => retainExistingPinIds/);
  assert.match(pruneEffect, /validIds\.has\(current\.fromPinId\)/);

  const dismiss = overlay.slice(
    overlay.indexOf("const dismissPin"),
    overlay.indexOf("const selectPin"),
  );
  // Dismissing a card removes it from the focus context; the pin survives.
  assert.match(dismiss, /setFocusCards\(\(previous\) => previous\.filter\(\(id\) => id !== pinId\)\)/);
  assert.match(dismiss, /current\?\.fromPinId === pinId \? null : current/);
  assert.match(overlay, /onDismiss=\{\(\) => dismissPin\(pin\.id\)\}/);
});

test("a fit-sized partial capture is scrolled fully into view and remeasured", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts").catch(
    () => null,
  );
  assert.ok(geometry, "overlay geometry helpers must exist");
  const viewport = { width: 800, height: 600 };

  assert.equal(
    geometry.shouldRevealForCapture({ x: -20, y: 40, width: 300, height: 200 }, viewport),
    true,
  );
  assert.equal(
    geometry.shouldRevealForCapture({ x: 20, y: 40, width: 300, height: 200 }, viewport),
    false,
  );
  assert.equal(
    geometry.shouldRevealForCapture({ x: -20, y: 40, width: 900, height: 200 }, viewport),
    false,
  );

  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const captureBlock = overlay.slice(
    overlay.indexOf("const capture = useCallback"),
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
  );
  assert.match(captureBlock, /shouldRevealForCapture\(measured\.rect, measured\.viewport\)/);
  assert.match(captureBlock, /element\.scrollIntoView\(\{[\s\S]*block: "nearest"[\s\S]*inline: "nearest"/);
  assert.match(captureBlock, /await new Promise[\s\S]*requestAnimationFrame/);
  assert.match(captureBlock, /measured = measureElement\(element\)/);
});

test("a partial screenshot crops the pin to the photographed region", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts");

  assert.deepEqual(
    geometry.placeCapturedFrame(
      { width: 1200, height: 800 },
      { width: 420, height: 280 },
      { x: 300, y: 100, width: 900, height: 700 },
    ),
    { x: 105, y: 35, width: 315, height: 245, partial: true },
  );
  assert.deepEqual(
    geometry.placeCapturedFrame(
      { width: 220, height: 96 },
      { width: 220, height: 96 },
      undefined,
    ),
    { x: 0, y: 0, width: 220, height: 96, partial: false },
  );

  const pinObject = source("packages/extension/src/content/PinObject.tsx");
  assert.match(pinObject, /placeCapturedFrame\(captured, boxStyle, pin\.screenshotFrame\)/);
  /*
   * Dead paper is never painted. A partial placement used to absolutely
   * position the photographed pixels inside a life-size frame and fill the
   * rest with flat background — the "outer box" around the pin. The frame now
   * collapses to exactly the photographed region instead.
   */
  assert.match(pinObject, /if \(shotPlacement\?\.partial\) \{/);
  assert.match(pinObject, /shotPlacement = \{ x: 0, y: 0, \.\.\.boxStyle, partial: false \}/);
  assert.doesNotMatch(pinObject, /position: shotPlacement\.partial/);
  assert.doesNotMatch(pinObject, /const shotStyle =\s*fit/);
});

test("floating pins preserve multi-corner and elliptical radii", async () => {
  const pinObject = await import("../packages/extension/src/content/PinObject.tsx");

  assert.equal(
    pinObject.scaleBorderRadius("4px 12px 20px 2px / 6px 8px", 0.5),
    "2px 6px 10px 1px / 3px 4px",
  );
  assert.equal(pinObject.scaleBorderRadius("50% 8px", 0.5), "50% 4px");

  const pinObjectSource = source("packages/extension/src/content/PinObject.tsx");
  assert.match(pinObjectSource, /"--pin-card-radius": scaleBorderRadius\(radiusValue, fit \?\? 1\)/);
  assert.doesNotMatch(pinObjectSource, /const radiusPx =/);
});

test("capture suspends relationship previews before it measures or photographs a target", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const previewEffect = overlay.slice(
    overlay.indexOf("const previews = useMemo"),
    overlay.indexOf("/* ---------------------------------------------------------- multi-select */"),
  );
  assert.match(previewEffect, /if \(!board \|\| capturing\) return/);
  assert.match(previewEffect, /\[board, route, previews, domRevision, capturing\]/);

  const captureBlock = overlay.slice(
    overlay.indexOf("const capture = useCallback"),
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
  );
  assert.match(
    captureBlock,
    /setCapturing\(true\)[\s\S]*await new Promise[\s\S]*requestAnimationFrame[\s\S]*measureElement\(element\)/,
  );
});

test("the page capture listener cannot start a duplicate capture while one is in flight", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const clickEffect = overlay.slice(
    overlay.indexOf("useEffect(() => {", overlay.indexOf("const capture = useCallback")),
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
  );
  assert.match(
    clickEffect,
    /if \(!capturing\) void capture\(target, \{ kind: "select", additive: event\.shiftKey \}\)/,
  );
  assert.match(
    clickEffect,
    /\[state\.enabled, mode, capture, capturing, stale, connecting, liveConnect\]/,
  );
});

test("the detached multi-select composer owns selection during capture-phase pointerdown", async () => {
  const overlayModule = await import("../packages/extension/src/content/Overlay.tsx");
  assert.equal(
    typeof overlayModule.isPinSelectionOwner,
    "function",
    "selection ownership must be shared by pinned cards and the detached composer",
  );

  const classList = (...tokens: string[]) => ({
    contains: (token: string) => tokens.includes(token),
  });
  assert.equal(overlayModule.isPinSelectionOwner(classList("pin-object")), true);
  assert.equal(
    overlayModule.isPinSelectionOwner(classList("pin-note", "pin-note--floating")),
    true,
  );
  assert.equal(overlayModule.isPinSelectionOwner(classList("page-card")), false);

  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const deselectEffect = overlay.slice(
    overlay.indexOf("/* -------------------------------------------------------- deselect on out */"),
    overlay.indexOf("/* -------------------------------------------------------------- esc layer */"),
  );
  assert.match(
    deselectEffect,
    /event[\s\S]*\.composedPath\(\)[\s\S]*isPinSelectionOwner\(n\.classList\)/,
  );
});

test("region reveal scrolls to and frames the live union of its marks", async () => {
  const geometry = await import("../packages/extension/src/content/overlay-geometry.ts").catch(
    () => null,
  );
  assert.ok(geometry, "overlay geometry helpers must exist");
  assert.deepEqual(
    geometry.unionBoxes([
      { x: 50, y: 100, width: 40, height: 20 },
      { x: 20, y: 130, width: 80, height: 50 },
    ]),
    { x: 20, y: 100, width: 80, height: 80 },
  );
  assert.equal(geometry.unionBoxes([]), null);

  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const reveal = overlay.slice(
    overlay.indexOf("/* --------------------------------------------------------- reveal a pin */"),
    overlay.indexOf("if (!state.enabled && !highlight) return null"),
  );
  assert.match(reveal, /revealedPin\?\.kind === "region"/);
  assert.match(reveal, /shapeBox/);
  assert.match(reveal, /unionBoxes/);
  assert.match(reveal, /window\.scrollTo/);
  assert.match(reveal, /keepHighlightAttached\(updateHighlight\)/);
});

test("an element reveal keeps its outline attached during smooth scrolling", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const reveal = overlay.slice(
    overlay.indexOf("/* --------------------------------------------------------- reveal a pin */"),
    overlay.indexOf("if (!state.enabled && !highlight) return null"),
  );
  assert.match(reveal, /const updateElementHighlight = \(\) =>/);
  assert.match(reveal, /keepHighlightAttached\(updateElementHighlight\)/);
  assert.match(reveal, /window\.removeEventListener\("scroll", update, true\)/);
});

test("relationship connections stay neutral and leave red to destructive or authored marks", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const wires = overlay.slice(
    overlay.indexOf("{!drawing && (wires.length > 0 || draft || liveDraft)"),
    overlay.indexOf("{highlight && !drawing"),
  );
  assert.match(wires, /fill="var\(--pin-ink\)"/);
  assert.doesNotMatch(wires, /var\(--pin-red/);

  const css = source("packages/extension/src/ui/ui.css");
  const anchors = css.slice(css.indexOf(".pin-anchor {"), css.indexOf("@keyframes pin-anchor-in"));
  assert.match(anchors, /background:\s*var\(--pin-ink\)/);
  assert.match(anchors, /background:\s*var\(--pin-ink-lift\)/);
  assert.doesNotMatch(anchors, /var\(--pin-red/);
});

test("floating pin selection and connector anchors expose keyboard semantics", () => {
  const sourcePin = elementPin("source");
  const targetPin = elementPin("target");
  const html = renderToStaticMarkup(
    <PinObject
      pin={sourcePin}
      board={{ ...relationshipBoard(sourcePin, targetPin), relationships: [] }}
      position={{ x: 20, y: 20 }}
      pulse={false}
      selected
      primary={false}
      selectionCount={1}
      connecting
      connectionRole="source"
      onSelect={() => {}}
      onMove={() => {}}
      onMoveEnd={() => {}}
      onDismiss={() => {}}
      onCommit={async () => {}}
      onRelate={() => {}}
      onAnchorDown={() => {}}
      onAnchorKeyboardActivate={() => {}}
      onAnchorEnter={() => {}}
      onAnchorLeave={() => {}}
    />,
  );

  assert.match(
    html,
    /<button[^>]*class="pin-object__inner"[^>]*aria-label="Select pinned SourceCard"[^>]*aria-pressed="true"/,
  );
  assert.match(
    html,
    /<button[^>]*class="pin-anchor"[^>]*aria-label="Cancel relationship from SourceCard"[^>]*aria-pressed="true"/,
  );

  const pinObject = source("packages/extension/src/content/PinObject.tsx");
  assert.match(
    pinObject,
    /if \(event\.detail === 0\)[\s\S]{0,100}onSelect\(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey\)/,
  );
  assert.match(pinObject, /if \(event\.detail === 0\) onAnchorKeyboardActivate\(pin\.id, anchorEdge\)/);

  const css = source("packages/extension/src/ui/ui.css");
  assert.match(css, /\.pin-object__inner:focus-visible\s*\{/);
  assert.match(css, /\.pin-anchor:is\(:hover, :focus-visible\)/);
});
