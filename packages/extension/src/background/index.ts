import { SCHEMA_VERSION, type Board, type Pin } from "@pinnables/shared";
import {
  broadcastToTab,
  type Broadcast,
  type Contract,
  type Message,
  type RequestType,
  type TabArmState,
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
async function armTab(tabId: number, enabled: boolean): Promise<TabArmState> {
  const message = { kind: "capture-mode" as const, enabled };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return "armed";
  } catch {
    // Nothing listening — fall through and inject.
  }
  // Only worth injecting to turn capture *on*; there is nothing to switch off
  // in a tab that never had an overlay.
  if (!enabled) return "armed";
  // Read the built filename out of the manifest rather than hardcoding it —
  // the bundler content-hashes the content script, so a literal path here would
  // break on the next build without failing anything at compile time.
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return "blocked";
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    /*
     * The injected file is a loader that dynamically imports the real script, so
     * `executeScript` resolves before any listener exists. This message will
     * usually miss — that is fine. The script self-arms from `state/get` once it
     * loads, and capture mode is already written to storage by then.
     */
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
    return "injected";
  } catch {
    // chrome:// pages, the Web Store, PDFs, and any host we hold no permission
    // for. Which of those it is depends on the URL, and the caller knows that.
    return "blocked";
  }
}

/** Arms every tab, and reports what happened to the one in front. */
async function setCaptureMode(enabled: boolean): Promise<TabArmState> {
  await store.patchState({ captureMode: enabled });
  const tabs = await chrome.tabs.query({});
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

  let activeState: TabArmState = "unsupported";
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const annotatable = /^https?:/.test(tab.url ?? "");
      const result = annotatable ? await armTab(tab.id, enabled) : "unsupported";
      if (tab.id === active?.id) activeState = result;
    }),
  );
  return activeState;
}

const handlers: Handlers = {
  async "state/get"() {
    const state = await store.getState();
    return { ...state, serviceOnline: await isServiceOnline() };
  },

  async "capture/setMode"({ enabled }) {
    const activeTab = await setCaptureMode(enabled);
    if (enabled) await store.ensureActiveBoard();
    return {
      ...(await store.getState()),
      serviceOnline: await isServiceOnline(),
      activeTab,
    };
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
        elementSize: { width: element.rect.width, height: element.rect.height },
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
      elementSize: { width: element.rect.width, height: element.rect.height },
      screenshotPath: `pins/${pinId}.png`,
      thumbnailPath: `pins/${pinId}.thumb.webp`,
      selector: element.selector,
      domPath: element.domPath,
      outerHtml: element.outerHtml,
      classList: element.classList,
      elementText: element.elementText,
      componentName: element.componentName,
      name: null,
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

  async "drawing/save"({ shapes, url, route, viewport, shotRect }, sender) {
    const tab = sender.tab;
    if (tab?.id === undefined || tab.windowId === undefined) {
      throw new Error("Drawing must come from a tab");
    }
    const board = await store.ensureActiveBoard();
    const existing = board.pins.find((p) => p.kind === "region" && p.route === route);
    const now = new Date().toISOString();

    // No marks left means no region pin. A route the user erased clean should
    // not leave an empty pin on the shelf for them to tidy up.
    if (shapes.length === 0) {
      if (!existing) return { pin: null };
      await store.dropScreenshot(existing.id);
      await store.writeBoard({
        ...board,
        pins: board.pins.filter((p) => p.id !== existing.id),
        relationships: board.relationships
          .filter((r) => r.sourcePinId !== existing.id)
          .map((r) => ({ ...r, targetPinIds: r.targetPinIds.filter((t) => t !== existing.id) }))
          .filter((r) => r.targetPinIds.length > 0),
      });
      await notifyBoardChanged(board.id);
      return { pin: null };
    }

    /*
     * The screenshot is the agent's copy of what was drawn, and it can only be
     * taken of what is on screen. When the marks are out of view the last good
     * one is kept rather than replaced with a picture of the wrong part of the
     * page — stale beats wrong.
     */
    const pinId = existing?.id ?? store.nextId("pin");
    if (shotRect) {
      const frame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const bitmap = await createImageBitmap(await (await fetch(frame)).blob());
      // captureVisibleTab returns the viewport at device pixel ratio; the rect
      // is CSS pixels against that same viewport.
      const dpr = bitmap.width / viewport.width;
      const sx = Math.max(0, Math.round(shotRect.x * dpr));
      const sy = Math.max(0, Math.round(shotRect.y * dpr));
      const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(shotRect.width * dpr)));
      const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(shotRect.height * dpr)));
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      const scale = Math.min(1, THUMB_WIDTH / sw);
      const thumb = new OffscreenCanvas(
        Math.max(1, Math.round(sw * scale)),
        Math.max(1, Math.round(sh * scale)),
      );
      thumb.getContext("2d")!.drawImage(canvas, 0, 0, sw, sh, 0, 0, thumb.width, thumb.height);
      bitmap.close();
      await store.putScreenshot(
        pinId,
        await encodeCanvas(canvas, "image/png"),
        await encodeCanvas(thumb, "image/webp", 0.75),
      );
    }

    if (existing) {
      const updated: Pin = { ...existing, drawings: shapes, url, viewport, updatedAt: now };
      await store.writeBoard({
        ...board,
        pins: board.pins.map((p) => (p.id === existing.id ? updated : p)),
      });
      await notifyBoardChanged(board.id);
      return { pin: updated };
    }

    const highest = store.sortedPins(board).at(-1)?.order ?? 0;
    const pin: Pin = {
      id: pinId,
      schemaVersion: SCHEMA_VERSION,
      boardId: board.id,
      kind: "region",
      drawings: shapes,
      order: highest + 1,
      groupId: null,
      url,
      route,
      viewport,
      // A region has no element behind it, so its crop is its own size.
      elementSize: { width: 0, height: 0 },
      screenshotPath: `pins/${pinId}.png`,
      thumbnailPath: `pins/${pinId}.thumb.webp`,
      // A region marks an area, so it carries no element identity by
      // construction — leaving these empty is more honest than filling them in.
      selector: "",
      domPath: "",
      outerHtml: "",
      classList: [],
      elementText: `marks on ${route}`,
      componentName: null,
      name: null,
      sourceFile: null,
      computedStyles: {},
      styleEdits: {},
      annotation: "",
      captureState: viewport.width < 640 ? "mobile" : "default",
      status: "todo",
      createdAt: now,
      updatedAt: now,
    };
    await store.writeBoard({ ...board, pins: [...board.pins, pin] });
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
      properties: [],
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

  async "board/clear"({ boardId }) {
    const current = await store.readBoard(boardId);
    // Screenshots are the bulk of what a board costs, so they go with it.
    if (current) await Promise.all(current.pins.map((p) => store.dropScreenshot(p.id)));
    const board = await store.mutateBoard(boardId, (b) => ({ ...b, pins: [], relationships: [] }));
    await notifyBoardChanged(boardId);
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
  void reinjectOpenTabs();
});

/**
 * Reloading the extension orphans every content script already on a page.
 *
 * The DOM survives, so the toolbar and the pins stay on screen, but the isolated
 * world's `chrome.runtime` is gone — the script becomes a picture of itself.
 * Capture mode stops toggling and "Clear all" empties the board without
 * clearing the page, because both are messages nothing is left to receive.
 *
 * `armTab` only recovers this on the way *in* to capture mode, so a tab could
 * sit dead indefinitely. The only cure was reloading each tab by hand, which is
 * a thing to remember at exactly the wrong moment. Re-injecting here means the
 * extension reload is the whole fix.
 *
 * Safe to do unconditionally: every previously injected script is already dead
 * by the time this fires, and `mountOverlay` drops a stale host on the way in.
 */
async function reinjectOpenTabs(): Promise<void> {
  const script = chrome.runtime.getManifest().content_scripts?.[0];
  const files = script?.js ?? [];
  const matches = script?.matches ?? [];
  if (files.length === 0 || matches.length === 0) return;
  const tabs = await chrome.tabs.query({ url: matches }).catch(() => []);
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      /*
       * Ask before injecting, exactly as `armTab` does.
       *
       * Injecting unconditionally put a second copy of the loader into tabs that
       * already had a live one. The extra copies raced the reload they were
       * triggered by, lost their extension context on the way up, and each threw
       * `chrome.runtime.getURL of undefined` — dozens of errors from one reload,
       * and a page whose newest script was a dead one.
       *
       * A tab that answers is already healthy and must be left alone. Only
       * silence means there is nothing there to take over from.
       */
      const alive = await chrome.tabs
        .sendMessage(tab.id, { kind: "ping" as const })
        .then(() => true)
        .catch(() => false);
      if (alive) return;
      // Injection fails on anything we hold no permission for. That is most
      // tabs, and it is not an error worth surfacing.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {});
    }),
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    // Must happen inside the gesture, before any await.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  /*
   * Opening the panel starts a fresh, unarmed capture session.
   *
   * The action used to double as the capture toggle. That made the label depend
   * on whatever state the last panel session left behind: opening Pinnables
   * could immediately say "Capturing" and put an invisible picker over every
   * page. The button in the panel and the keyboard command are the two explicit
   * ways to arm capture; opening the tool only opens it.
   */
  await setCaptureMode(false);
  await store.ensureActiveBoard();
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
