import assert from "node:assert/strict";
import test from "node:test";

import type { Board, Pin } from "@pinnables/shared";
import type { CapturedElement } from "../packages/extension/src/lib/messages.ts";

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

const BOARD_ID = "board-capture-integrity";
const BOARD_KEY = `board:${BOARD_ID}`;
const FRAME_URL = "data:image/png;base64,frame";
const TAB = { id: 17, windowId: 3, url: "https://example.test/dashboard" };

let memory: Record<string, unknown> = {};
let backgroundListener: BackgroundListener | null = null;
let captureGate: Deferred<string> | null = null;
let captureStarted = deferred<void>();
let captureVisibleTabCalls = 0;
let materializedBoards: Board[] = [];

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
    id: "capture-integrity-test",
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
    captureVisibleTab: async () => {
      captureVisibleTabCalls += 1;
      captureStarted.resolve();
      return captureGate ? captureGate.promise : FRAME_URL;
    },
    update: async () => TAB,
    get: async () => TAB,
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

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("data:")) {
      return { blob: async () => ({}) } as Response;
    }
    if (url.endsWith("/health")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          home: "/tmp",
          cursor: { configured: false, ok: false, detail: "CURSOR_API_KEY not set" },
        }),
      } as Response;
    }
    if (url.includes("/push") || url.includes("/materialize")) {
      const payload = JSON.parse(String(init?.body)) as { board: Board };
      materializedBoards.push(structuredClone(payload.board));
      return {
        ok: true,
        json: async () => ({
          pointer: "test",
          boardDir: "/tmp/test-board",
          messageId: "",
          transport: "clipboard",
        }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
});

await import("../packages/extension/src/background/index.ts");

function board(status: Board["status"] = "draft", pins: Pin[] = []): Board {
  return {
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Capture integrity",
    globalInstruction: "",
    status,
    generatedAt: status === "draft" ? null : "2026-08-08T00:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins,
    relationships: [],
  };
}

function element(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    rect: { x: 20, y: 30, width: 240, height: 120 },
    devicePixelRatio: 1,
    url: TAB.url,
    route: "/dashboard",
    viewport: { width: 1280, height: 800 },
    selector: "#capture-target",
    domPath: "body > #capture-target",
    outerHtml: '<section id="capture-target">Target</section>',
    classList: ["target"],
    elementText: "Target",
    componentName: "Target",
    sourceFile: null,
    computedStyles: { display: "block" },
    ...overrides,
  };
}

function installBoard(next: Board): void {
  captureGate = null;
  captureStarted = deferred<void>();
  captureVisibleTabCalls = 0;
  materializedBoards = [];
  memory = {
    state: { captureMode: true, activeBoardId: BOARD_ID, serviceOnline: false, cursorOnline: false },
    boardIds: [BOARD_ID],
    [BOARD_KEY]: structuredClone(next),
  };
}

function storedBoard(): Board {
  return memory[BOARD_KEY] as Board;
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

function dispatchCapture(captured = element()): Promise<WireResponse<{ pin: Pin }>> {
  return dispatch(
    { type: "capture/element", element: captured },
    { tab: TAB as chrome.tabs.Tab },
  );
}

test("a capture already photographing the page is ordered before a later board clear", async () => {
  installBoard(board());
  captureGate = deferred<string>();

  const captureResponse = dispatchCapture();
  await captureStarted.promise;
  const clearResponse = dispatch<{ board: Board }>({ type: "board/clear", boardId: BOARD_ID });

  captureGate.resolve(FRAME_URL);
  const [captureResult, clearResult] = await Promise.all([captureResponse, clearResponse]);

  assert.equal(captureResult.ok, true);
  assert.equal(clearResult.ok, true);
  assert.deepEqual(storedBoard().pins, []);
});

test("submission waits for an in-flight capture and materializes that queued pin", async () => {
  installBoard(board());
  captureGate = deferred<string>();

  const captureResponse = dispatchCapture();
  await captureStarted.promise;
  const readyResponse = dispatch<{ board: Board }>({ type: "board/markReady", boardId: BOARD_ID });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const materializedBeforeCaptureFinished = materializedBoards.length;
  captureGate.resolve(FRAME_URL);
  const [captureResult, readyResult] = await Promise.all([captureResponse, readyResponse]);

  assert.equal(captureResult.ok, true);
  assert.equal(readyResult.ok, true);
  assert.equal(materializedBeforeCaptureFinished, 0);
  assert.equal(materializedBoards.length, 1);
  assert.equal(materializedBoards[0]?.pins.length, 1);
  assert.equal(storedBoard().status, "ready");
  assert.equal(storedBoard().pins.length, 1);
  assert.equal((memory.state as { captureMode: boolean }).captureMode, false);
});

test("a capture after submission starts a fresh draft without mutating the ready board", async () => {
  installBoard(board("ready"));

  const response = await dispatchCapture();

  assert.equal(response.ok, true);
  assert.equal(captureVisibleTabCalls, 1);
  assert.deepEqual(storedBoard().pins, []);
  const activeBoardId = (memory.state as { activeBoardId: string }).activeBoardId;
  assert.notEqual(activeBoardId, BOARD_ID);
  const activeBoard = memory[`board:${activeBoardId}`] as Board;
  assert.equal(activeBoard.status, "draft");
  assert.equal(activeBoard.pins.length, 1);
});

test("a stale page request cannot capture after capture mode is disarmed", async () => {
  installBoard(board("ready"));
  (memory.state as { captureMode: boolean }).captureMode = false;

  const response = await dispatchCapture();

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /capture mode is off/i);
  assert.equal(captureVisibleTabCalls, 0);
  assert.deepEqual(memory.boardIds, [BOARD_ID]);
  assert.deepEqual(storedBoard().pins, []);
});

test("new captures and recaptures persist the visible frame inside the element", async () => {
  installBoard(board());

  const first = await dispatchCapture(
    element({
      rect: { x: -20, y: 10, width: 100, height: 60 },
      viewport: { width: 200, height: 100 },
    }),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.data.pin.screenshotFrame, { x: 20, y: 0, width: 80, height: 60 });

  const second = await dispatchCapture(
    element({
      rect: { x: 10, y: -15, width: 80, height: 100 },
      viewport: { width: 200, height: 100 },
    }),
  );

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.data.pin.id, first.data.pin.id);
  assert.deepEqual(second.data.pin.screenshotFrame, { x: 0, y: 15, width: 80, height: 85 });
  assert.equal(storedBoard().pins.length, 1);
  assert.deepEqual(storedBoard().pins[0]?.screenshotFrame, second.data.pin.screenshotFrame);
});
