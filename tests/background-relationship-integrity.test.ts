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

const BOARD_ID = "board-relationship-integrity";
const BOARD_KEY = `board:${BOARD_ID}`;
let memory: Record<string, unknown> = {};
let afterNextBoardRead: (() => void) | null = null;
let backgroundListener: BackgroundListener | null = null;

const chromeStub = {
  storage: {
    local: {
      async get(key: string) {
        const snapshot = structuredClone(memory[key]);
        if (key === BOARD_KEY && afterNextBoardRead) {
          const hook = afterNextBoardRead;
          afterNextBoardRead = null;
          hook();
        }
        return { [key]: snapshot };
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
    id: "relationship-integrity-test",
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

(globalThis as typeof globalThis & { chrome: typeof chrome }).chrome =
  chromeStub as unknown as typeof chrome;

await import("../packages/extension/src/background/index.ts");

function elementPin(id: string, order: number): Pin {
  return {
    id,
    schemaVersion: 1,
    boardId: BOARD_ID,
    kind: "element",
    drawings: [],
    order,
    groupId: null,
    url: "http://localhost:5180/dashboard",
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

const sourcePin = elementPin("pin-source", 1);
const targetPin = elementPin("pin-target", 2);
const otherSourcePin = elementPin("pin-other-source", 3);

function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "rel-existing",
    boardId: BOARD_ID,
    type: "match",
    sourcePinId: sourcePin.id,
    targetPinIds: [targetPin.id],
    properties: [],
    exception: "",
    instruction: "",
    ...overrides,
  };
}

function board(relationships: Relationship[] = []): Board {
  return {
    id: BOARD_ID,
    schemaVersion: 1,
    projectId: "local",
    title: "Relationship integrity",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [sourcePin, targetPin, otherSourcePin],
    relationships,
  };
}

function installBoard(next: Board): void {
  afterNextBoardRead = null;
  memory = {
    boardIds: [BOARD_ID],
    [BOARD_KEY]: structuredClone(next),
  };
}

function storedBoard(): Board {
  return memory[BOARD_KEY] as Board;
}

async function dispatch<T>(message: Record<string, unknown>): Promise<WireResponse<T>> {
  assert.ok(backgroundListener, "background message listener was registered");
  return new Promise<WireResponse<T>>((resolve) => {
    const keepAlive = backgroundListener!(
      message,
      {} as chrome.runtime.MessageSender,
      (response) => resolve(response as WireResponse<T>),
    );
    assert.equal(keepAlive, true);
  });
}

test("relationship creation rejects a source removed before its queued commit", async () => {
  installBoard(board());
  afterNextBoardRead = () => {
    memory[BOARD_KEY] = {
      ...storedBoard(),
      pins: storedBoard().pins.filter((pin) => pin.id !== sourcePin.id),
    };
  };

  const response = await dispatch({
    type: "relationship/create",
    sourcePinId: sourcePin.id,
    targetPinIds: [targetPin.id],
  });

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /source/i);
  assert.deepEqual(storedBoard().relationships, []);
});

test("relationship creation rejects a target removed before its queued commit", async () => {
  installBoard(board());
  afterNextBoardRead = () => {
    memory[BOARD_KEY] = {
      ...storedBoard(),
      pins: storedBoard().pins.filter((pin) => pin.id !== targetPin.id),
    };
  };

  const response = await dispatch({
    type: "relationship/create",
    sourcePinId: sourcePin.id,
    targetPinIds: [targetPin.id],
  });

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /target/i);
  assert.deepEqual(storedBoard().relationships, []);
});

test("simultaneous identical relationship creates return one shared card", async () => {
  installBoard(board());
  const request = {
    type: "relationship/create",
    sourcePinId: sourcePin.id,
    targetPinIds: [targetPin.id],
  };

  const [first, second] = await Promise.all([
    dispatch<{ board: Board; relationship: Relationship }>(request),
    dispatch<{ board: Board; relationship: Relationship }>(request),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.data.relationship.id, second.data.relationship.id);
  assert.equal(storedBoard().relationships.length, 1);
});

test("relationship update rejects a relationship removed before its queued commit", async () => {
  const existing = relationship();
  installBoard(board([existing]));
  afterNextBoardRead = () => {
    memory[BOARD_KEY] = { ...storedBoard(), relationships: [] };
  };

  const response = await dispatch({
    type: "relationship/update",
    relationshipId: existing.id,
    patch: { properties: ["spacing"] },
  });

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /relationship/i);
  assert.deepEqual(storedBoard().relationships, []);
});

test("relationship target updates reject missing pins", async () => {
  const existing = relationship();
  installBoard(board([existing]));

  const response = await dispatch({
    type: "relationship/update",
    relationshipId: existing.id,
    patch: { targetPinIds: ["pin-missing"] },
  });

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /target/i);
  assert.deepEqual(storedBoard().relationships[0]?.targetPinIds, [targetPin.id]);
});

test("relationship updates reject a raw property claimed through a group on the same target", async () => {
  const grouped = relationship({ id: "rel-grouped", properties: ["spacing"] });
  const candidate = relationship({
    id: "rel-candidate",
    sourcePinId: otherSourcePin.id,
  });
  installBoard(board([grouped, candidate]));

  const response = await dispatch({
    type: "relationship/update",
    relationshipId: candidate.id,
    patch: { properties: ["padding-top"] },
  });

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /padding-top|conflict/i);
  assert.deepEqual(storedBoard().relationships[1]?.properties, []);
});

test("relationships sharing a target may select disjoint raw properties", async () => {
  const padding = relationship({ id: "rel-padding", properties: ["padding-top"] });
  const candidate = relationship({
    id: "rel-candidate",
    sourcePinId: otherSourcePin.id,
  });
  installBoard(board([padding, candidate]));

  const response = await dispatch<{ board: Board }>({
    type: "relationship/update",
    relationshipId: candidate.id,
    patch: { properties: ["margin-top"] },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(storedBoard().relationships[1]?.properties, ["margin-top"]);
});
