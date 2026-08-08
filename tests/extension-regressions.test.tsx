import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Pin } from "@pinnables/shared";
import { PinObject } from "../packages/extension/src/content/PinObject.tsx";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function elementPin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: "pin-target",
    schemaVersion: 1,
    boardId: "board-1",
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    url: "http://localhost:5180/dashboard",
    route: "/dashboard",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 232, height: 98 },
    screenshotPath: "pins/pin-target.png",
    thumbnailPath: "pins/pin-target.thumb.webp",
    selector: ".mini-card",
    domPath: "body > main > .mini-card",
    outerHtml: '<div class="mini-card">Integrations</div>',
    classList: ["mini-card"],
    elementText: "Integrations 9",
    componentName: "MiniCard",
    name: null,
    sourceFile: "fixtures/demo-app/index.html:66",
    computedStyles: {
      width: "232px",
      height: "98px",
      "padding-top": "16px",
      "padding-right": "16px",
      "padding-bottom": "16px",
      "padding-left": "16px",
      "border-radius": "10px",
      "background-color": "rgb(255, 255, 255)",
    },
    styleEdits: {},
    annotation: "",
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function boardWith(pin: Pin): Board {
  return {
    id: "board-1",
    schemaVersion: 1,
    projectId: "project-1",
    title: "Dashboard review",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [pin],
    relationships: [],
  };
}

test("opening Pinnables resets capture instead of toggling the previous session", () => {
  const background = source("packages/extension/src/background/index.ts");
  const actionHandler = background.slice(
    background.indexOf("chrome.action.onClicked"),
    background.indexOf("chrome.commands.onCommand"),
  );

  assert.match(actionHandler, /await setCaptureMode\(false\)/);
  assert.doesNotMatch(actionHandler, /setCaptureMode\(!state\.captureMode\)/);
});

test("re-capturing an existing pin refreshes its recorded element size", () => {
  const background = source("packages/extension/src/background/index.ts");
  const existingMerge = background.slice(
    background.indexOf("const merged: Pin"),
    background.indexOf("await store.writeBoard", background.indexOf("const merged: Pin")),
  );

  assert.match(
    existingMerge,
    /elementSize:\s*\{\s*width:\s*element\.rect\.width,\s*height:\s*element\.rect\.height\s*\}/s,
  );
});

test("padding preview does not invent a second, larger floating component box", () => {
  const pin = elementPin();
  const html = renderToStaticMarkup(
    <PinObject
      pin={pin}
      board={boardWith(pin)}
      position={{ x: 20, y: 20 }}
      pulse={false}
      selected={false}
      primary={false}
      selectionCount={0}
      connecting={false}
      preview={{
        "padding-top": "32px",
        "padding-right": "32px",
        "padding-bottom": "32px",
        "padding-left": "32px",
      }}
      onSelect={() => {}}
      onMove={() => {}}
      onMoveEnd={() => {}}
      onDismiss={() => {}}
      onCommit={async () => {}}
      onRelate={() => {}}
      onAnchorDown={() => {}}
      onAnchorEnter={() => {}}
      onAnchorLeave={() => {}}
    />,
  );

  assert.match(html, /class="pin-object__inner" style="width:232px;height:98px/);
  assert.doesNotMatch(html, /class="pin-object__inner" style="width:264px;height:130px/);
});

test("relationship target selection is owned by the whole card, including the pick affordance", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(pinList, /className="pin-card"[\s\S]{0,240}onClick=\{[^}]*onToggleTarget/);
  assert.match(pinList, /aria-label=\{pickable \? `Select \$\{title/);
});

test("the floating identity label gives the component and source file separate wrapping lines", () => {
  const css = source("packages/extension/src/ui/ui.css");
  const labelRule = css.slice(
    css.indexOf(".pin-object__label {"),
    css.indexOf(".pin-object__label .pin-icon-btn"),
  );

  assert.match(labelRule, /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(labelRule, /grid-template-areas:\s*"name close"\s*"source close"/);
  assert.match(labelRule, /\.pin-object__src\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(labelRule, /\.pin-object__src\s*\{[\s\S]*text-overflow:\s*ellipsis/);
});

test("floating pins measure relationship-driven size from the live page element", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");

  assert.match(overlay, /new ResizeObserver/);
  assert.match(overlay, /renderedSize=\{liveSizes\[pin\.id\]\}/);
});

test("the floating pin does not draw a second permanent outline over the component", () => {
  const css = source("packages/extension/src/ui/ui.css");

  assert.doesNotMatch(css, /\.pin-object__card::after\s*\{/);
});
