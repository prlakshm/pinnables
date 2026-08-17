import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Pin } from "@pinnables/shared";
import { PinObject } from "../packages/extension/src/content/PinObject.tsx";
import { routeForLocation } from "../packages/extension/src/lib/capture.ts";
import { nameForDraft } from "../packages/extension/src/sidepanel/RenamableTitle.tsx";
import {
  computeStyleDiff,
  STYLE_GROUPS,
} from "../packages/shared/src/styles.ts";

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
    liveSends: [],
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
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const actionHandler = background.slice(
    background.indexOf("chrome.action.onClicked"),
    background.indexOf("chrome.commands.onCommand"),
  );

  assert.match(actionHandler, /await setCaptureMode\(false\)/);
  assert.doesNotMatch(actionHandler, /setCaptureMode\(!state\.captureMode\)/);
  assert.match(app, /started\.current/);
  assert.match(app, /send\("capture\/setMode", \{ enabled: false \}\)/);
});

test("declining screenshot access cannot leave the panel claiming to capture", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const toggle = app.slice(
    app.indexOf("const toggleCapture"),
    app.indexOf("const submit"),
  );

  assert.match(
    toggle,
    /const granted = await chrome\.permissions\s*\.request/,
  );
  assert.match(toggle, /if \(!granted\)/);
  assert.match(toggle, /setCaptureIssue\("blocked"\)/);
  assert.match(toggle, /return;/);
});

test("re-capturing an existing pin refreshes its recorded element size", () => {
  const background = source("packages/extension/src/background/index.ts");
  const existingMerge = background.slice(
    background.indexOf("if (existing)"),
    background.indexOf("const pinId", background.indexOf("if (existing)")),
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

test("floating pins render the original capture, never a live-tracked size", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const pinObject = source("packages/extension/src/content/PinObject.tsx");

  // The pin is a receipt of what was pinned. Live-size tracking made the card
  // disagree with its own screenshot, so it must stay gone.
  assert.doesNotMatch(overlay, /renderedSize=/);
  assert.doesNotMatch(pinObject, /renderedSize/);
  assert.doesNotMatch(pinObject, /previewedBorderBoxSize/);
});

test("the floating pin does not draw a second permanent outline over the component", () => {
  const css = source("packages/extension/src/ui/ui.css");

  assert.doesNotMatch(css, /\.pin-object__card::after\s*\{/);
});

test("hash-router screens get distinct route identities", () => {
  assert.equal(
    routeForLocation({ pathname: "/", search: "", hash: "#/dashboard" }),
    "/dashboard",
  );
  assert.equal(
    routeForLocation({ pathname: "/", search: "", hash: "#/settings" }),
    "/settings",
  );
  assert.equal(
    routeForLocation({ pathname: "/docs", search: "?mode=edit", hash: "#section-2" }),
    "/docs?mode=edit",
  );
});

test("style diffs preserve default-to-styled changes in both directions", () => {
  const defaults = elementPin({ computedStyles: {} });
  const styled = elementPin({
    id: "pin-styled",
    computedStyles: {
      "padding-top": "16px",
      "padding-right": "16px",
      "padding-bottom": "16px",
      "padding-left": "16px",
      "border-radius": "12px",
      "box-shadow": "rgba(0, 0, 0, 0.08) 0px 4px 12px 0px",
      "background-color": "rgb(255, 255, 255)",
    },
  });

  const toDefaults = computeStyleDiff(defaults, styled, ["spacing", "radius", "shadow", "color"]);
  const toStyled = computeStyleDiff(styled, defaults, ["spacing", "radius", "shadow", "color"]);

  assert.deepEqual(
    new Map(toDefaults.map((entry) => [entry.property, [entry.from, entry.to]])),
    new Map([
      ["padding", ["16px", "0px"]],
      ["border-radius", ["12px", "0px"]],
      ["box-shadow", ["rgba(0, 0, 0, 0.08) 0px 4px 12px 0px", "none"]],
      ["background-color", ["rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"]],
    ]),
  );
  assert.deepEqual(
    new Map(toStyled.map((entry) => [entry.property, [entry.from, entry.to]])),
    new Map([
      ["padding", ["0px", "16px"]],
      ["border-radius", ["0px", "12px"]],
      ["box-shadow", ["none", "rgba(0, 0, 0, 0.08) 0px 4px 12px 0px"]],
      ["background-color", ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"]],
    ]),
  );
});

test("the inspector names omitted CSS defaults instead of showing blank values", () => {
  const inspector = source("packages/extension/src/sidepanel/Inspector.tsx");

  assert.match(inspector, /STYLE_INITIAL_VALUES/);
  assert.match(inspector, /STYLE_INITIAL_VALUES\[property\] \?\? ""/);
  assert.doesNotMatch(inspector, /const ZERO_BY_DEFAULT/);
});

test("matching a borderless source removes the border without inventing a black one", () => {
  const sourcePin = elementPin({
    computedStyles: { "border-color": "rgb(28, 30, 34)" },
  });
  const targetPin = elementPin({
    id: "pin-bordered",
    computedStyles: {
      "border-width": "1px",
      "border-style": "solid",
      "border-color": "rgb(230, 228, 224)",
    },
  });

  assert.deepEqual(computeStyleDiff(sourcePin, targetPin, ["border"]), [
    { property: "border-width", from: "1px", to: "0px" },
    { property: "border-style", from: "solid", to: "none" },
  ]);
});

test("size relationships capture the flex properties that actually control dimensions", () => {
  assert.ok(STYLE_GROUPS.size.includes("flex-grow"));
  assert.ok(STYLE_GROUPS.size.includes("flex-shrink"));
  assert.ok(STYLE_GROUPS.size.includes("flex-basis"));
});

test("selecting a floating pin does not move its component card", () => {
  const css = source("packages/extension/src/ui/ui.css");
  const labelRule = css.slice(
    css.indexOf(".pin-object__label {"),
    css.indexOf(".pin-object__name {"),
  );

  assert.match(labelRule, /position:\s*absolute/);
  assert.match(labelRule, /transform:\s*translateY/);
});

test("capture-mode changes are broadcast back to the side panel", () => {
  const background = source("packages/extension/src/background/index.ts");
  const setMode = background.slice(
    background.indexOf("async function setCaptureMode"),
    background.indexOf("const handlers"),
  );

  assert.match(setMode, /chrome\.runtime\.sendMessage\(message\)/);
});

test("the keyboard shortcut cannot leave capture armed on an unsupported tab", () => {
  const background = source("packages/extension/src/background/index.ts");
  const commandHandler = background.slice(
    background.indexOf("chrome.commands.onCommand"),
    background.indexOf("/** Screenshots are the bulk of storage"),
  );

  assert.match(commandHandler, /const enabling = !state\.captureMode/);
  assert.match(commandHandler, /const activeTab = await setCaptureMode\(enabling\)/);
  assert.match(commandHandler, /activeTab === "blocked" \|\| activeTab === "unsupported"/);
  assert.match(commandHandler, /await setCaptureMode\(false\)/);
});

test("re-capturing the same pin invalidates both cached panel images", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(pinList, /chrome\.storage\.local\.get\(`thumb:\$\{pin\.id\}`\)[\s\S]{0,180}\[pin\.id, pin\.updatedAt\]/);
  assert.match(pinList, /setShot\(null\)[\s\S]{0,520}\[expanded, pin\.id, pin\.updatedAt\]/);
});

test("region pins cannot be persisted in style relationships", () => {
  const background = source("packages/extension/src/background/index.ts");
  const create = background.slice(
    background.indexOf('async "relationship/create"'),
    background.indexOf('async "relationship/update"'),
  );

  assert.match(create, /source\.kind !== "element"/);
  assert.match(create, /target\.kind !== "element"/);
});

test("leaving a custom pin name unchanged preserves it", () => {
  const pin = elementPin({ name: "Revenue card" });

  assert.equal(nameForDraft("Revenue card", pin, [pin]), "Revenue card");
  assert.equal(nameForDraft("", pin, [pin]), null);
});

test("failed board materialization cannot return a pointer to a missing brief", () => {
  const background = source("packages/extension/src/background/index.ts");
  const markReady = background.slice(
    background.indexOf('async "board/markReady"'),
    background.indexOf('async "pin/update"'),
  );
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.doesNotMatch(markReady, /Read ~\/\.pinnables/);
  assert.match(markReady, /throw new Error\("Local service is offline/);
  assert.match(app, /setSubmitError/);
});

test("generic agent submission never launches a hard-coded Cursor deeplink", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.doesNotMatch(app, /cursor:\/\//);
  assert.doesNotMatch(app, /openInCursor/);
  // Clipboard is the fallback when Cursor Cloud Agents are not configured.
  assert.match(app, /result\.transport !== "cursor"/);
  assert.match(app, /navigator\.clipboard\.writeText\(result\.pointer\)/);
});

test("a new board cannot inherit stale text from the previous instruction field", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const instructionField = app.slice(
    app.indexOf('placeholder="Add instructions for every pin…"') - 120,
    app.indexOf('placeholder="Add instructions for every pin…"') + 300,
  );

  assert.match(app, /setInstructionDraft\(board\?\.globalInstruction \?\? ""\)/);
  assert.match(instructionField, /value=\{instructionDraft\}/);
  assert.match(instructionField, /onChange=\{\(e\) => setInstructionDraft\(e\.target\.value\)\}/);
  assert.doesNotMatch(instructionField, /defaultValue=/);
});

test("a late overlay import obeys the latest capture-mode request", () => {
  const content = source("packages/extension/src/content/index.ts");

  assert.match(content, /desiredEnabled/);
  assert.match(content, /current\.setEnabled\(desiredEnabled\)/);
});

test("preview cleanup restores both inline value and important priority", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");

  assert.match(overlay, /getPropertyPriority\(property\)/);
  assert.match(overlay, /setProperty\(property, had, priority\)/);
});

test("drawing saves share the per-board mutation queue and verify their sender tab", () => {
  const background = source("packages/extension/src/background/index.ts");
  const drawingSave = background.slice(
    background.indexOf('async "drawing/save"'),
    background.indexOf('async "board/get"'),
  );

  assert.match(drawingSave, /store\.mutateBoard\(board\.id/);
  assert.doesNotMatch(drawingSave, /store\.writeBoard/);
  assert.match(drawingSave, /activeBefore/);
  assert.match(drawingSave, /activeAfter/);
});

test("deleting pins or clearing a board drops screenshots after the queued mutation", () => {
  const background = source("packages/extension/src/background/index.ts");
  const pinDelete = background.slice(
    background.indexOf('async "pin/delete"'),
    background.indexOf('async "pin/reorder"'),
  );
  const boardClear = background.slice(
    background.indexOf('async "board/clear"'),
    background.indexOf('async "relationship/delete"'),
  );

  assert.ok(pinDelete.indexOf("store.mutateBoard") < pinDelete.indexOf("store.dropScreenshot"));
  assert.ok(boardClear.indexOf("store.mutateBoard") < boardClear.indexOf("store.dropScreenshot"));
});

test("a queued run records starting and working on the board, not only while its bar is open", async () => {
  const liveSend = await import("../packages/extension/src/lib/live-send.ts");
  assert.equal(liveSend.recordableLiveSendState("queued"), null);
  assert.equal(liveSend.recordableLiveSendState("starting"), "starting");
  assert.equal(liveSend.recordableLiveSendState("working"), "working");
  assert.equal(liveSend.liveSendNeedsPoll("queued"), true);
  assert.equal(liveSend.liveSendNeedsPoll("done"), false);

  const dialog = source("packages/extension/src/content/SelectionDialog.tsx");
  const composer = source("packages/extension/src/content/Composer.tsx");
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const background = source("packages/extension/src/background/index.ts");
  const messages = source("packages/extension/src/lib/messages.ts");

  assert.match(dialog, /recordableLiveSendState/);
  assert.match(composer, /recordableLiveSendState/);
  assert.match(overlay, /pendingLiveSendIds/);
  assert.match(overlay, /pendingLiveKey/);
  assert.match(messages, /state: "starting" \| "working" \| "done" \| "failed"/);
  assert.match(background, /advanceLiveSendState/);
  assert.match(dialog, /pollTimers/);
  assert.match(composer, /pollTimers/);
  assert.match(dialog, /watchingId\.current === messageId/);
  assert.doesNotMatch(dialog, /pollTimer\.current = window\.setTimeout/);
});

test("a chat row key press restores that row's numeral", () => {
  const dialog = source("packages/extension/src/content/SelectionDialog.tsx");
  assert.match(dialog, /onPress=\{\(\) => pressVersion\(settledKey\)\}/);
  assert.match(
    dialog,
    /void send\("version\/restore", \{ pinId: primary\.id, no \}\)/,
  );
});

test("a later send's status GET still refreshes earlier Cursor runs", () => {
  const service = source("packages/service/src/index.ts");
  const cursor = source("packages/service/src/agents/cursor.ts");
  const getLive = service.slice(
    service.indexOf("const liveMatch"),
    service.indexOf("Versions. Snapshot"),
  );
  assert.match(getLive, /await refreshActiveAgentRuns\(\)/);
  assert.doesNotMatch(
    getLive,
    /if \(found\.state === "done" \|\| found\.state === "failed" \|\| found\.state === "queued"\)/,
  );
  assert.match(cursor, /localRunResults/);
  assert.match(cursor, /run\.wait\(\)/);
  assert.match(cursor, /Agent\.getRun/);
});
