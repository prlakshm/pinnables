import assert from "node:assert/strict";
import test from "node:test";

import type { Board } from "@pinnables/shared";
import * as store from "../packages/extension/src/lib/store.ts";

test("overlapping board mutations are serialized instead of losing one update", async () => {
  const board: Board = {
    id: "board-race",
    schemaVersion: 1,
    projectId: "local",
    title: "Before",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins: [],
    relationships: [],
  };
  const memory: Record<string, unknown> = {
    boardIds: [board.id],
    [`board:${board.id}`]: board,
  };

  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => {
          const snapshot = structuredClone(memory[key]);
          return Promise.resolve({ [key]: snapshot });
        },
        set: async (entries: Record<string, unknown>) => {
          await Promise.resolve();
          Object.assign(memory, structuredClone(entries));
        },
        remove: async () => {},
      },
    },
  };

  await Promise.all([
    store.mutateBoard(board.id, (current) => ({ ...current, title: "After" })),
    store.mutateBoard(board.id, (current) => ({
      ...current,
      globalInstruction: "Keep both updates",
    })),
  ]);

  const result = memory[`board:${board.id}`] as Board;
  assert.equal(result.title, "After");
  assert.equal(result.globalInstruction, "Keep both updates");
});
