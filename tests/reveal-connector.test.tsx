import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Pin } from "@pinnables/shared";
import { PinObject } from "../packages/extension/src/content/PinObject.tsx";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function pin(): Pin {
  return {
    id: "source",
    schemaVersion: 1,
    boardId: "board",
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    url: "http://localhost:5180/#/dashboard",
    route: "/dashboard",
    viewport: { width: 900, height: 700 },
    elementSize: { width: 220, height: 96 },
    screenshotFrame: null,
    screenshotPath: "pins/source.png",
    thumbnailPath: "pins/source.thumb.webp",
    selector: "#source",
    domPath: "body > #source",
    outerHtml: '<div id="source">Source</div>',
    classList: [],
    elementText: "Source",
    componentName: "SourceCard",
    name: null,
    sourceFile: "src/SourceCard.tsx:1",
    computedStyles: {},
    styleEdits: {},
    annotation: "",
    liveSends: [],
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function board(sourcePin: Pin): Board {
  return {
    id: "board",
    schemaVersion: 1,
    projectId: "local",
    title: "Reveal and connector",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [sourcePin],
    relationships: [],
  };
}

test("the same reveal request can be claimed only once", async () => {
  const overlay = await import("../packages/extension/src/content/Overlay.tsx");
  assert.equal(typeof overlay.claimRevealRequest, "function");

  const first = { pinId: "pin-1" };
  const second = { pinId: "pin-1" };
  const handled = { current: null as typeof first | null };

  assert.equal(overlay.claimRevealRequest(handled, first), true);
  assert.equal(overlay.claimRevealRequest(handled, first), false);
  assert.equal(overlay.claimRevealRequest(handled, second), true);
});

test("board and placement refreshes cannot replay a consumed reveal", () => {
  const overlay = source("packages/extension/src/content/Overlay.tsx");
  const reveal = overlay.slice(
    overlay.indexOf("/* --------------------------------------------------------- reveal a pin */"),
    overlay.indexOf("if (!state.enabled && !highlight) return null"),
  );

  assert.match(reveal, /const request = state\.reveal/);
  assert.match(reveal, /if \(handledReveal\.current === request\) return/);
  assert.match(reveal, /if \(!request\.selector && !request\.domPath && !board\) return/);
  assert.match(reveal, /claimRevealRequest\(handledReveal, request\)/);
  assert.doesNotMatch(reveal, /return \(\) => \{[\s\S]*removeEventListener\("scroll"/);
});

test("the connector origin carries a neutral accessible source chip", () => {
  const sourcePin = pin();
  const html = renderToStaticMarkup(
    <PinObject
      pin={sourcePin}
      board={board(sourcePin)}
      position={{ x: 20, y: 20 }}
      pulse={false}
      selected={false}
      primary={false}
      selectionCount={0}
      connecting
      connectionRole="source"
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

  assert.match(html, /class="pin-chip pin-object__connection-role"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Relationship source"/);
  assert.match(html, />source<\/span>/);

  const overlay = source("packages/extension/src/content/Overlay.tsx");
  assert.match(overlay, /connectionRole=\{connecting\?\.fromPinId === pin\.id \? "source" : undefined\}/);

  const css = source("packages/extension/src/ui/ui.css");
  const role = css.slice(
    css.indexOf(".pin-object__connection-role"),
    css.indexOf(".pin-object__connection-role") + 320,
  );
  assert.match(role, /position:\s*absolute/);
  assert.match(role, /pointer-events:\s*none/);
  assert.doesNotMatch(role, /#[0-9a-f]{3,8}|blue|red|amber/i);
});
