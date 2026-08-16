import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Capture, Pin, PinVersion } from "@pinnables/shared";

/**
 * The version surfaces, rendered: chat rows wear the same keycap the rail
 * does, the rail shows the remainder of the partition, and neither appears
 * when the feature cannot deliver.
 */

/* SSR touches no chrome APIs (effects don't run), but module scope needs the
   global to exist for imports that probe it. */
const chromeStub = {
  runtime: { id: "ui-test" },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
};
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeStub as unknown as typeof chrome,
});

const { SelectionDialog } = await import("../packages/extension/src/content/SelectionDialog.tsx");
const { VersionLayer } = await import("../packages/extension/src/content/VersionRail.tsx");

function ver(no: number, messageId: string | null, label = `take ${no}`): PinVersion {
  return { no, messageId, label, at: "2026-08-13T00:00:00.000Z", screenshotKey: null };
}

function pinWith(overrides: Partial<Pin>): Pin {
  return {
    id: "pin-ui",
    schemaVersion: 1,
    boardId: "board-ui",
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    provisional: false,
    url: "http://localhost:5173/",
    route: "/",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 240, height: 120 },
    screenshotPath: "pins/pin-ui.png",
    thumbnailPath: "pins/pin-ui.thumb.webp",
    selector: ".variety-card",
    domPath: "body > .variety-card",
    outerHtml: "<div></div>",
    classList: [],
    elementText: "Rose",
    elementLabel: null,
    componentName: "VarietyCard",
    name: null,
    sourceFile: null,
    computedStyles: {},
    styleEdits: {},
    annotation: "",
    liveSends: [],
    versions: [],
    versionSeq: 0,
    currentVersionNo: null,
    railPos: null,
    boxPos: null,
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function boardWith(pins: Pin[], captures: Capture[] = []): Board {
  return {
    id: "board-ui",
    schemaVersion: 1,
    projectId: "local",
    title: "UI",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    pins,
    relationships: [],
    captures,
  };
}

function renderDialog(pin: Pin): string {
  return renderToStaticMarkup(
    <SelectionDialog
      pins={[pin]}
      board={boardWith([pin])}
      position={{ x: 100, y: 100, width: 380 }}
      targetOf={null}
      relationshipId={null}
      drawingSummary={null}
      onLiveSent={() => {}}
      onAddToBoard={async () => {}}
      onRelate={null}
      onDismiss={() => {}}
    />,
  );
}

test("a settled chat row wears the version key that its run earned", () => {
  const pin = pinWith({
    versionSeq: 3,
    currentVersionNo: 3,
    versions: [ver(1, null, "original"), ver(2, "m2", "change to green"), ver(3, "m3", "rose")],
    liveSends: [
      { text: "change to green", at: "2026-08-13T00:01:00.000Z", messageId: "m2", state: "done", versionNo: 2 },
      { text: "rose", at: "2026-08-13T00:02:00.000Z", messageId: "m3", state: "done", versionNo: 3 },
    ],
  });
  const html = renderDialog(pin);
  /* Both rows keyed; the lit one marked; each key carries its own ⌥. */
  assert.match(html, /data-msg="m2"/);
  assert.match(html, /data-msg="m3"/);
  assert.match(html, /data-no="3"[^>]*data-on="true"/);
  assert.match(html, /data-no="2"[^>]*data-on="false"/);
  assert.match(html, /pin-key__mod/);
  /* Newest first: m3's row precedes m2's. */
  assert.ok(html.indexOf('data-msg="m3"') < html.indexOf('data-msg="m2"'));
});

test("a row whose take rotated off keeps its words and loses its key", () => {
  const pin = pinWith({
    versionSeq: 7,
    currentVersionNo: 2,
    /* Key 2 now belongs to a NEWER take (m7). The old row's m2 is gone. */
    versions: [ver(2, "m7", "newer take")],
    liveSends: [
      { text: "change to green", at: "2026-08-13T00:01:00.000Z", messageId: "m2", state: "done", versionNo: 2 },
    ],
  });
  const html = renderDialog(pin);
  assert.match(html, /change to green/);
  /* No key on the row: the numeral names a different take now. */
  assert.doesNotMatch(html, /data-msg="m2"/);
});

function renderLayer(pin: Pin, captures: Capture[] = [], versionsOk = true): string {
  return renderToStaticMarkup(
    <VersionLayer
      board={boardWith([pin], captures)}
      pin={pin}
      liveRect={new DOMRectLike() as unknown as DOMRect}
      visible={true}
      versionsOk={versionsOk}
      busy={false}
      onBusy={() => {}}
      onScoot={() => {}}
      mainRail={{ x: 450, y: 280, seat: "card-right" }}
      boxRect={{ x: 100, y: 400, width: 380, height: 120 }}
      onRailSize={() => {}}
    />,
  );
}

/* SSR has no DOMRect; the layer only reads x/y/width/height. */
class DOMRectLike {
  x = 200;
  y = 200;
  width = 240;
  height = 160;
}

test("the rail shows the remainder: keys held by captures leave the main rail", () => {
  const pin = pinWith({
    versionSeq: 3,
    currentVersionNo: 3,
    versions: [ver(1, null, "original"), ver(2, "m2"), ver(3, "m3")],
  });
  const captures: Capture[] = [
    { id: "cap-1", pinId: "pin-ui", keys: [2], current: 2, pos: { x: 500, y: 200 }, railPos: null },
  ];
  const html = renderLayer(pin, captures);
  const main = html.slice(html.indexOf('data-rail="main"'), html.indexOf('class="pin-capture"'));
  assert.match(main, /data-no="1"/);
  assert.doesNotMatch(main, /data-no="2"/);
  assert.match(main, /data-no="3"[^>]*data-on="true"/);
  /* The capture's own rail holds the dealt key, lit. */
  const own = html.slice(html.indexOf("pin-versions--own"));
  assert.match(own, /data-no="2"[^>]*data-on="true"/);
  /* Every rail leads with the grip and the modifier legend. */
  assert.match(html, /pin-versions__grip/);
  assert.match(html, /pin-versions__mod/);
});

test("one key is no rail: nothing renders until there are two states", () => {
  const pin = pinWith({
    versionSeq: 1,
    currentVersionNo: 1,
    versions: [ver(1, null, "original")],
  });
  assert.equal(renderLayer(pin), "");
});

test("existing versions still render the rail when health has not said versions are ok", () => {
  const pin = pinWith({
    versionSeq: 2,
    currentVersionNo: 2,
    versions: [ver(1, null, "original"), ver(2, "m2")],
  });
  const html = renderLayer(pin, [], false);
  assert.match(html, /data-rail="main"/);
  assert.match(html, /data-no="1"/);
  assert.match(html, /data-no="2"/);
});

test("versionsOk no longer hides an existing rail in source", () => {
  const rail = readFileSync(
    new URL("../packages/extension/src/content/VersionRail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(rail, /const showMain = visible && versions\.length >= 2 && liveRect !== null/);
  assert.match(rail, /if \(!visible \|\| versions\.length < 2\) return null/);
  assert.doesNotMatch(rail, /if \(!visible \|\| !versionsOk \|\| versions\.length < 2\) return null/);
});

test("existing versions still render the rail when the chapter head is not known yet", () => {
  const pin = pinWith({
    versionSeq: 2,
    currentVersionNo: 2,
    versions: [
      { ...ver(1, null, "original"), head: "H1" },
      { ...ver(2, "m2"), head: "H1" },
    ],
  });
  const html = renderLayerWithHead(pin, null);
  assert.match(html, /data-rail="main"/);
  assert.match(html, /data-no="1"/);
  assert.match(html, /data-no="2"/);
});

/* ------------------------------------------------------------- chapters */

function renderDialogWithHead(pin: Pin, projectHead: string | null): string {
  return renderToStaticMarkup(
    <SelectionDialog
      pins={[pin]}
      board={boardWith([pin])}
      position={{ x: 100, y: 100, width: 380 }}
      projectHead={projectHead}
      targetOf={null}
      relationshipId={null}
      drawingSummary={null}
      onLiveSent={() => {}}
      onAddToBoard={async () => {}}
      onRelate={null}
      onDismiss={() => {}}
    />,
  );
}

test("a commit closes the chapter: settled rows from before it leave the box", () => {
  const pin = pinWith({
    versionSeq: 3,
    currentVersionNo: 3,
    versions: [
      { ...ver(2, "m2", "old chapter"), head: "H1" },
      { ...ver(3, "m3", "new chapter"), head: "H2" },
    ],
    liveSends: [
      { text: "old chapter", at: "2026-08-14T00:01:00.000Z", messageId: "m2", state: "done", versionNo: 2, head: "H1" },
      { text: "new chapter", at: "2026-08-14T00:02:00.000Z", messageId: "m3", state: "done", versionNo: 3, head: "H2" },
      { text: "still running", at: "2026-08-14T00:03:00.000Z", messageId: "m4", state: "working", versionNo: null, head: "H1" },
    ],
  });
  const html = renderDialogWithHead(pin, "H2");
  assert.doesNotMatch(html, /old chapter/, "absorbed by the commit");
  assert.match(html, /new chapter/);
  /* A run in flight is a fact until it lands, whatever its stamp. */
  assert.match(html, /still running/);
});

test("null heads tolerate old data: everything shows", () => {
  const pin = pinWith({
    versionSeq: 2,
    currentVersionNo: 2,
    versions: [{ ...ver(2, "m2", "pre-chapter"), head: null }],
    liveSends: [
      { text: "pre-chapter", at: "2026-08-14T00:01:00.000Z", messageId: "m2", state: "done", versionNo: 2, head: null },
    ],
  });
  assert.match(renderDialogWithHead(pin, "H2"), /pre-chapter/);
});

function renderLayerWithHead(pin: Pin, projectHead: string | null): string {
  return renderToStaticMarkup(
    <VersionLayer
      board={boardWith([pin])}
      pin={pin}
      liveRect={new DOMRectLike() as unknown as DOMRect}
      visible={true}
      versionsOk={true}
      projectHead={projectHead}
      busy={false}
      onBusy={() => {}}
      onScoot={() => {}}
      mainRail={{ x: 450, y: 280, seat: "card-right" }}
      boxRect={{ x: 100, y: 400, width: 380, height: 120 }}
      onRailSize={() => {}}
    />,
  );
}

test("stale keys leave the rail; a chapter with under two fresh keys has no rail", () => {
  const mixed = pinWith({
    versionSeq: 4,
    currentVersionNo: 4,
    versions: [
      { ...ver(1, null, "original"), head: "H2" },
      { ...ver(2, "m2", "old take"), head: "H1" },
      { ...ver(4, "m4", "new take"), head: "H2" },
    ],
  });
  const html = renderLayerWithHead(mixed, "H2");
  assert.match(html, /data-no="1"/);
  assert.doesNotMatch(html, /data-no="2"/, "the old chapter's key is gone");
  assert.match(html, /data-no="4"[^>]*data-on="true"/);

  /* Move the chapter on: nothing fresh survives, so nothing renders. */
  assert.equal(renderLayerWithHead(mixed, "H3"), "");
});
