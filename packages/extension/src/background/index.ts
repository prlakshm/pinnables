import {
  SCHEMA_VERSION,
  drawingsBounds,
  pathFor,
  strokeWidthFor,
  type Board,
  type DrawShape,
  type Pin,
} from "@pinnables/shared";
import {
  broadcastToTab,
  type Broadcast,
  type Contract,
  type Message,
  type RequestType,
} from "../lib/messages";
import * as store from "../lib/store";
import { isServiceOnline, materializeBoard } from "../lib/service";

/**
 * Stateless router. Every handler reads from and writes to chrome.storage —
 * nothing is cached in a module variable, because MV3 will terminate this
 * worker between any two messages.
 */

/* ------------------------------------------------------------- screenshots */

const THUMB_WIDTH = 320;

async function crop(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): Promise<{ full: string; thumb: string }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

  // captureVisibleTab returns the viewport at device pixel ratio; the rect is
  // CSS pixels relative to that same viewport. Elements taller than the fold
  // are clipped rather than stitched — stitching costs two captures/second and
  // would break "adding a pin feels instantaneous".
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * dpr)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * dpr)));

  const full = new OffscreenCanvas(sw, sh);
  full.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const scale = Math.min(1, THUMB_WIDTH / sw);
  const thumb = new OffscreenCanvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
  thumb.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, thumb.width, thumb.height);
  bitmap.close();

  return {
    full: await encodeCanvas(full, "image/png"),
    thumb: await encodeCanvas(thumb, "image/webp", 0.75),
  };
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  type: string,
  quality?: number,
): Promise<string> {
  const blob = await canvas.convertToBlob({ type, quality });
  return await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** Padding around the marks, as a fraction of the frame. A circled thing with
 *  nothing around it loses the context that made it worth circling. */
const REGION_PAD = 0.12;

/**
 * Crop the frozen frame to the marks, then stroke the marks onto it. Shapes
 * come in normalised against the whole frame and are re-normalised into the
 * crop, so the stored shapes always match the stored image.
 */
async function compositeRegion(
  frame: string,
  shapes: DrawShape[],
): Promise<{ full: string; thumb: string; shapes: DrawShape[] }> {
  const bitmap = await createImageBitmap(await (await fetch(frame)).blob());
  const bounds = drawingsBounds(shapes) ?? { x: 0, y: 0, width: 1, height: 1 };

  const nx = Math.max(0, bounds.x - REGION_PAD);
  const ny = Math.max(0, bounds.y - REGION_PAD);
  const nw = Math.min(1 - nx, bounds.width + REGION_PAD * 2);
  const nh = Math.min(1 - ny, bounds.height + REGION_PAD * 2);

  const sx = Math.round(nx * bitmap.width);
  const sy = Math.round(ny * bitmap.height);
  const sw = Math.max(1, Math.round(nw * bitmap.width));
  const sh = Math.max(1, Math.round(nh * bitmap.height));

  const rebased: DrawShape[] = shapes.map((shape) => ({
    ...shape,
    points: shape.points.map((p) => ({
      x: (p.x - nx) / nw,
      y: (p.y - ny) / nh,
    })),
  }));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = strokeWidthFor(sw);
  for (const shape of rebased) {
    const d = pathFor(shape, sw, sh);
    if (!d) continue;
    ctx.strokeStyle = shape.color;
    ctx.stroke(new Path2D(d));
  }

  const scale = Math.min(1, THUMB_WIDTH / sw);
  const thumbCanvas = new OffscreenCanvas(
    Math.max(1, Math.round(sw * scale)),
    Math.max(1, Math.round(sh * scale)),
  );
  thumbCanvas
    .getContext("2d")!
    .drawImage(canvas, 0, 0, sw, sh, 0, 0, thumbCanvas.width, thumbCanvas.height);

  return {
    full: await encodeCanvas(canvas, "image/png"),
    thumb: await encodeCanvas(thumbCanvas, "image/webp", 0.75),
    shapes: rebased,
  };
}

const freezeKey = (tabId: number) => `freeze:${tabId}`;

/* ---------------------------------------------------------------- handlers */

type Handlers = {
  [K in RequestType]: (
    req: Contract[K]["req"],
    sender: chrome.runtime.MessageSender,
  ) => Promise<Contract[K]["res"]>;
};

async function notifyBoardChanged(boardId: string): Promise<void> {
  const message: Broadcast = { kind: "board-updated", boardId };
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id) broadcastToTab(tab.id, message);
}

/**
 * Turn capture mode on in a tab that may not be listening yet.
 *
 * `chrome.tabs.sendMessage` fails silently when nothing is receiving, and there
 * are two ordinary ways for that to happen: the tab was open before the
 * extension was installed or reloaded (manifest content scripts inject at
 * navigation, not retroactively), or the page is outside the manifest's match
 * list and only reachable through an optional host permission. Either way the
 * state flips, the panel says "Capturing", and no toolbar appears.
 *
 * So: try the message, and on failure inject the script and try once more. The
 * duplicate-injection case is covered by the content script itself, which keeps
 * one overlay per page.
 */
async function armTab(tabId: number, enabled: boolean): Promise<void> {
  const message = { kind: "capture-mode" as const, enabled };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {
    // Nothing listening — fall through and inject.
  }
  // Only worth injecting to turn capture *on*; there is nothing to switch off
  // in a tab that never had an overlay.
  if (!enabled) return;
  // Read the built filename out of the manifest rather than hardcoding it —
  // the bundler content-hashes the content script, so a literal path here would
  // break on the next build without failing anything at compile time.
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // chrome:// pages, the Web Store, PDFs, and any host we hold no permission
    // for. Not an error — those tabs simply cannot be annotated.
  }
}

async function setCaptureMode(enabled: boolean): Promise<void> {
  await store.patchState({ captureMode: enabled });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (tab.id ? armTab(tab.id, enabled) : Promise.resolve())));
}

const handlers: Handlers = {
  async "state/get"() {
    const state = await store.getState();
    return { ...state, serviceOnline: await isServiceOnline() };
  },

  async "capture/setMode"({ enabled }) {
    await setCaptureMode(enabled);
    if (enabled) await store.ensureActiveBoard();
    return { ...(await store.getState()), serviceOnline: await isServiceOnline() };
  },

  async "capture/element"({ element }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) throw new Error("Capture must come from a tab");

    const board = await store.ensureActiveBoard();
    const shot = await chrome.tabs.captureVisibleTab(sender.tab!.windowId!, { format: "png" });
    const { full, thumb } = await crop(shot, element.rect, element.devicePixelRatio);

    /**
     * Clicking the same element twice updates the pin you already have.
     *
     * The alternative — a second pin for the same component on the same route —
     * splits one conversation into two, and the agent then has to guess whether
     * two notes on the same selector are one instruction or two. Identity is
     * selector plus route, because the same component on /dashboard and
     * /settings is genuinely two things worth saying different things about.
     *
     * The screenshot and styles are refreshed (the page may have changed since);
     * the annotation, status, order and requested values are the user's and are
     * left alone.
     */
    const existing = board.pins.find(
      (p) =>
        p.kind === "element" &&
        p.route === element.route &&
        p.selector === element.selector &&
        p.selector !== "",
    );
    if (existing) {
      await store.putScreenshot(existing.id, full, thumb);
      const merged: Pin = {
        ...existing,
        url: element.url,
        viewport: element.viewport,
        domPath: element.domPath,
        outerHtml: element.outerHtml,
        classList: element.classList,
        elementText: element.elementText,
        componentName: element.componentName ?? existing.componentName,
        sourceFile: element.sourceFile ?? existing.sourceFile,
        computedStyles: element.computedStyles,
        updatedAt: new Date().toISOString(),
      };
      await store.writeBoard({
        ...board,
        pins: board.pins.map((p) => (p.id === existing.id ? merged : p)),
      });
      await notifyBoardChanged(board.id);
      return { pin: merged };
    }

    const pinId = store.nextId("pin");
    const now = new Date().toISOString();
    const highest = store.sortedPins(board).at(-1)?.order ?? 0;

    const pin: Pin = {
      id: pinId,
      schemaVersion: SCHEMA_VERSION,
      boardId: board.id,
      kind: "element",
      drawings: [],
      order: highest + 1,
      groupId: null,
      url: element.url,
      route: element.route,
      viewport: element.viewport,
      screenshotPath: `pins/${pinId}.png`,
      thumbnailPath: `pins/${pinId}.thumb.webp`,
      selector: element.selector,
      domPath: element.domPath,
      outerHtml: element.outerHtml,
      classList: element.classList,
      elementText: element.elementText,
      componentName: element.componentName,
      sourceFile: element.sourceFile,
      computedStyles: element.computedStyles,
      styleEdits: {},
      annotation: "",
      captureState: element.viewport.width < 640 ? "mobile" : "default",
      status: "todo",
      createdAt: now,
      updatedAt: now,
    };

    await store.putScreenshot(pinId, full, thumb);
    await store.writeBoard({ ...board, pins: [...board.pins, pin] });
    await notifyBoardChanged(board.id);
    return { pin };
  },

  async "capture/freeze"(_req, sender) {
    const tab = sender.tab;
    if (!tab?.id || tab.windowId === undefined) throw new Error("Freeze must come from a tab");
    const frame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.storage.local.set({ [freezeKey(tab.id)]: frame });
    return {
      frame,
      viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    };
  },

  async "capture/discardFreeze"(_req, sender) {
    if (sender.tab?.id) await chrome.storage.local.remove(freezeKey(sender.tab.id));
    return { ok: true };
  },

  async "capture/region"({ shapes, url, route, viewport, label }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) throw new Error("Region capture must come from a tab");
    if (shapes.length === 0) throw new Error("Nothing was drawn");

    const bag = await chrome.storage.local.get(freezeKey(tabId));
    const frame = bag[freezeKey(tabId)] as string | undefined;
    if (!frame) throw new Error("The frozen frame expired — draw again");

    const board = await store.ensureActiveBoard();
    const { full, thumb, shapes: rebased } = await compositeRegion(frame, shapes);

    const pinId = store.nextId("pin");
    const now = new Date().toISOString();
    const highest = store.sortedPins(board).at(-1)?.order ?? 0;

    // A region pin carries no element identity by construction — the marked
    // screenshot is the specification, so selector/styles/markup stay empty
    // rather than being filled with something misleading.
    const pin: Pin = {
      id: pinId,
      schemaVersion: SCHEMA_VERSION,
      boardId: board.id,
      kind: "region",
      drawings: rebased,
      order: highest + 1,
      groupId: null,
      url,
      route,
      viewport,
      screenshotPath: `pins/${pinId}.png`,
      thumbnailPath: `pins/${pinId}.thumb.webp`,
      selector: "",
      domPath: "",
      outerHtml: "",
      classList: [],
      elementText: label,
      componentName: null,
      sourceFile: null,
      computedStyles: {},
      styleEdits: {},
      annotation: "",
      captureState: viewport.width < 640 ? "mobile" : "default",
      status: "todo",
      createdAt: now,
      updatedAt: now,
    };

    await store.putScreenshot(pinId, full, thumb);
    await store.writeBoard({ ...board, pins: [...board.pins, pin] });
    await chrome.storage.local.remove(freezeKey(tabId));
    await notifyBoardChanged(board.id);
    return { pin };
  },

  async "board/get"({ boardId }) {
    const board = boardId ? await store.readBoard(boardId) : await store.ensureActiveBoard();
    return { board };
  },

  async "board/list"() {
    return { boards: await store.listBoards() };
  },

  async "board/create"({ title }) {
    const board = await store.createBoard(title);
    await store.patchState({ activeBoardId: board.id });
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "board/setInstruction"({ boardId, instruction }) {
    const board = await store.mutateBoard(boardId, (b) => ({ ...b, globalInstruction: instruction }));
    await notifyBoardChanged(boardId);
    return { board };
  },

  async "board/markReady"({ boardId }) {
    const board = await store.mutateBoard(boardId, (b) => ({
      ...b,
      status: "ready",
      generatedAt: new Date().toISOString(),
    }));

    let materialized = false;
    if (await isServiceOnline()) {
      const screenshots: Record<string, string> = {};
      for (const pin of board.pins) {
        const full = await store.getScreenshot(pin.id);
        if (full) screenshots[pin.id] = full;
      }
      try {
        await materializeBoard(board, screenshots);
        materialized = true;
      } catch {
        materialized = false;
      }
    }

    // MCP cannot push. The pointer is the entire interface between this
    // product and the agent, so it has to be short and typeable from memory.
    const pointer = materialized
      ? `Load Pinnables board "${board.id}" and implement it.`
      : `Read ~/.pinnables/boards/${board.id}/brief.md and implement it.`;

    await notifyBoardChanged(boardId);
    return { board, pointer, materialized };
  },

  async "pin/update"({ pinId, patch }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      pins: b.pins.map((p) =>
        p.id === pinId ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
      ),
    }));
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/setStatus"({ pinId, status }) {
    return handlers["pin/update"]({ pinId, patch: { status } }, {} as chrome.runtime.MessageSender);
  },

  async "pin/delete"({ pinId }) {
    const found = await store.boardForPin(pinId);
    await store.dropScreenshot(pinId);
    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      pins: b.pins.filter((p) => p.id !== pinId),
      relationships: b.relationships
        .filter((r) => r.sourcePinId !== pinId)
        .map((r) => ({ ...r, targetPinIds: r.targetPinIds.filter((t) => t !== pinId) }))
        .filter((r) => r.targetPinIds.length > 0),
    }));
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/reorder"({ pinId, beforePinId }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => {
      const ordered = store.sortedPins(b).filter((p) => p.id !== pinId);
      const index = beforePinId ? ordered.findIndex((p) => p.id === beforePinId) : ordered.length;
      const before = index > 0 ? ordered[index - 1].order : null;
      const after = index >= 0 && index < ordered.length ? ordered[index].order : null;
      const order = store.orderBetween(before, after);
      return { ...b, pins: b.pins.map((p) => (p.id === pinId ? { ...p, order } : p)) };
    });
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/revealSource"({ pinId }) {
    const board = await store.boardForPin(pinId);
    const pin = board.pins.find((p) => p.id === pinId)!;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false };

    if (tab.url !== pin.url) {
      await chrome.tabs.update(tab.id, { url: pin.url });
      // Give the page a beat to settle before asking for a highlight.
      await new Promise((r) => setTimeout(r, 700));
    }
    broadcastToTab(tab.id, {
      kind: "reveal-pin",
      pinId,
      selector: pin.selector,
      domPath: pin.domPath,
      elementText: pin.elementText,
    });
    return { ok: true };
  },

  async "relationship/create"({ sourcePinId, targetPinIds }) {
    const found = await store.boardForPin(sourcePinId);
    const relationship = {
      id: store.nextId("rel"),
      boardId: found.id,
      type: "match" as const,
      sourcePinId,
      targetPinIds,
      properties: ["radius", "spacing", "shadow"],
      exception: "",
      instruction: "",
    };
    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      relationships: [...b.relationships, relationship],
    }));
    await notifyBoardChanged(board.id);
    return { board, relationship };
  },

  async "relationship/update"({ relationshipId, patch }) {
    const found = await store.boardForRelationship(relationshipId);
    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      relationships: b.relationships.map((r) =>
        r.id === relationshipId ? { ...r, ...patch } : r,
      ),
    }));
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "relationship/delete"({ relationshipId }) {
    const found = await store.boardForRelationship(relationshipId);
    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      relationships: b.relationships.filter((r) => r.id !== relationshipId),
    }));
    await notifyBoardChanged(board.id);
    return { board };
  },
};

/* ------------------------------------------------------------------ wiring */

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  const handler = handlers[message.type] as
    | ((req: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>)
    | undefined;
  if (!handler) return false;

  handler(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    // Must happen inside the gesture, before any await.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  const state = await store.getState();
  await setCaptureMode(!state.captureMode);
  if (!state.captureMode) await store.ensureActiveBoard();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-capture") return;
  const state = await store.getState();
  await setCaptureMode(!state.captureMode);
});

/** Screenshots are the bulk of storage — drop them with their board. */
export async function deleteBoard(boardId: string): Promise<void> {
  const board = await store.readBoard(boardId);
  if (!board) return;
  await Promise.all(board.pins.map((p) => store.dropScreenshot(p.id)));
  await chrome.storage.local.remove(`board:${boardId}`);
  const ids = (await store.listBoardIds()).filter((id) => id !== boardId);
  await chrome.storage.local.set({ boardIds: ids });
}

export type { Board };
