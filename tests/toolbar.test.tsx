import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DRAW_COLORS } from "@pinnables/shared";
import * as toolbarModule from "../packages/extension/src/content/Toolbar.tsx";

const { Toolbar } = toolbarModule;
const toolbarSource = readFileSync(
  new URL("../packages/extension/src/content/Toolbar.tsx", import.meta.url),
  "utf8",
);

function renderToolbar(drawTool: "draw" | "erase", drawColor = DRAW_COLORS[0]): string {
  return renderToStaticMarkup(
    <Toolbar
      mode="draw"
      onMode={() => {}}
      pinCount={3}
      onExit={() => {}}
      drawTool={drawTool}
      onDrawTool={() => {}}
      drawColor={drawColor}
      onDrawColor={() => {}}
    />,
  );
}

function buttonTag(markup: string, label: string): string {
  const marker = `aria-label="${label}"`;
  const markerAt = markup.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing button labelled ${label}`);
  const start = markup.lastIndexOf("<button", markerAt);
  const end = markup.indexOf(">", markerAt);
  assert.notEqual(start, -1, `missing opening button tag for ${label}`);
  assert.notEqual(end, -1, `missing closing bracket for ${label}`);
  return markup.slice(start, end + 1);
}

test("erase is the only pressed drawing tool while erase mode is active", () => {
  const markup = renderToolbar("erase");

  assert.match(buttonTag(markup, "Erase"), /aria-pressed="true"/);
  assert.match(buttonTag(markup, "Draw on a pin · D"), /aria-pressed="false"/);
});

test("pen colours expose one pressed selection", () => {
  const selected = DRAW_COLORS[1];
  const markup = renderToolbar("draw", selected);

  assert.equal(markup.match(/class="pin-pen"[^>]*aria-pressed="true"/g)?.length, 1);
  assert.equal(
    markup.match(/class="pin-pen"[^>]*aria-pressed="false"/g)?.length,
    DRAW_COLORS.length - 1,
  );
  assert.match(buttonTag(markup, `Draw in ${selected}`), /aria-pressed="true"/);
});

test("toolbar positions stay within the viewport gutter", () => {
  const clampToolbarPosition = (
    toolbarModule as typeof toolbarModule & {
      clampToolbarPosition?: (
        position: { x: number; y: number },
        toolbar: { width: number; height: number },
        viewport: { width: number; height: number },
      ) => { x: number; y: number };
    }
  ).clampToolbarPosition;

  assert.equal(typeof clampToolbarPosition, "function");
  if (!clampToolbarPosition) return;

  assert.deepEqual(
    clampToolbarPosition(
      { x: -40, y: 999 },
      { width: 260, height: 44 },
      { width: 800, height: 600 },
    ),
    { x: 8, y: 548 },
  );
  assert.deepEqual(
    clampToolbarPosition(
      { x: 900, y: -20 },
      { width: 260, height: 44 },
      { width: 800, height: 600 },
    ),
    { x: 532, y: 8 },
  );
  assert.deepEqual(
    clampToolbarPosition(
      { x: 50, y: 20 },
      { width: 260, height: 44 },
      { width: 200, height: 40 },
    ),
    { x: 8, y: 8 },
  );
});

test("stored and resized toolbar positions are re-clamped", () => {
  assert.match(toolbarSource, /if \(stored\) setPosition\(clampPosition\(stored\)\)/);
  assert.match(toolbarSource, /window\.addEventListener\("resize", keepReachable\)/);
  assert.match(toolbarSource, /window\.removeEventListener\("resize", keepReachable\)/);
  assert.match(
    toolbarSource,
    /setPosition\(\(current\) => \{[\s\S]{0,240}clampPosition\(current\)/,
  );
});

test("pointer cancellation releases capture and ends toolbar dragging", () => {
  assert.match(toolbarSource, /const endDrag = useCallback/);
  assert.match(toolbarSource, /dragging\.current = null/);
  assert.match(toolbarSource, /hasPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(toolbarSource, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(toolbarSource, /onPointerUp=\{endDrag\}/);
  assert.match(toolbarSource, /onPointerCancel=\{endDrag\}/);
});
