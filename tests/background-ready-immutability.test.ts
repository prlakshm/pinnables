import assert from "node:assert/strict";
import test from "node:test";

import type { Board, Pin, Relationship } from "@pinnables/shared";

type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

type WireResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const BOARD_ID = "board-ready-immutability";
const BOARD_KEY = `board:${BOARD_ID}`;
const READY_AT = "2026-08-08T12:00:00.000Z";
const TAB = { id: 17, windowId: 3, url: "https://example.test/dashboard" };

let memory: Record<string, unknown> = {};
let backgroundListener: BackgroundListener | null = null;

const chromeStub = {
  storage: {
    local: {
      async get(key: string) {
        return { [key]: structuredClone(memory[key]) };
      },
      async set(entries: Record<string, unknown>) {
        Object.assign(memory, structuredClone(entries));
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key];
      },
    },
  },
  runtime: {
    id: "ready-immutability-test",
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
    query: async () => [TAB],
    sendMessage: async () => undefined,
    update: async () => TAB,
    get: async () => TAB,
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
const { mutateBoard } = await import("../packages/extension/src/lib/store.ts");

function elementPin(id: string, order: number): Pin {
  return {
    id,
    schemaVersion: 1,
    boardId: BOARD_ID,
    kind: "element",
    drawings: [],
    order,
    groupId: null,
    url: TAB.url,
    route: "/dashboard",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 240, height: 120 },
    screenshotPath: `pins/${id}.png`,
    thumbnailPath: `pins/${id}.thumb.webp`,
    selector: `[data-pin="${id}"]`,
    domPath: `body > [data-pin="${id}"]`,
    outerHtml: `<div data-pin="${id}"></div>`,
    classList: ["card"],
    elementText: id,
    componentName: "Card",
    name: null,
    sourceFile: null,
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

const firstPin = elementPin("pin-first", 1);
const secondPin = elementPin("pin-second", 2);
const thirdPin = elementPin("pin-third", 3);

const existingRelationship: Relationship = {
  id: "rel-existing",
  boardId: BOARD_ID,
  type: "match",
  sourcePinId: firstPin.id,
  targetPinIds: [secondPin.id],
  properties: [],
  exception: "",
  instruction: "",
};

function draftBoard(): Board {
  return {
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Ready immutability",
    globalInstruction: "Original instruction",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [firstPin, secondPin, thirdPin],
    relationships: [existingRelationship],
  };
}

function installBoard(board: Board): void {
  memory = {
    state: { captureMode: false, activeBoardId: BOARD_ID, serviceOnline: false, cursorOnline: false },
    boardIds: [BOARD_ID],
    [BOARD_KEY]: structuredClone(board),
  };
  for (const pin of board.pins) {
    memory[`shot:${pin.id}`] = `full:${pin.id}`;
    memory[`thumb:${pin.id}`] = `thumb:${pin.id}`;
    memory[`pos:${pin.id}`] = { x: pin.order * 10, y: pin.order * 20 };
  }
}

function storedBoard(): Board {
  return memory[BOARD_KEY] as Board;
}

function withoutUpdatedAt(board: Board): Omit<Board, "updatedAt"> {
  const { updatedAt: _updatedAt, ...rest } = board;
  return rest;
}

async function dispatch<T>(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender = {},
): Promise<WireResponse<T>> {
  assert.ok(backgroundListener, "background message listener was registered");
  return new Promise<WireResponse<T>>((resolve) => {
    const keepAlive = backgroundListener!(message, sender, (response) => {
      resolve(response as WireResponse<T>);
    });
    assert.equal(keepAlive, true);
  });
}

async function holdSubmission(): Promise<{
  release: Deferred<void>;
  mutation: Promise<Board>;
}> {
  const entered = deferred<void>();
  const release = deferred<void>();
  const mutation = mutateBoard(BOARD_ID, async (current) => {
    entered.resolve();
    await release.promise;
    return { ...current, status: "ready", generatedAt: READY_AT };
  });
  await entered.promise;
  return { release, mutation };
}

async function letHandlerReachBoardQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const lateMutations: Array<{
  name: string;
  message: Record<string, unknown>;
  sender?: chrome.runtime.MessageSender;
}> = [
  {
    name: "instruction update",
    message: { type: "board/setInstruction", boardId: BOARD_ID, instruction: "Late instruction" },
  },
  {
    name: "pin update",
    message: { type: "pin/update", pinId: firstPin.id, patch: { annotation: "Late note" } },
  },
  {
    name: "pin deletion",
    message: { type: "pin/delete", pinId: firstPin.id },
  },
  {
    name: "pin reorder",
    message: { type: "pin/reorder", pinId: thirdPin.id, beforePinId: firstPin.id },
  },
  {
    name: "relationship creation",
    message: {
      type: "relationship/create",
      sourcePinId: secondPin.id,
      targetPinIds: [thirdPin.id],
    },
  },
  {
    name: "relationship update",
    message: {
      type: "relationship/update",
      relationshipId: existingRelationship.id,
      patch: { instruction: "Late relationship note" },
    },
  },
  {
    name: "relationship deletion",
    message: { type: "relationship/delete", relationshipId: existingRelationship.id },
  },
  {
    name: "drawing save",
    message: {
      type: "drawing/save",
      shapes: [
        {
          id: "shape-late",
          kind: "rect",
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.5 },
          ],
          color: "#ff0000",
          anchor: null,
        },
      ],
      url: TAB.url,
      route: "/dashboard",
      viewport: { width: 1280, height: 800 },
      shotRect: null,
    },
    sender: { tab: TAB as chrome.tabs.Tab },
  },
  {
    name: "board clear",
    message: { type: "board/clear", boardId: BOARD_ID },
  },
];

test("late queued mutations cannot alter a board after submission makes it ready", async (t) => {
  for (const scenario of lateMutations) {
    await t.test(scenario.name, async () => {
      const original = draftBoard();
      installBoard(original);
      const submitted = await holdSubmission();

      const responsePromise = dispatch(scenario.message, scenario.sender);
      await letHandlerReachBoardQueue();
      submitted.release.resolve();
      const [response] = await Promise.all([responsePromise, submitted.mutation]);

      assert.equal(response.ok, false);
      if (!response.ok) assert.match(response.error, /draft/i);
      assert.deepEqual(
        withoutUpdatedAt(storedBoard()),
        withoutUpdatedAt({ ...original, status: "ready", generatedAt: READY_AT }),
      );
      for (const pin of original.pins) {
        assert.equal(memory[`shot:${pin.id}`], `full:${pin.id}`);
        assert.equal(memory[`thumb:${pin.id}`], `thumb:${pin.id}`);
        assert.deepEqual(memory[`pos:${pin.id}`], { x: pin.order * 10, y: pin.order * 20 });
      }
    });
  }
});
