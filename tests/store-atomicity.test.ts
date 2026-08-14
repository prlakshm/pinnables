import assert from "node:assert/strict";
import test from "node:test";

import type { Board } from "../packages/shared/src/schema.ts";
import type { ExtensionState } from "../packages/extension/src/lib/messages.ts";

let memory: Record<string, unknown> = {};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
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
  },
});

const { ensureActiveBoard, patchState } = await import(
  "../packages/extension/src/lib/store.ts"
);

test("concurrent state patches merge instead of overwriting each other", async () => {
  // One base object, spread into both the fixture and the expectation: the
  // test is about merge semantics, and must not fail every time a new field
  // joins ExtensionState.
  const base = {
    captureMode: false,
    activeBoardId: null,
    serviceOnline: false,
    versionsOk: false,
    projectHead: null,
    cursorOnline: false,
    cursorAgentUrl: null,
    cursorRuntime: null,
    cursorProjectDir: null,
  } satisfies ExtensionState;
  memory = { state: { ...base } };

  await Promise.all([
    patchState({ captureMode: true }),
    patchState({ activeBoardId: "board-concurrent" }),
  ]);

  assert.deepEqual(memory.state, {
    ...base,
    captureMode: true,
    activeBoardId: "board-concurrent",
  });
});

test("concurrent first-open requests share one active board", async () => {
  memory = {};
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => ++now;

  try {
    const [first, second] = await Promise.all([
      ensureActiveBoard(),
      ensureActiveBoard(),
    ]);

    assert.equal(first.id, second.id);
    assert.deepEqual(memory.boardIds, [first.id]);
    assert.equal((memory.state as ExtensionState).activeBoardId, first.id);
    assert.deepEqual(
      Object.keys(memory).filter((key) => key.startsWith("board:")),
      [`board:${first.id}`],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("reopening after submission replaces a ready active board with one shared draft", async () => {
  const submitted: Board = {
    id: "board-submitted",
    schemaVersion: 1,
    projectId: "local",
    title: "Submitted board",
    globalInstruction: "",
    status: "ready",
    generatedAt: "2026-08-08T12:00:00.000Z",
    createdAt: "2026-08-08T11:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    pins: [],
    relationships: [],
  };
  memory = {
    state: {
      captureMode: false,
      activeBoardId: submitted.id,
      serviceOnline: true,
      cursorOnline: false,
    } satisfies ExtensionState,
    boardIds: [submitted.id],
    [`board:${submitted.id}`]: submitted,
  };

  const [first, second] = await Promise.all([ensureActiveBoard(), ensureActiveBoard()]);

  assert.equal(first.id, second.id);
  assert.notEqual(first.id, submitted.id);
  assert.equal(first.status, "draft");
  assert.equal((memory.state as ExtensionState).activeBoardId, first.id);
  assert.deepEqual(memory.boardIds, [submitted.id, first.id]);
  assert.deepEqual(memory[`board:${submitted.id}`], submitted);
});
