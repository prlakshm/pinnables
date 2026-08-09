import assert from "node:assert/strict";
import test from "node:test";

import type { Board, Pin } from "@pinnables/shared";

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
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BOARD_ID = "board-storage-cleanup";
const BOARD_KEY = `board:${BOARD_ID}`;

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
    id: "storage-cleanup-test",
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
    url: "https://example.test/dashboard",
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
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function board(pins: Pin[]): Board {
  return {
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Storage cleanup",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins,
    relationships: [],
  };
}

function installBoard(next: Board): void {
  memory = {
    boardIds: [BOARD_ID],
    [BOARD_KEY]: structuredClone(next),
  };
  for (const pin of next.pins) {
    memory[`shot:${pin.id}`] = `full:${pin.id}`;
    memory[`thumb:${pin.id}`] = `thumb:${pin.id}`;
    memory[`pos:${pin.id}`] = { x: pin.order * 10, y: pin.order * 20 };
  }
}

function assertPinStoragePresent(pinId: string): void {
  assert.equal(memory[`shot:${pinId}`], `full:${pinId}`);
  assert.equal(memory[`thumb:${pinId}`], `thumb:${pinId}`);
  assert.deepEqual(memory[`pos:${pinId}`], {
    x: (memory[BOARD_KEY] as Board).pins.find((pin) => pin.id === pinId)!.order * 10,
    y: (memory[BOARD_KEY] as Board).pins.find((pin) => pin.id === pinId)!.order * 20,
  });
}

function assertPinStorageRemoved(pinId: string): void {
  assert.equal(memory[`shot:${pinId}`], undefined);
  assert.equal(memory[`thumb:${pinId}`], undefined);
  assert.equal(memory[`pos:${pinId}`], undefined);
}

async function dispatch<T>(message: Record<string, unknown>): Promise<WireResponse<T>> {
  assert.ok(backgroundListener, "background message listener was registered");
  return new Promise<WireResponse<T>>((resolve) => {
    const keepAlive = backgroundListener!(message, {}, (response) => {
      resolve(response as WireResponse<T>);
    });
    assert.equal(keepAlive, true);
  });
}

async function holdBoardMutation(): Promise<{
  release: Deferred<void>;
  mutation: Promise<Board>;
}> {
  const entered = deferred<void>();
  const release = deferred<void>();
  const mutation = mutateBoard(BOARD_ID, async (current) => {
    entered.resolve();
    await release.promise;
    return current;
  });
  await entered.promise;
  return { release, mutation };
}

async function letHandlerReachBoardQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("pin deletion keeps saved storage until its queued board mutation resolves", async () => {
  const removed = elementPin("pin-removed", 1);
  const survivor = elementPin("pin-survivor", 2);
  installBoard(board([removed, survivor]));
  const held = await holdBoardMutation();

  const deletion = dispatch<{ board: Board }>({ type: "pin/delete", pinId: removed.id });
  await letHandlerReachBoardQueue();

  assertPinStoragePresent(removed.id);

  held.release.resolve();
  const [response] = await Promise.all([deletion, held.mutation]);

  assert.equal(response.ok, true);
  assertPinStorageRemoved(removed.id);
  assertPinStoragePresent(survivor.id);
});

test("board clear keeps every pin's saved storage until its queued mutation resolves", async () => {
  const first = elementPin("pin-first", 1);
  const second = elementPin("pin-second", 2);
  installBoard(board([first, second]));
  const held = await holdBoardMutation();

  const clearing = dispatch<{ board: Board }>({ type: "board/clear", boardId: BOARD_ID });
  await letHandlerReachBoardQueue();

  assertPinStoragePresent(first.id);
  assertPinStoragePresent(second.id);

  held.release.resolve();
  const [response] = await Promise.all([clearing, held.mutation]);

  assert.equal(response.ok, true);
  assertPinStorageRemoved(first.id);
  assertPinStorageRemoved(second.id);
});
