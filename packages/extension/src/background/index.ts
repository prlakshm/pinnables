import {
  BoardSchema,
  SCHEMA_VERSION,
  expandProperties,
  type Board,
  type Pin,
  type Relationship,
} from "@pinnables/shared";
import {
  broadcastToTab,
  type Broadcast,
  type Contract,
  type Message,
  type RequestType,
  type TabArmState,
} from "../lib/messages";
import * as store from "../lib/store";
import {
  agentMessageStatus,
  isServiceOnline,
  materializeBoard,
  sendAgentMessage,
} from "../lib/service";
import { bitmapCropRect, visibleElementFrame } from "../lib/crop";

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
  const { x: sx, y: sy, width: sw, height: sh } = bitmapCropRect(
    rect,
    dpr,
    bitmap.width,
    bitmap.height,
  );

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

/**
 * Serialize capture-state delivery per tab and coalesce adjacent requests for
 * the same state.
 *
 * Tab lifecycle events routinely arrive together: creating a tab can be
 * followed immediately by activation and then a completed update. Without one
 * shared in-flight operation, all three calls can observe the missing listener
 * and inject three copies of the loader. Keeping only the short-lived promise
 * here is safe for MV3: after a worker restart there cannot be an operation
 * from the old worker still capable of completing.
 */
const pendingTabArms = new Map<
  number,
  { enabled: boolean; promise: Promise<TabArmState> }
>();

function queueTabArm(tabId: number, enabled: boolean): Promise<TabArmState> {
  const pending = pendingTabArms.get(tabId);
  if (pending?.enabled === enabled) return pending.promise;

  const promise = pending
    ? pending.promise.catch(() => "blocked" as const).then(() => armTab(tabId, enabled))
    : armTab(tabId, enabled);
  const operation = { enabled, promise };
  pendingTabArms.set(tabId, operation);
  const release = () => {
    if (pendingTabArms.get(tabId) === operation) pendingTabArms.delete(tabId);
  };
  void promise.then(release, release);
  return promise;
}

function isAnnotatableTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number } {
  if (tab.id === undefined) return false;
  return [tab.url, tab.pendingUrl].some((url) => /^https?:\/\//i.test(url ?? ""));
}

/** Re-arm a web tab only when the persisted global capture state still asks for it. */
async function rearmCaptureTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!isAnnotatableTab(tab)) return;
  if (!(await store.getState()).captureMode) return;

  await queueTabArm(tab.id, true);

  // Capture can be switched off while executeScript is waiting on Chrome. A
  // final state read prevents that late injection from leaving a newly-created
  // overlay armed after the global off broadcast has already gone by.
  if (!(await store.getState()).captureMode) await queueTabArm(tab.id, false);
}

const REVEAL_NAVIGATION_TIMEOUT_MS = 5_000;
const REVEAL_DELIVERY_TIMEOUT_MS = 1_500;
const REVEAL_RETRY_MS = 50;

/** Wait for the requested document, not an arbitrary amount of wall-clock time. */
async function waitForDestination(tabId: number, url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ready);
    };
    const onUpdated = (updatedId: number, _change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedId === tabId && tab.url === url && tab.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), REVEAL_NAVIGATION_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.url === url && tab.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}

/** Deliver a reveal to a live loader, injecting and retrying when none exists. */
async function deliverReveal(tabId: number, message: Broadcast): Promise<boolean> {
  const sendReveal = async () => {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      return false;
    }
  };

  if (await sendReveal()) return true;

  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch {
    return false;
  }

  const deadline = Date.now() + REVEAL_DELIVERY_TIMEOUT_MS;
  do {
    if (await sendReveal()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(REVEAL_RETRY_MS, remaining)));
  } while (Date.now() < deadline);
  return false;
}

/** Bring the active tab to `url` when needed, then deliver one broadcast to it. */
async function deliverToPage(url: string, message: Broadcast): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;

  if (tab.url !== url) {
    try {
      await chrome.tabs.update(tab.id, { url });
    } catch {
      return false;
    }
    if (!(await waitForDestination(tab.id, url))) return false;
  } else if (tab.status === "loading" && !(await waitForDestination(tab.id, url))) {
    return false;
  }
  return deliverReveal(tab.id, message);
}

/** Arms every tab, and reports what happened to the one in front. */
async function setCaptureMode(enabled: boolean): Promise<TabArmState> {
  await store.patchState({ captureMode: enabled });
  const message: Broadcast = { kind: "capture-mode", enabled };
  // `tabs.sendMessage` below updates page overlays. Extension pages such as the
  // side panel do not belong to a tab, so they need the runtime broadcast too.
  // Without it, Escape, the floating toolbar's close button, and the keyboard
  // shortcut changed the page while the panel kept saying "Capturing".
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({});
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

  let activeState: TabArmState = "unsupported";
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const annotatable = /^https?:/.test(tab.url ?? "");
      const result = annotatable ? await queueTabArm(tab.id, enabled) : "unsupported";
      if (tab.id === active?.id) activeState = result;
    }),
  );
  return activeState;
}

function assertDraftBoard(board: Board): void {
  if (board.status !== "draft") throw new Error("Board changes require a draft board");
}

/** Single undo slot for "Clear all" — see the board/clear handler. */
const CLEAR_STASH_KEY = "clearedBoardStash";


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
    const windowId = sender.tab?.windowId;
    if (tabId === undefined || windowId === undefined) throw new Error("Capture must come from a tab");
    // A page click can already be queued when Escape or submission disarms the
    // overlay. Do not let that stale request create a fresh board or take a
    // screenshot after the UI has visibly stopped capturing.
    if (!(await store.getState()).captureMode) throw new Error("Capture mode is off");

    const board = await store.ensureActiveBoard();
    let savedPin!: Pin;
    await store.mutateBoard(board.id, async (current) => {
      if (current.status !== "draft") {
        throw new Error("Capture requires a draft board");
      }

      // Reserve this board's mutation before any screenshot work. Clear and
      // submit requests that arrive while Chrome is photographing or cropping
      // now wait behind this capture instead of committing first and then being
      // overwritten by its late pin write.
      const activeBefore = await chrome.tabs.query({ active: true, windowId });
      if (activeBefore[0]?.id !== tabId) {
        throw new Error("Capture cancelled because the active tab changed");
      }
      const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const activeAfter = await chrome.tabs.query({ active: true, windowId });
      if (activeAfter[0]?.id !== tabId) {
        throw new Error("Capture cancelled because the active tab changed");
      }
      const { full, thumb } = await crop(shot, element.rect, element.devicePixelRatio);
      const screenshotFrame = visibleElementFrame(element.rect, element.viewport) ?? undefined;

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
      const existing = current.pins.find(
        (candidate) =>
          candidate.kind === "element" &&
          candidate.route === element.route &&
          candidate.selector === element.selector &&
          candidate.selector !== "",
      );
      if (existing) {
        savedPin = {
          ...existing,
          url: element.url,
          viewport: element.viewport,
          elementSize: { width: element.rect.width, height: element.rect.height },
          screenshotFrame,
          domPath: element.domPath,
          outerHtml: element.outerHtml,
          classList: element.classList,
          elementText: element.elementText,
          componentName: element.componentName ?? existing.componentName,
          sourceFile: element.sourceFile ?? existing.sourceFile,
          computedStyles: element.computedStyles,
          updatedAt: new Date().toISOString(),
        };
        await store.putScreenshot(existing.id, full, thumb);
        return {
          ...current,
          pins: current.pins.map((pin) => (pin.id === existing.id ? savedPin : pin)),
        };
      }

      const pinId = store.nextId("pin");
      const now = new Date().toISOString();
      const highest = store.sortedPins(current).at(-1)?.order ?? 0;
      savedPin = {
        id: pinId,
        schemaVersion: SCHEMA_VERSION,
        boardId: current.id,
        kind: "element",
        drawings: [],
        order: highest + 1,
        groupId: null,
        url: element.url,
        route: element.route,
        viewport: element.viewport,
        elementSize: { width: element.rect.width, height: element.rect.height },
        screenshotFrame,
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
        liveSends: [],
        captureState: element.viewport.width < 640 ? "mobile" : "default",
        status: "todo",
        createdAt: now,
        updatedAt: now,
      };
      await store.putScreenshot(pinId, full, thumb);
      return { ...current, pins: [...current.pins, savedPin] };
    });
    await notifyBoardChanged(board.id);
    return { pin: savedPin };
  },

  async "drawing/save"({ shapes, url, route, viewport, shotRect }, sender) {
    const tab = sender.tab;
    if (tab?.id === undefined || tab.windowId === undefined) {
      throw new Error("Drawing must come from a tab");
    }
    const board = await store.ensureActiveBoard();

    /*
     * The screenshot is the agent's copy of what was drawn, and it can only be
     * taken of what is on screen. When the marks are out of view the last good
     * one is kept rather than replaced with a picture of the wrong part of the
     * page — stale beats wrong.
     */
    let screenshot: { full: string; thumb: string } | null = null;
    if (shotRect) {
      const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeBefore[0]?.id !== tab.id) {
        throw new Error("Drawing capture cancelled because the active tab changed");
      }
      const frame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const activeAfter = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeAfter[0]?.id !== tab.id) {
        throw new Error("Drawing capture cancelled because the active tab changed");
      }
      const bitmap = await createImageBitmap(await (await fetch(frame)).blob());
      // captureVisibleTab returns the viewport at device pixel ratio; the rect
      // is CSS pixels against that same viewport.
      const dpr = bitmap.width / viewport.width;
      const { x: sx, y: sy, width: sw, height: sh } = bitmapCropRect(
        shotRect,
        dpr,
        bitmap.width,
        bitmap.height,
      );
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      const scale = Math.min(1, THUMB_WIDTH / sw);
      const thumb = new OffscreenCanvas(
        Math.max(1, Math.round(sw * scale)),
        Math.max(1, Math.round(sh * scale)),
      );
      thumb.getContext("2d")!.drawImage(canvas, 0, 0, sw, sh, 0, 0, thumb.width, thumb.height);
      bitmap.close();
      screenshot = {
        full: await encodeCanvas(canvas, "image/png"),
        thumb: await encodeCanvas(thumb, "image/webp", 0.75),
      };
    }

    let savedPin: Pin | null = null;
    let droppedScreenshot: string | null = null;
    await store.mutateBoard(board.id, async (current) => {
      assertDraftBoard(current);
      const existing = current.pins.find((p) => p.kind === "region" && p.route === route);

      // No marks left means no region pin. Resolve this against the queued,
      // latest board so an annotation or pin arriving while the screenshot was
      // encoded cannot be overwritten by the older board snapshot.
      if (shapes.length === 0) {
        if (!existing) return current;
        droppedScreenshot = existing.id;
        return {
          ...current,
          pins: current.pins.filter((p) => p.id !== existing.id),
          relationships: current.relationships
            .filter((r) => r.sourcePinId !== existing.id)
            .map((r) => ({ ...r, targetPinIds: r.targetPinIds.filter((t) => t !== existing.id) }))
            .filter((r) => r.targetPinIds.length > 0),
        };
      }

      const now = new Date().toISOString();
      const pinId = existing?.id ?? store.nextId("pin");
      if (screenshot) await store.putScreenshot(pinId, screenshot.full, screenshot.thumb);

      if (existing) {
        savedPin = { ...existing, drawings: shapes, url, viewport, updatedAt: now };
        return {
          ...current,
          pins: current.pins.map((p) => (p.id === existing.id ? savedPin! : p)),
        };
      }

      const highest = store.sortedPins(current).at(-1)?.order ?? 0;
      savedPin = {
        id: pinId,
        schemaVersion: SCHEMA_VERSION,
        boardId: current.id,
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
        liveSends: [],
        captureState: viewport.width < 640 ? "mobile" : "default",
        status: "todo",
        createdAt: now,
        updatedAt: now,
      };
      return { ...current, pins: [...current.pins, savedPin] };
    });
    if (droppedScreenshot) await store.dropScreenshot(droppedScreenshot);
    await notifyBoardChanged(board.id);
    return { pin: savedPin };
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
    const board = await store.mutateBoard(boardId, (b) => {
      assertDraftBoard(b);
      return { ...b, globalInstruction: instruction };
    });
    await notifyBoardChanged(boardId);
    return { board };
  },

  async "board/markReady"({ boardId }) {
    const board = await store.mutateBoard(boardId, async (current) => {
      if (!(await isServiceOnline())) {
        throw new Error("Local service is offline; the board was not submitted");
      }
      // Close every picker while this queued submission still owns the board.
      // A capture already ahead of us finishes first; one arriving now queues
      // behind us and will be rejected after the board becomes ready.
      await setCaptureMode(false);
      const ready: Board = {
        ...current,
        status: "ready",
        generatedAt: new Date().toISOString(),
      };
      const screenshots: Record<string, string> = {};
      for (const pin of ready.pins) {
        const full = await store.getScreenshot(pin.id);
        if (full) screenshots[pin.id] = full;
      }
      try {
        await materializeBoard(ready, screenshots);
      } catch (error) {
        throw new Error(
          `Could not write the board for the agent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return ready;
    });

    // MCP cannot push. The pointer is the entire interface between this
    // product and the agent, so it has to be short and typeable from memory.
    const pointer = `Load Pinnables board "${board.id}" and implement it.`;

    await notifyBoardChanged(boardId);
    return { board, pointer, materialized: true };
  },

  async "pin/update"({ pinId, patch }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.map((p) =>
          p.id === pinId ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/setStatus"({ pinId, status }) {
    return handlers["pin/update"]({ pinId, patch: { status } }, {} as chrome.runtime.MessageSender);
  },

  async "pin/delete"({ pinId }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.filter((p) => p.id !== pinId),
        relationships: b.relationships
          .filter((r) => r.sourcePinId !== pinId)
          .map((r) => ({ ...r, targetPinIds: r.targetPinIds.filter((t) => t !== pinId) }))
          .filter((r) => r.targetPinIds.length > 0),
      };
    });
    // Drop its stored artifacts only after deletion wins its place in the board
    // queue. A concurrent re-capture can otherwise write a fresh image after an
    // early drop and leave that image orphaned once the queued delete removes it.
    await store.dropScreenshot(pinId);
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/reorder"({ pinId, beforePinId }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
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
    return {
      ok: await deliverToPage(pin.url, {
        kind: "reveal-pin",
        pinId,
        selector: pin.selector,
        domPath: pin.domPath,
        elementText: pin.elementText,
      }),
    };
  },

  async "pin/summon"({ pinId }) {
    const board = await store.boardForPin(pinId);
    const pin = board.pins.find((p) => p.id === pinId)!;
    return { ok: await deliverToPage(pin.url, { kind: "summon-pins", pinIds: [pinId] }) };
  },

  async "relationship/summon"({ relationshipId }) {
    const board = await store.boardForRelationship(relationshipId);
    const relationship = board.relationships.find((r) => r.id === relationshipId)!;
    const pinIds = [relationship.sourcePinId, ...relationship.targetPinIds];
    // The source's page hosts the cluster; a cross-route relationship still
    // opens somewhere real rather than nowhere.
    const anchor = board.pins.find((p) => p.id === relationship.sourcePinId);
    if (!anchor) return { ok: false };
    return { ok: await deliverToPage(anchor.url, { kind: "summon-pins", pinIds }) };
  },

  async "relationship/open"({ relationshipId, atPinId }) {
    const board = await store.boardForRelationship(relationshipId);
    const pin = board.pins.find((candidate) => candidate.id === atPinId);
    if (!pin) return { ok: false };
    // Same recomposition the creation broadcast uses, aimed at the pin's own
    // page — where this pin stops being a capture and becomes the live target.
    return {
      ok: await deliverToPage(pin.url, { kind: "focus-relationship", relationshipId }),
    };
  },

  async "agent/send"({ text, pinIds, relationshipId, drawingSummary }) {
    if (pinIds.length === 0) throw new Error("A live message needs at least one pin");
    const board = await store.boardForPin(pinIds[0]);

    const screenshots: Record<string, string> = {};
    for (const pinId of pinIds) {
      const shot = await store.getScreenshot(pinId);
      if (shot) screenshots[pinId] = shot;
    }

    const { messageId } = await sendAgentMessage({
      text,
      board,
      pinIds,
      relationshipId,
      drawingSummary,
      screenshots,
    });

    /*
     * Delivery recorded only after the service accepted it. `liveSends` is
     * what stops a later board submit from re-issuing this as new work — an
     * agent quietly doing the same change twice is a failure nobody sees.
     */
    const now = new Date().toISOString();
    await store.mutateBoard(board.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.map((pin) =>
          pinIds.includes(pin.id)
            ? { ...pin, liveSends: [...pin.liveSends, { text, at: now }], updatedAt: now }
            : pin,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { messageId };
  },

  async "agent/status"({ messageId }) {
    return agentMessageStatus(messageId);
  },

  async "relationship/create"({ sourcePinId, targetPinIds }) {
    const found = await store.boardForPin(sourcePinId);
    const uniqueTargetIds = [...new Set(targetPinIds)].filter((id) => id !== sourcePinId);
    let relationship: Relationship | undefined;
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      const source = b.pins.find((pin) => pin.id === sourcePinId);
      if (!source || source.kind !== "element") {
        throw new Error("Relationships require an element pin as the source");
      }
      if (uniqueTargetIds.length === 0) throw new Error("A relationship needs a target");
      for (const targetId of uniqueTargetIds) {
        const target = b.pins.find((pin) => pin.id === targetId);
        if (!target || target.kind !== "element") {
          throw new Error("Relationships require element pins as targets");
        }
      }

      relationship = b.relationships.find(
        (candidate) =>
          candidate.sourcePinId === sourcePinId &&
          candidate.targetPinIds.length === uniqueTargetIds.length &&
          candidate.targetPinIds.every((targetId) => uniqueTargetIds.includes(targetId)),
      );
      if (relationship) return b;

      relationship = {
        id: store.nextId("rel"),
        boardId: found.id,
        type: "match",
        sourcePinId,
        targetPinIds: uniqueTargetIds,
        properties: [],
        exception: "",
        instruction: "",
      };
      return { ...b, relationships: [...b.relationships, relationship] };
    });
    await notifyBoardChanged(board.id);

    /*
     * Creating a relationship is the moment the user wants to see it: the
     * panel jumps to its diff card, and the page composes source-capture plus
     * live targets. One broadcast for both surfaces, from the one place every
     * creation path funnels through.
     */
    const focus: Broadcast = { kind: "focus-relationship", relationshipId: relationship!.id };
    chrome.runtime.sendMessage(focus).catch(() => {});
    const anchor = board.pins.find((pin) => pin.id === sourcePinId);
    if (anchor) void deliverToPage(anchor.url, focus);

    return { board, relationship: relationship! };
  },

  async "relationship/update"({ relationshipId, patch }) {
    const found = await store.boardForRelationship(relationshipId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      const relationship = b.relationships.find((candidate) => candidate.id === relationshipId);
      if (!relationship) throw new Error(`No board contains relationship "${relationshipId}"`);

      const source = b.pins.find((pin) => pin.id === relationship.sourcePinId);
      if (!source || source.kind !== "element") {
        throw new Error("Relationships require an element pin as the source");
      }
      const targetPinIds = [...new Set(patch.targetPinIds ?? relationship.targetPinIds)].filter(
        (id) => id !== relationship.sourcePinId,
      );
      if (targetPinIds.length === 0) throw new Error("A relationship needs a target");
      for (const targetId of targetPinIds) {
        const target = b.pins.find((pin) => pin.id === targetId);
        if (!target || target.kind !== "element") {
          throw new Error("Relationships require element pins as targets");
        }
      }

      const selectedProperties = new Set(
        expandProperties(patch.properties ?? relationship.properties),
      );
      for (const other of b.relationships) {
        if (other.id === relationshipId) continue;
        const sharedTargetId = targetPinIds.find((targetId) =>
          other.targetPinIds.includes(targetId),
        );
        if (!sharedTargetId) continue;
        const conflict = expandProperties(other.properties).find((property) =>
          selectedProperties.has(property),
        );
        if (conflict) {
          throw new Error(
            `Relationship property "${conflict}" is already selected for target "${sharedTargetId}"`,
          );
        }
      }

      return {
        ...b,
        relationships: b.relationships.map((candidate) =>
          candidate.id === relationshipId ? { ...candidate, ...patch, targetPinIds } : candidate,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "board/clear"({ boardId }) {
    /*
     * One undo slot. The board being cleared is stashed whole, and its
     * screenshots are deliberately *not* dropped — they are what undo needs.
     * The previous stash's artifacts are purged instead: its pins are gone
     * from every board, so nothing can reach them anymore. Pin ids are unique
     * per capture, so the old stash can never name a screenshot the new one
     * still wants.
     */
    const bag = await chrome.storage.local.get(CLEAR_STASH_KEY);
    const previous = (bag[CLEAR_STASH_KEY] as { board?: Board } | undefined)?.board;

    let stashed: Board | null = null;
    const board = await store.mutateBoard(boardId, (b) => {
      assertDraftBoard(b);
      // Resolve the stash from the same queued snapshot that is cleared.
      // Otherwise a capture finishing between the old read and this mutation
      // leaves its screenshot behind with no pin pointing to it.
      stashed = b;
      return { ...b, pins: [], relationships: [] };
    });
    await chrome.storage.local.set({
      [CLEAR_STASH_KEY]: { board: stashed, clearedAt: new Date().toISOString() },
    });
    if (previous) {
      await Promise.all(previous.pins.map((pin) => store.dropScreenshot(pin.id)));
    }
    await notifyBoardChanged(boardId);
    return { board };
  },

  async "board/undoClear"({ boardId }) {
    const bag = await chrome.storage.local.get(CLEAR_STASH_KEY);
    const stashed = (bag[CLEAR_STASH_KEY] as { board?: unknown } | undefined)?.board;
    const parsed = stashed ? BoardSchema.safeParse(stashed) : null;
    if (!parsed?.success || parsed.data.id !== boardId) {
      throw new Error("There is nothing to restore for this board");
    }
    const restored = parsed.data;
    const board = await store.mutateBoard(boardId, (b) => {
      assertDraftBoard(b);
      // Undo restores, never destroys: pins captured after the clear win over
      // the stash, and the toast has simply outlived its moment.
      if (b.pins.length > 0) {
        throw new Error("New pins were added since the clear; undo is no longer available");
      }
      return { ...b, pins: restored.pins, relationships: restored.relationships };
    });
    await chrome.storage.local.remove(CLEAR_STASH_KEY);
    await notifyBoardChanged(boardId);
    return { board };
  },

  async "relationship/delete"({ relationshipId }) {
    const found = await store.boardForRelationship(relationshipId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        relationships: b.relationships.filter((r) => r.id !== relationshipId),
      };
    });
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

/* ------------------------------------------------------- capture lifecycle */

/**
 * Optional-host content scripts do not survive a full-page navigation and are
 * not injected automatically on newly opened origins. When global capture is
 * already on, follow the browser lifecycle so those documents receive the
 * same loader that `setCaptureMode` would have installed at toggle time.
 */
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  void rearmCaptureTab({ ...tab, id: tab.id ?? tabId }).catch(() => {});
});

chrome.tabs.onActivated?.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then(rearmCaptureTab)
    .catch(() => {});
});

chrome.tabs.onCreated?.addListener((tab) => {
  // Loading tabs are handled once by onUpdated. A tab can also be created in a
  // complete state (for example, session restore), so do not make onUpdated the
  // only entry point.
  if (tab.status !== "complete") return;
  void rearmCaptureTab(tab).catch(() => {});
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
  if (files.length === 0) return;
  /*
   * The manifest only auto-injects on localhost, but a user can grant optional
   * access to any HTTP(S) origin and `armTab` injects the same loader there.
   * Those tabs need reload recovery too. Querying web URLs keeps internal pages
   * out of the loop; executeScript below remains the permission check and safely
   * declines origins the user has not granted.
   */
  const tabs = await chrome.tabs
    .query({ url: ["http://*/*", "https://*/*"] })
    .catch(() => []);
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
  const enabling = !state.captureMode;
  const activeTab = await setCaptureMode(enabling);
  // The shortcut has no panel-local handler to show an access error. Leaving
  // the global state armed on an internal or denied page would make every
  // surface claim capture is active even though the foreground tab cannot be
  // captured, so roll the optimistic toggle back immediately.
  if (enabling && (activeTab === "blocked" || activeTab === "unsupported")) {
    await setCaptureMode(false);
  }
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
