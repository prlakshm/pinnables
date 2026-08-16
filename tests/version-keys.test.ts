import assert from "node:assert/strict";
import test from "node:test";

import type { Board, Capture, Pin, PinVersion } from "@pinnables/shared";

/**
 * Version keys — minting, the ring, restore bookkeeping, capture hygiene.
 *
 * Every completed run earns a numeral; these tests hold the worker to the
 * rules the mock established: numbers are names (assigned once, never
 * recomputed), the ring stays five wide by eviction, a key lives in exactly
 * one rail, and restore reverses out of the current state before applying
 * the target's.
 */

type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

type WireResponse<T> = { ok: true; data: T } | { ok: false; error: string };

const BOARD_ID = "board-version-keys";
const BOARD_KEY = `board:${BOARD_ID}`;

let memory: Record<string, unknown> = {};
let backgroundListener: BackgroundListener | null = null;

/* The service, faked at the fetch boundary. */
let healthVersionsOk = true;
let restoreCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let restoreConflicts: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/health")) {
    return new Response(
      JSON.stringify({
        ok: true,
        home: "/tmp",
        versions: { ok: healthVersionsOk, detail: healthVersionsOk ? null : "no git" },
      }),
      { status: 200 },
    );
  }
  if (/\/versions\/[^/]+\/restore$/.test(url)) {
    restoreCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({ ok: true, conflicts: restoreConflicts, files: [] }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ error: `unexpected fetch ${url}` }), { status: 500 });
}) as typeof fetch;
void realFetch;

const chromeStub = {
  storage: {
    local: {
      async get(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.map((k) => [k, structuredClone(memory[k])]));
      },
      async set(entries: Record<string, unknown>) {
        Object.assign(memory, structuredClone(entries));
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete memory[k];
      },
    },
  },
  runtime: {
    id: "version-keys-test",
    getManifest: () => ({ content_scripts: [] }),
    sendMessage: async () => undefined,
    onMessage: {
      addListener(listener: BackgroundListener) {
        backgroundListener = listener;
      },
    },
    onInstalled: { addListener() {} },
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => undefined,
    update: async () => ({}),
    get: async () => ({}),
    captureVisibleTab: async () => "data:image/png;base64,",
    onRemoved: { addListener() {}, removeListener() {} },
    onUpdated: { addListener() {}, removeListener() {} },
  },
  scripting: { executeScript: async () => [] },
  sidePanel: {
    setPanelBehavior: async () => undefined,
    open: async () => undefined,
  },
  action: { onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeStub as unknown as typeof chrome,
});

await import("../packages/extension/src/background/index.ts");

function pinWith(overrides: Partial<Pin>): Pin {
  return {
    id: "pin-v",
    schemaVersion: 1,
    boardId: BOARD_ID,
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    provisional: false,
    url: "http://localhost:5173/",
    route: "/",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 240, height: 120 },
    screenshotPath: "pins/pin-v.png",
    thumbnailPath: "pins/pin-v.thumb.webp",
    selector: '[data-pin="v"]',
    domPath: 'body > [data-pin="v"]',
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
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Version keys",
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

function install(next: Board): void {
  memory = {
    boardIds: [BOARD_ID],
    state: { activeBoardId: BOARD_ID, captureMode: false },
    [BOARD_KEY]: structuredClone(next),
  };
}

function storedBoard(): Board {
  return memory[BOARD_KEY] as Board;
}

async function dispatch<T>(message: Record<string, unknown>): Promise<WireResponse<T>> {
  assert.ok(backgroundListener, "background listener registered");
  return new Promise<WireResponse<T>>((resolve) => {
    backgroundListener!(message, {}, (response) => resolve(response as WireResponse<T>));
  });
}

function ver(no: number, messageId: string | null, label = `take ${no}`): PinVersion {
  return { no, messageId, label, at: "2026-08-13T00:00:00.000Z", screenshotKey: null };
}

/* ------------------------------------------------------------------ mint */

test("a run landing done mints the original plus its own key", async () => {
  healthVersionsOk = true;
  install(
    boardWith([
      pinWith({
        liveSends: [
          {
            text: "change to green",
            at: "2026-08-13T00:00:01.000Z",
            messageId: "msg-1",
            state: "working",
            versionNo: null,
          },
        ],
      }),
    ]),
  );

  const res = await dispatch({ type: "agent/recordOutcome", messageId: "msg-1", state: "done" });
  assert.equal(res.ok, true);

  const pin = storedBoard().pins[0];
  assert.equal(pin.versionSeq, 2);
  assert.equal(pin.currentVersionNo, 2);
  assert.deepEqual(
    pin.versions.map((v) => [v.no, v.messageId, v.label]),
    [
      [1, null, "original"],
      [2, "msg-1", "change to green"],
    ],
  );
  assert.equal(pin.liveSends[0].state, "done");
  assert.equal(pin.liveSends[0].versionNo, 2);
});

test("a repeated done for the same message never mints twice", async () => {
  const before = structuredClone(storedBoard().pins);
  const res = await dispatch({ type: "agent/recordOutcome", messageId: "msg-1", state: "done" });
  assert.equal(res.ok, true);
  /* mutateBoard stamps updatedAt on every pass; the pins are the claim. */
  assert.deepEqual(storedBoard().pins, before);
});

test("a second done in the same chapter, with 1 and 2 showing, earns key 3", async () => {
  healthVersionsOk = true;
  install(
    boardWith([
      pinWith({
        versionSeq: 2,
        currentVersionNo: 2,
        versions: [ver(1, null, "original"), ver(2, "m1", "change to green")],
        liveSends: [
          {
            text: "change to green",
            at: "2026-08-13T00:00:01.000Z",
            messageId: "msg-1",
            state: "done",
            versionNo: 2,
          },
          {
            text: "make it rose",
            at: "2026-08-13T00:00:02.000Z",
            messageId: "msg-2",
            state: "working",
            versionNo: null,
          },
        ],
      }),
    ]),
  );

  const res = await dispatch({ type: "agent/recordOutcome", messageId: "msg-2", state: "done" });
  assert.equal(res.ok, true);

  const pin = storedBoard().pins[0];
  assert.equal(pin.versionSeq, 3);
  assert.equal(pin.currentVersionNo, 3);
  assert.deepEqual(
    pin.versions.map((v) => [v.no, v.messageId]),
    [
      [1, null],
      [2, "m1"],
      [3, "msg-2"],
    ],
  );
  assert.equal(pin.liveSends[1].versionNo, 3);
});

test("a failed run records its outcome and earns nothing", async () => {
  install(
    boardWith([
      pinWith({
        liveSends: [
          {
            text: "break something",
            at: "2026-08-13T00:00:01.000Z",
            messageId: "msg-2",
            state: "working",
            versionNo: null,
          },
        ],
      }),
    ]),
  );
  await dispatch({ type: "agent/recordOutcome", messageId: "msg-2", state: "failed" });
  const pin = storedBoard().pins[0];
  assert.equal(pin.liveSends[0].state, "failed");
  assert.equal(pin.versions.length, 0);
  assert.equal(pin.currentVersionNo, null);
});

test("no git tree means outcomes record but keys are never minted", async () => {
  healthVersionsOk = false;
  install(
    boardWith([
      pinWith({
        liveSends: [
          {
            text: "change to rose",
            at: "2026-08-13T00:00:01.000Z",
            messageId: "msg-3",
            state: "working",
            versionNo: null,
          },
        ],
      }),
    ]),
  );
  await dispatch({ type: "agent/recordOutcome", messageId: "msg-3", state: "done" });
  const pin = storedBoard().pins[0];
  assert.equal(pin.liveSends[0].state, "done");
  assert.equal(pin.liveSends[0].versionNo, null);
  assert.equal(pin.versions.length, 0);
  healthVersionsOk = true;
});

/* ------------------------------------------------------------------ ring */

test("the sixth take retakes key 1 and evicts it everywhere", async () => {
  install(
    boardWith(
      [
        pinWith({
          versionSeq: 5,
          currentVersionNo: 5,
          versions: [
            ver(1, null, "original"),
            ver(2, "m2"),
            ver(3, "m3"),
            ver(4, "m4"),
            ver(5, "m5"),
          ],
          liveSends: [
            {
              text: "one more change",
              at: "2026-08-13T00:00:06.000Z",
              messageId: "msg-6",
              state: "working",
              versionNo: null,
            },
          ],
        }),
      ],
      [
        /* A capture holding only the doomed key dies with it; one holding
           more gives the key up and stays. */
        { id: "cap-a", pinId: "pin-v", keys: [1], current: 1, pos: { x: 40, y: 40 }, railPos: null },
        {
          id: "cap-b",
          pinId: "pin-v",
          keys: [1, 3],
          current: 1,
          pos: { x: 400, y: 40 },
          railPos: null,
        },
      ],
    ),
  );
  memory["verShot:pin-v:1"] = "the original's picture";

  await dispatch({ type: "agent/recordOutcome", messageId: "msg-6", state: "done" });

  const b = storedBoard();
  const pin = b.pins[0];
  assert.equal(pin.versionSeq, 6);
  assert.equal(pin.currentVersionNo, 1);
  assert.deepEqual(
    pin.versions.map((v) => [v.no, v.messageId]).sort((a, b2) => Number(a[0]) - Number(b2[0])),
    [
      [1, "msg-6"],
      [2, "m2"],
      [3, "m3"],
      [4, "m4"],
      [5, "m5"],
    ],
  );
  assert.deepEqual(
    b.captures.map((cap) => [cap.id, cap.keys, cap.current]),
    [["cap-b", [3], 3]],
  );
  assert.equal(memory["verShot:pin-v:1"], undefined, "the evicted key's picture goes with it");
});

/* --------------------------------------------------------------- restore */

test("restore reverses out of the current version and applies the target", async () => {
  restoreCalls = [];
  install(
    boardWith([
      pinWith({
        versionSeq: 2,
        currentVersionNo: 2,
        versions: [ver(1, null, "original"), ver(2, "m2", "change to green")],
      }),
    ]),
  );

  const res = await dispatch<{ board: Board; conflicts: string[] }>({
    type: "version/restore",
    pinId: "pin-v",
    no: 1,
  });
  assert.equal(res.ok, true);
  assert.equal(restoreCalls.length, 1);
  /* The original's snapshot is the board's baseline. */
  assert.match(restoreCalls[0].url, /\/versions\/baseline\/restore$/);
  assert.deepEqual(restoreCalls[0].body, { boardId: BOARD_ID, fromMessageId: "m2" });
  assert.equal(storedBoard().pins[0].currentVersionNo, 1);
});

test("restoring the lit key is a no-op that never calls the service", async () => {
  restoreCalls = [];
  const res = await dispatch<{ board: Board; conflicts: string[] }>({
    type: "version/restore",
    pinId: "pin-v",
    no: 1,
  });
  assert.equal(res.ok, true);
  assert.equal(restoreCalls.length, 0);
});

test("restore surfaces the files where the version overwrote a hand edit", async () => {
  restoreCalls = [];
  restoreConflicts = ["src/components/VarietyCard.tsx"];
  const res = await dispatch<{ board: Board; conflicts: string[] }>({
    type: "version/restore",
    pinId: "pin-v",
    no: 2,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data.conflicts, ["src/components/VarietyCard.tsx"]);
  restoreConflicts = [];
});

/* --------------------------------------------------------------- captures */

test("capture/save keeps the partition honest", async () => {
  install(
    boardWith([
      pinWith({
        versionSeq: 3,
        currentVersionNo: 3,
        versions: [ver(1, null, "original"), ver(2, "m2"), ver(3, "m3")],
      }),
    ]),
  );

  const res = await dispatch<{ board: Board }>({
    type: "capture/save",
    boardId: BOARD_ID,
    captures: [
      /* Key 9 was never minted; key 2 is real. The stale key drops, the
         capture stays, and its lit key falls back to one it actually holds. */
      { id: "cap-1", pinId: "pin-v", keys: [2, 9], current: 9, pos: { x: 10, y: 10 }, railPos: null },
      /* Nothing real left — the capture goes entirely. */
      { id: "cap-2", pinId: "pin-v", keys: [9], current: 9, pos: { x: 20, y: 20 }, railPos: null },
      /* An unknown pin cannot hold anything. */
      { id: "cap-3", pinId: "pin-x", keys: [2], current: 2, pos: { x: 30, y: 30 }, railPos: null },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(
    storedBoard().captures.map((cap) => [cap.id, cap.keys, cap.current]),
    [["cap-1", [2], 2]],
  );
});

test("deleting a pin takes its captures and version pictures with it", async () => {
  install(
    boardWith(
      [
        pinWith({
          versionSeq: 2,
          currentVersionNo: 2,
          versions: [ver(1, null, "original"), ver(2, "m2")],
        }),
      ],
      [{ id: "cap-1", pinId: "pin-v", keys: [2], current: 2, pos: { x: 10, y: 10 }, railPos: null }],
    ),
  );
  memory["verShot:pin-v:1"] = "p1";
  memory["verShot:pin-v:2"] = "p2";

  await dispatch({ type: "pin/delete", pinId: "pin-v" });

  assert.equal(storedBoard().pins.length, 0);
  assert.deepEqual(storedBoard().captures, []);
  assert.equal(memory["verShot:pin-v:1"], undefined);
  assert.equal(memory["verShot:pin-v:2"], undefined);
});
