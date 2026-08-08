import { SCHEMA_VERSION, type Board, type Pin, type Relationship } from "@pinnables/shared";
import type { ExtensionState } from "./messages";

/**
 * All board state lives in chrome.storage — never in service-worker memory.
 * MV3 terminates the worker whenever it goes idle, so anything held in a module
 * variable is gone without warning. The worker is a router; this is the store.
 */

const KEY_STATE = "state";
const KEY_BOARD_IDS = "boardIds";
const boardKey = (id: string) => `board:${id}`;
const shotKey = (pinId: string) => `shot:${pinId}`;
const thumbKey = (pinId: string) => `thumb:${pinId}`;

const DEFAULT_STATE: ExtensionState = {
  captureMode: false,
  activeBoardId: null,
  serviceOnline: false,
};

async function get<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.local.get(key);
  return bag[key] as T | undefined;
}

async function set(entries: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(entries);
}

export async function getState(): Promise<ExtensionState> {
  return { ...DEFAULT_STATE, ...((await get<Partial<ExtensionState>>(KEY_STATE)) ?? {}) };
}

export async function patchState(patch: Partial<ExtensionState>): Promise<ExtensionState> {
  const next = { ...(await getState()), ...patch };
  await set({ [KEY_STATE]: next });
  return next;
}

export async function listBoardIds(): Promise<string[]> {
  return (await get<string[]>(KEY_BOARD_IDS)) ?? [];
}

export async function readBoard(boardId: string): Promise<Board | null> {
  return (await get<Board>(boardKey(boardId))) ?? null;
}

export async function listBoards(): Promise<Board[]> {
  const ids = await listBoardIds();
  const boards = await Promise.all(ids.map(readBoard));
  return boards.filter((b): b is Board => b !== null);
}

export async function writeBoard(board: Board): Promise<Board> {
  const next: Board = { ...board, updatedAt: new Date().toISOString() };
  const ids = await listBoardIds();
  if (!ids.includes(next.id)) await set({ [KEY_BOARD_IDS]: [...ids, next.id] });
  await set({ [boardKey(next.id)]: next });
  return next;
}

export async function createBoard(title: string): Promise<Board> {
  const now = new Date().toISOString();
  const board: Board = {
    id: `board-${Date.now().toString(36)}`,
    schemaVersion: SCHEMA_VERSION,
    projectId: "local",
    title,
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: now,
    updatedAt: now,
    pins: [],
    relationships: [],
  };
  return writeBoard(board);
}

/** The active board, created on first use so the user never sees an empty state. */
export async function ensureActiveBoard(): Promise<Board> {
  const state = await getState();
  if (state.activeBoardId) {
    const existing = await readBoard(state.activeBoardId);
    if (existing) return existing;
  }
  const board = await createBoard("Untitled board");
  await patchState({ activeBoardId: board.id });
  return board;
}

/**
 * One read-modify-write chain per board.
 *
 * Chrome can deliver several extension messages while earlier handlers are
 * awaiting storage. Without a queue, two handlers read the same board and the
 * last whole-board write silently erases the other change — an annotation can
 * resurrect a deleted pin, or a blur-save can disappear from the submitted
 * brief. The service worker remains alive while the message promises are
 * pending, so an in-memory chain is sufficient to serialize overlapping work
 * in this worker instance.
 */
const boardMutationQueues = new Map<string, Promise<void>>();

export async function mutateBoard(
  boardId: string,
  mutate: (board: Board) => Board | Promise<Board>,
): Promise<Board> {
  const previous = boardMutationQueues.get(boardId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const board = await readBoard(boardId);
    if (!board) throw new Error(`No board "${boardId}"`);
    return writeBoard(await mutate(board));
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  boardMutationQueues.set(boardId, tail);
  try {
    return await operation;
  } finally {
    if (boardMutationQueues.get(boardId) === tail) boardMutationQueues.delete(boardId);
  }
}

/** Find whichever board holds a pin — the panel only ever sends pin ids. */
export async function boardForPin(pinId: string): Promise<Board> {
  for (const board of await listBoards()) {
    if (board.pins.some((p) => p.id === pinId)) return board;
  }
  throw new Error(`No board contains pin "${pinId}"`);
}

export async function boardForRelationship(relationshipId: string): Promise<Board> {
  for (const board of await listBoards()) {
    if (board.relationships.some((r) => r.id === relationshipId)) return board;
  }
  throw new Error(`No board contains relationship "${relationshipId}"`);
}

/* ------------------------------------------------------------- screenshots */

export async function putScreenshot(pinId: string, full: string, thumb: string): Promise<void> {
  await set({ [shotKey(pinId)]: full, [thumbKey(pinId)]: thumb });
}

export async function getScreenshot(pinId: string): Promise<string | undefined> {
  return get<string>(shotKey(pinId));
}

export async function getThumbnail(pinId: string): Promise<string | undefined> {
  return get<string>(thumbKey(pinId));
}

export async function dropScreenshot(pinId: string): Promise<void> {
  await chrome.storage.local.remove([shotKey(pinId), thumbKey(pinId)]);
}

/* -------------------------------------------------------------- id helpers */

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Fractional index between two neighbours, so reordering rewrites one pin
 * instead of renumbering the whole board.
 */
export function orderBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

export function sortedPins(board: Board): Pin[] {
  return [...board.pins].sort((a, b) => a.order - b.order);
}

export function relationshipsForPin(board: Board, pinId: string): Relationship[] {
  return board.relationships.filter(
    (r) => r.sourcePinId === pinId || r.targetPinIds.includes(pinId),
  );
}
