import assert from "node:assert/strict";
import test from "node:test";

import type { Board, Capture, Pin } from "@pinnables/shared";
import type { CapturedElement } from "../packages/extension/src/lib/messages";

/**
 * Chapters and inheritance — the conversation belongs to the component, and
 * everything it produces lives from the moment it is said until the commit
 * that makes it true.
 *
 * Covered here: a board push is a message every pushed pin records and can
 * mint from (on the frozen board, after the active pointer moved on); a new
 * pin inherits its component's conversation from earlier boards; and the
 * HEAD stamp decides what the box and the rail still show.
 */

type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

type WireResponse<T> = { ok: true; data: T } | { ok: false; error: string };

const BOARD_ID = "board-ch1";
const TAB = { id: 7, windowId: 3, url: "http://localhost:5173/catalogue" };

let memory: Record<string, unknown> = {};
let backgroundListener: BackgroundListener | null = null;

/* The service, faked at the fetch boundary. `head` is mutable so a test can
   commit — moving the chapter — between two requests. */
let head: string | null = "H1";
let pushResult: Record<string, unknown> | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/health")) {
    return new Response(
      JSON.stringify({
        ok: true,
        home: "/tmp",
        versions: { ok: true, detail: null, head },
      }),
      { status: 200 },
    );
  }
  if (/\/boards\/[^/]+\/push$/.test(url)) {
    return new Response(JSON.stringify(pushResult ?? { error: "no push scripted" }), {
      status: pushResult ? 200 : 500,
    });
  }
  if (url.endsWith("/messages")) {
    return new Response(
      JSON.stringify({ messageId: "live-1", transport: "local", url: null, state: "starting" }),
      { status: 200 },
    );
  }
  if (/\/versions\/[^/]+\/restore$/.test(url)) {
    void init;
    return new Response(JSON.stringify({ ok: true, conflicts: [], files: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: `unexpected fetch ${url}` }), { status: 500 });
}) as typeof fetch;

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
    id: "version-chapters-test",
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
    /* The sender tab is always the active one in these tests. */
    query: async () => [TAB],
    sendMessage: async () => undefined,
    update: async () => ({}),
    get: async () => ({}),
    captureVisibleTab: async () => "data:image/png;base64,frame",
    onRemoved: { addListener() {}, removeListener() {} },
    onUpdated: { addListener() {}, removeListener() {} },
  },
  scripting: { executeScript: async () => [] },
  sidePanel: { setPanelBehavior: async () => undefined, open: async () => undefined },
  action: { onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeStub as unknown as typeof chrome,
});
Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async () => ({ width: 1280, height: 800, close() {} }),
});
Object.defineProperty(globalThis, "OffscreenCanvas", {
  configurable: true,
  value: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob(options: { type: string }) {
      return { type: options.type };
    }
  },
});
Object.defineProperty(globalThis, "FileReader", {
  configurable: true,
  value: class {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(blob: { type?: string }) {
      this.result = `data:${blob.type ?? "application/octet-stream"};base64,encoded`;
      queueMicrotask(() => this.onload?.());
    }
  },
});

await import("../packages/extension/src/background/index.ts");

function pinWith(overrides: Partial<Pin>): Pin {
  return {
    id: "pin-a",
    schemaVersion: 1,
    boardId: BOARD_ID,
    kind: "element",
    drawings: [],
    order: 1,
    groupId: null,
    provisional: false,
    url: TAB.url,
    route: "/catalogue",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 240, height: 120 },
    screenshotPath: "pins/pin-a.png",
    thumbnailPath: "pins/pin-a.thumb.webp",
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
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function boardWith(pins: Pin[], captures: Capture[] = []): Board {
  return {
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Chapter one",
    globalInstruction: "Polish the cards",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    pins,
    relationships: [],
    captures,
  };
}

function install(next: Board): void {
  memory = {
    boardIds: [next.id],
    state: { activeBoardId: next.id, captureMode: true },
    [`board:${next.id}`]: structuredClone(next),
  };
}

function readBoardFromMemory(id: string): Board {
  return memory[`board:${id}`] as Board;
}

function activeBoardId(): string {
  return (memory.state as { activeBoardId: string }).activeBoardId;
}

async function dispatch<T>(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender = {},
): Promise<WireResponse<T>> {
  assert.ok(backgroundListener, "background listener registered");
  return new Promise<WireResponse<T>>((resolve) => {
    backgroundListener!(message, sender, (response) => resolve(response as WireResponse<T>));
  });
}

function capturedElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    rect: { x: 20, y: 30, width: 240, height: 120 },
    devicePixelRatio: 1,
    url: TAB.url,
    route: "/catalogue",
    viewport: { width: 1280, height: 800 },
    selector: ".variety-card",
    domPath: "body > .variety-card",
    outerHtml: "<div></div>",
    classList: [],
    elementText: "Rose",
    elementLabel: "Rose",
    componentName: "VarietyCard",
    sourceFile: null,
    computedStyles: {},
    ...overrides,
  };
}

/* --------------------------------------------------------- the board push */

test("a board push becomes a message every pushed pin records", async () => {
  head = "H1";
  pushResult = {
    messageId: "push-1",
    boardDir: "/tmp/board",
    pointer: "Load board",
    transport: "cursor",
    state: "starting",
  };
  install(
    boardWith([
      pinWith({ id: "pin-a", annotation: "make it green\nrounder corners" }),
      pinWith({ id: "pin-b", order: 2, selector: ".other-card", annotation: "" }),
    ]),
  );

  const res = await dispatch<{ board: Board }>({ type: "board/markReady", boardId: BOARD_ID });
  assert.equal(res.ok, true);

  const frozen = readBoardFromMemory(BOARD_ID);
  assert.equal(frozen.status, "ready");
  const [a, b] = frozen.pins;
  /* Both pins carry the same run, each wearing its own words for it. */
  assert.equal(a.liveSends.length, 1);
  assert.equal(a.liveSends[0].messageId, "push-1");
  assert.equal(a.liveSends[0].state, "starting");
  assert.equal(a.liveSends[0].text, "make it green · rounder corners");
  assert.equal(a.liveSends[0].head, "H1");
  assert.equal(b.liveSends[0].messageId, "push-1");
  /* No annotation of its own — the board's one instruction stands in. */
  assert.equal(b.liveSends[0].text, "Polish the cards");
});

test("a clipboard push records nothing — there is no run to track", async () => {
  pushResult = { messageId: "", boardDir: "/tmp/board", pointer: "Load board", transport: "clipboard" };
  install(boardWith([pinWith({ id: "pin-a", annotation: "make it green" })]));

  const res = await dispatch<{ board: Board }>({ type: "board/markReady", boardId: BOARD_ID });
  assert.equal(res.ok, true);
  assert.equal(readBoardFromMemory(BOARD_ID).pins[0].liveSends.length, 0);
});

test("the push outcome lands on the frozen board and mints one key for all", async () => {
  head = "H1";
  pushResult = {
    messageId: "push-1",
    boardDir: "/tmp/board",
    pointer: "Load board",
    transport: "cursor",
    state: "starting",
  };
  install(
    boardWith([
      pinWith({ id: "pin-a", annotation: "make it green" }),
      pinWith({ id: "pin-b", order: 2, selector: ".other-card", annotation: "smaller" }),
    ]),
  );
  await dispatch({ type: "board/markReady", boardId: BOARD_ID });

  /* Submission froze the board; the next active board is a different one.
     The outcome must find the board that holds the message, not whichever
     board the pointer moved to. */
  const outcome = await dispatch({
    type: "agent/recordOutcome",
    messageId: "push-1",
    state: "done",
  });
  assert.equal(outcome.ok, true);

  const frozen = readBoardFromMemory(BOARD_ID);
  for (const pin of frozen.pins) {
    assert.equal(pin.liveSends[0].state, "done");
    assert.equal(pin.liveSends[0].versionNo, 2, `${pin.id} wears the run's key`);
    assert.equal(pin.currentVersionNo, 2);
    assert.deepEqual(
      pin.versions.map((v) => [v.no, v.messageId, v.head]),
      [
        [1, null, "H1"],
        [2, "push-1", "H1"],
      ],
      `${pin.id} minted the same key from the same run`,
    );
  }
});

/* ---------------------------------------------------------- inheritance */

test("a new pin inherits its component's conversation from the frozen board", async () => {
  /* Continues from the previous test's state: board-ch1 is ready and its
     pins carry push-1 done with key 2. Clicking the same component now
     creates a pin on a fresh draft board. */
  /* Submission disarmed capture; the user turns it back on to keep going. */
  (memory.state as { captureMode: boolean }).captureMode = true;
  const res = await dispatch<{ pin: Pin }>(
    { type: "capture/element", element: capturedElement() },
    { tab: TAB as chrome.tabs.Tab },
  );
  assert.equal(res.ok, true, res.ok ? undefined : res.error);
  if (!res.ok) return;
  const pin = res.data.pin;

  assert.notEqual(pin.boardId, BOARD_ID, "the pin lives on the new draft board");
  assert.equal(pin.liveSends.length, 1);
  assert.equal(pin.liveSends[0].messageId, "push-1");
  assert.equal(pin.liveSends[0].versionNo, 2);
  assert.deepEqual(
    pin.versions.map((v) => [v.no, v.messageId]),
    [
      [1, null],
      [2, "push-1"],
    ],
  );
  /* The ring keeps counting — numerals must not collide with inherited keys. */
  assert.equal(pin.versionSeq, 2);
  assert.equal(pin.currentVersionNo, 2);
  /* Staged notes are the old board's work list, not the component's record —
     carrying them would quietly resubmit last board's instructions. */
  assert.equal(pin.annotation, "");
});

test("recapturing on the same board reuses the pin instead of inheriting twice", async () => {
  const before = readBoardFromMemory(activeBoardId());
  const count = before.pins.length;
  /* Submission disarmed capture; the user turns it back on to keep going. */
  (memory.state as { captureMode: boolean }).captureMode = true;
  const res = await dispatch<{ pin: Pin }>(
    { type: "capture/element", element: capturedElement() },
    { tab: TAB as chrome.tabs.Tab },
  );
  assert.equal(res.ok, true);
  const after = readBoardFromMemory(activeBoardId());
  assert.equal(after.pins.length, count, "no duplicate pin");
});

test("a different component inherits nothing", async () => {
  (memory.state as { captureMode: boolean }).captureMode = true;
  const res = await dispatch<{ pin: Pin }>(
    {
      type: "capture/element",
      element: capturedElement({ selector: ".unrelated", domPath: "body > .unrelated" }),
    },
    { tab: TAB as chrome.tabs.Tab },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.pin.liveSends.length, 0);
  assert.equal(res.data.pin.versions.length, 0);
  assert.equal(res.data.pin.versionSeq, 0);
});

test("a grouped ancestor keeps its conversation to its group", async () => {
  install(
    boardWith([pinWith({ id: "pin-g", groupId: "group-1", liveSends: [], versionSeq: 3 })]),
  );
  /* Freeze it so the next capture must look back rather than reuse. */
  pushResult = { messageId: "", boardDir: "/tmp", pointer: "p", transport: "clipboard" };
  await dispatch({ type: "board/markReady", boardId: BOARD_ID });

  /* Submission disarmed capture; the user turns it back on to keep going. */
  (memory.state as { captureMode: boolean }).captureMode = true;
  const res = await dispatch<{ pin: Pin }>(
    { type: "capture/element", element: capturedElement() },
    { tab: TAB as chrome.tabs.Tab },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.pin.versionSeq, 0, "grouped pins are not ancestors");
});

/* ------------------------------------------------------- the live stamp */

test("a live send is stamped with the chapter it was written in", async () => {
  head = "H9";
  install(boardWith([pinWith({ id: "pin-live" })]));
  const res = await dispatch<{ messageId: string }>({
    type: "agent/send",
    text: "make it rose",
    pinIds: ["pin-live"],
  });
  assert.equal(res.ok, true);
  const sent = readBoardFromMemory(BOARD_ID).pins[0].liveSends[0];
  assert.equal(sent.head, "H9");
});

test("after the chapter moves, the next done restarts at 1 and 2, not 4", async () => {
  head = "H2";
  install(
    boardWith([
      pinWith({
        versionSeq: 3,
        currentVersionNo: 3,
        versions: [
          {
            no: 1,
            messageId: null,
            label: "original",
            at: "2026-08-14T00:00:00.000Z",
            screenshotKey: null,
            head: "H1",
          },
          {
            no: 2,
            messageId: "old-2",
            label: "old take",
            at: "2026-08-14T00:00:01.000Z",
            screenshotKey: null,
            head: "H1",
          },
          {
            no: 3,
            messageId: "old-3",
            label: "later",
            at: "2026-08-14T00:00:02.000Z",
            screenshotKey: null,
            head: "H1",
          },
        ],
        liveSends: [
          {
            text: "new chapter take",
            at: "2026-08-14T00:01:00.000Z",
            messageId: "new-1",
            state: "working",
            versionNo: null,
            head: "H2",
          },
        ],
      }),
    ]),
  );

  const res = await dispatch({ type: "agent/recordOutcome", messageId: "new-1", state: "done" });
  assert.equal(res.ok, true);

  const pin = readBoardFromMemory(BOARD_ID).pins[0];
  assert.equal(pin.versionSeq, 2, "must not keep climbing to 4 after a chapter reset");
  assert.equal(pin.currentVersionNo, 2);
  assert.deepEqual(
    pin.versions.filter((v) => v.head === "H1").map((v) => v.no),
    [1, 2, 3],
    "stale-chapter keys stay stored",
  );
  assert.deepEqual(
    pin.versions.filter((v) => v.head === "H2").map((v) => [v.no, v.messageId]),
    [
      [1, null],
      [2, "new-1"],
    ],
  );
  assert.equal(pin.liveSends[0].versionNo, 2);
});
