import {
  BoardSchema,
  SCHEMA_VERSION,
  expandProperties,
  originOf,
  versionKeyFor,
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
import { LEGACY_PRESENCE_KEYS, onScreenPinsKey } from "../lib/presence";
import * as store from "../lib/store";
import {
  agentMessageStatus,
  getHealth,
  isServiceOnline,
  liveFieldsFromHealth,
  pushBoard,
  restoreVersion,
  sendAgentMessage,
} from "../lib/service";
import { versionShotKey } from "../lib/store";
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
 * A provisional pin is silent while nothing about it carries user intent.
 * Silence, not the flag alone, is what authorizes discarding: a discard
 * racing a promotion sees the annotation/relationship/drawing that made the
 * pin real and backs off.
 */
function isSilentProvisional(pin: Pin, board: Board): boolean {
  if (!pin.provisional) return false;
  if (pin.annotation.trim() !== "" || pin.liveSends.length > 0) return false;
  if (pin.name !== null || pin.groupId !== null) return false;
  if (Object.keys(pin.styleEdits).length > 0) return false;
  if (
    board.relationships.some(
      (rel) => rel.sourcePinId === pin.id || rel.targetPinIds.includes(pin.id),
    )
  )
    return false;
  if (board.pins.some((p) => p.drawings.some((d) => d.ownerPinId === pin.id))) return false;
  return true;
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

/**
 * Deliver to the page in front of the user, wherever that is.
 *
 * The verbs split in two. "Summon" brings a capture *here* — the whole point of
 * pinning something on another site is to stand it next to your own component,
 * so the card lands on whatever page you are looking at and rides along as a
 * capture, exactly as an off-route card already does. "Reveal" is the opposite
 * request, "take me to where this lives", and that one travels (`deliverToPage`).
 *
 * Summon and dismiss are the two halves of one shelf toggle, so they must aim
 * at the same place. Dismiss always went to the active tab; summon navigating
 * instead is what made pressing the pin feel like it threw the page away.
 */
async function deliverHere(message: Broadcast): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return false;
  // Through `deliverReveal` rather than a bare broadcast: the page in front of
  // the user may never have been armed, and it still has to receive this.
  return deliverReveal(tab.id, message);
}

/**
 * The tab the user was last looking at. Kept in storage, not a module variable:
 * the MV3 worker is torn down between events and a plain `let` would forget it,
 * so the first switch after any idle period would carry nothing.
 */
const LAST_ACTIVE_TAB_KEY = "lastActiveTabId";

/**
 * Focus follows you across a tab switch.
 *
 * A pin you are looking at is "focused" until you click somewhere else to let
 * it go — and a tab switch is not clicking somewhere else. So the pins on screen
 * on the tab you leave are re-seated on the tab you arrive at: a capture from
 * another site, still floating where you left it, comes with you onto the page
 * you are about to compare it against, instead of stranding you a manual
 * re-summon away from the reference you just pinned.
 *
 * It reuses the summon path exactly, so the arriving page composes it the way it
 * composes any summon — a pin native to this page lands live, everything else as
 * a capture card. Additive and idempotent: pins already on screen here are not
 * duplicated, and a page you dismissed something on keeps it gone until its own
 * on-screen record says otherwise. Only ever runs mid-capture; browsing with the
 * tool closed carries nothing.
 */
async function carryFocusToTab(newTabId: number): Promise<void> {
  const bag = await chrome.storage.local.get(LAST_ACTIVE_TAB_KEY);
  const previousTabId = bag[LAST_ACTIVE_TAB_KEY];
  await chrome.storage.local.set({ [LAST_ACTIVE_TAB_KEY]: newTabId });
  if (typeof previousTabId !== "number" || previousTabId === newTabId) return;
  if (!(await store.getState()).captureMode) return;

  const key = onScreenPinsKey(previousTabId);
  const stored = (await chrome.storage.local.get(key))[key];
  const carried = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  if (carried.length === 0) return;

  // A pin deleted since it was last on screen does not travel.
  const board = await store.ensureActiveBoard().catch(() => null);
  if (!board) return;
  const present = carried.filter((id) => board.pins.some((pin) => pin.id === id && pin.kind === "element"));
  if (present.length === 0) return;

  await deliverReveal(newTabId, { kind: "summon-pins", pinIds: present });
}

/** Raise a tab that already exists, in its own window. */
async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

/**
 * Find the page, and only travel if it is nowhere.
 *
 * Summoning used to mean `tabs.update(activeTab, { url })` unconditionally,
 * which is fine while every pin lives on the one dev server you are looking at
 * and catastrophic the moment one does not: pressing the shelf pin on a
 * capture from vercel.com navigated the tab holding the app away from the app.
 * You lost your work to ask a question about somebody else's banner.
 *
 * So, in order of how little it costs the user:
 *
 *   1. A tab already showing this page — raise it. Nothing is disturbed, and
 *      after the first summon this is nearly always the branch that runs.
 *   2. No such tab, but the active one is on the same origin — navigate it.
 *      This is travel within one app, which is what "go to /catalogue for live
 *      updates" means and what it should keep doing.
 *   3. Otherwise — a new tab. Crossing from your app to a site you are
 *      borrowing from is not travel, and it must never cost you the page you
 *      were on.
 */
async function deliverToPage(url: string, message: Broadcast): Promise<boolean> {
  const existing = await chrome.tabs.query({ url }).catch(() => [] as chrome.tabs.Tab[]);
  const alreadyOpen = existing.find((candidate) => candidate.id !== undefined);
  if (alreadyOpen?.id !== undefined) {
    await focusTab(alreadyOpen);
    if (alreadyOpen.status === "loading" && !(await waitForDestination(alreadyOpen.id, url))) {
      return false;
    }
    return deliverReveal(alreadyOpen.id, message);
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sameApp = active?.url !== undefined && originOf(active.url) === originOf(url);

  if (active?.id !== undefined && active.url === url) {
    if (active.status === "loading" && !(await waitForDestination(active.id, url))) return false;
    return deliverReveal(active.id, message);
  }

  if (active?.id !== undefined && sameApp) {
    try {
      await chrome.tabs.update(active.id, { url });
    } catch {
      return false;
    }
    if (!(await waitForDestination(active.id, url))) return false;
    return deliverReveal(active.id, message);
  }

  let opened: chrome.tabs.Tab;
  try {
    opened = await chrome.tabs.create({ url, active: true });
  } catch {
    return false;
  }
  if (opened.id === undefined) return false;
  if (!(await waitForDestination(opened.id, url))) return false;
  return deliverReveal(opened.id, message);
}

/** Arms every tab, and reports what happened to the one in front. */
/**
 * Drop silent provisionals left behind by a session that never got to say
 * goodbye — a closed tab, a crashed page. Runs when capture arms: a new
 * session must not inherit unspoken receipts from a dead one.
 */
async function sweepSilentProvisionals(): Promise<void> {
  const board = await store.ensureActiveBoard().catch(() => null);
  if (!board || board.status !== "draft") return;
  const dropped: string[] = [];
  await store.mutateBoard(board.id, (b) => {
    if (b.status !== "draft") return b;
    const keep = b.pins.filter((pin) => {
      const silent = isSilentProvisional(pin, b);
      if (silent) dropped.push(pin.id);
      return !silent;
    });
    return dropped.length === 0 ? b : { ...b, pins: keep };
  });
  for (const pinId of dropped) await store.dropScreenshot(pinId);
  if (dropped.length > 0) await notifyBoardChanged(board.id);
}

async function setCaptureMode(enabled: boolean): Promise<TabArmState> {
  /*
   * The sweep rides the mutation queue and can sit behind an in-flight
   * capture for the better part of a second. Awaiting it here made the
   * Capture button feel dead — the mode must flip now; stale-pin hygiene
   * can happen right after, in queue order, without holding the answer.
   */
  if (enabled) void sweepSilentProvisionals();
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
    const health = await getHealth();
    return {
      ...state,
      ...liveFieldsFromHealth(health),
    };
  },

  async "capture/setMode"({ enabled }) {
    const activeTab = await setCaptureMode(enabled);
    if (enabled) await store.ensureActiveBoard();
    const health = await getHealth();
    return {
      ...(await store.getState()),
      ...liveFieldsFromHealth(health),
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
       *
       * Origin is part of that identity for the same reason it gates what a page
       * shows: `/` with a `div.container` describes half the web, and two sites
       * matching on route and selector alone would fold into one pin.
       */
      const captureOrigin = originOf(element.url);
      const existing = current.pins.find(
        (candidate) =>
          candidate.kind === "element" &&
          candidate.route === element.route &&
          originOf(candidate.url) === captureOrigin &&
          candidate.selector === element.selector &&
          candidate.selector !== "" &&
          /*
           * A grouped pin belongs to its group's conversation. Re-clicking
           * that component on the page starts an individual one — a fresh
           * card, never a merge into the group. The group's words still
           * reach the new card as a "from group" record in its expansion.
           */
          candidate.groupId === null,
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
          elementLabel: element.elementLabel,
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

      /*
       * The conversation belongs to the component, not to the board that
       * happened to be open. A submit freezes its board and the next click
       * here makes a fresh pin — but the stickers stay on the cabinet: the
       * newest earlier board holding this same component (same origin,
       * route, selector — the identity test above) hands its record down.
       * Delivered messages and keys come across; staged annotation does
       * not, because it is this board's work list and carrying it would
       * quietly resubmit last board's instructions.
       */
      const ancestor = (await store.listBoards())
        .filter((b) => b.id !== current.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .flatMap((b) =>
          b.pins.filter(
            (candidate) =>
              candidate.kind === "element" &&
              candidate.route === element.route &&
              originOf(candidate.url) === captureOrigin &&
              candidate.selector === element.selector &&
              candidate.selector !== "" &&
              candidate.groupId === null,
          ),
        )[0];

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
        // Born unspoken. The shelf hears about this pin when the user says
        // something to it; until then it is a receipt held in reserve.
        provisional: true,
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
        elementLabel: element.elementLabel,
        componentName: element.componentName,
        name: null,
        sourceFile: element.sourceFile,
        computedStyles: element.computedStyles,
        styleEdits: {},
        annotation: "",
        liveSends: structuredClone(ancestor?.liveSends ?? []),
        versions: structuredClone(ancestor?.versions ?? []),
        /* The ring continues counting — a fresh pin that restarted at 1
           would hand out numerals its inherited keys already wear. */
        versionSeq: ancestor?.versionSeq ?? 0,
        currentVersionNo: ancestor?.currentVersionNo ?? null,
        railPos: null,
        boxPos: null,
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

      // Marks made while a pin was selected are that pin speaking.
      const owners = new Set(
        shapes.map((shape) => shape.ownerPinId).filter((id): id is string => id !== null),
      );
      const promote = (pins: Pin[]): Pin[] =>
        pins.map((pin) =>
          owners.has(pin.id) && pin.provisional ? { ...pin, provisional: false } : pin,
        );

      if (existing) {
        savedPin = { ...existing, drawings: shapes, url, viewport, updatedAt: now };
        return {
          ...current,
          pins: promote(current.pins.map((p) => (p.id === existing.id ? savedPin! : p))),
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
        provisional: false,
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
        elementLabel: null,
        componentName: null,
        name: null,
        sourceFile: null,
        computedStyles: {},
        styleEdits: {},
        annotation: "",
        liveSends: [],
        versions: [],
        versionSeq: 0,
        currentVersionNo: null,
        railPos: null,
        boxPos: null,
        captureState: viewport.width < 640 ? "mobile" : "default",
        status: "todo",
        createdAt: now,
        updatedAt: now,
      };
      return { ...current, pins: promote([...current.pins, savedPin]) };
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
    const droppedSilent: string[] = [];
    type BoardPush = {
      pointer: string;
      transport: "cursor" | "clipboard";
      messageId?: string;
      agentId?: string;
      url?: string;
    };
    // A holder rather than a plain `let`: the assignment happens inside the
    // mutateBoard callback, which control-flow analysis does not credit, so a
    // plain variable would still read as its initializer (null) below.
    const push: { value: BoardPush | null } = { value: null };

    const board = await store.mutateBoard(boardId, async (current) => {
      const health = await getHealth();
      if (!health?.ok) {
        throw new Error("Local service is offline; the board was not submitted");
      }
      // Close every picker while this queued submission still owns the board.
      // A capture already ahead of us finishes first; one arriving now queues
      // behind us and will be rejected after the board becomes ready.
      await setCaptureMode(false);
      // Unspoken receipts never leave the browser: silent provisionals are
      // dropped at the door, and anything that spoke sheds the flag.
      const spoken = current.pins.filter((pin) => {
        const silent = isSilentProvisional(pin, current);
        if (silent) droppedSilent.push(pin.id);
        return !silent;
      });
      const ready: Board = {
        ...current,
        pins: spoken.map((pin) => (pin.provisional ? { ...pin, provisional: false } : pin)),
        status: "ready",
        generatedAt: new Date().toISOString(),
      };
      const screenshots: Record<string, string> = {};
      for (const pin of ready.pins) {
        const full = await store.getScreenshot(pin.id);
        if (full) screenshots[pin.id] = full;
      }
      try {
        // Prefer Cursor Cloud Agents when the service has CURSOR_API_KEY —
        // that path starts the agent with no clipboard paste. Otherwise we
        // materialize to disk and return a pointer for the user to paste.
        const result = await pushBoard(ready, screenshots);
        push.value = {
          pointer: result.pointer,
          transport: result.transport,
          messageId: result.messageId || undefined,
          agentId: result.agentId,
          url: result.url,
        };
        /*
         * The push is one run for the whole board, and a run is a message —
         * so every pin it carried records it, wearing the same messageId.
         * That is what lets the outcome mint the same key on all of them,
         * and what the next board's pins inherit so the conversation shows
         * where it left off. Clipboard pushes record nothing: there is no
         * run to track, only a pointer the user may or may not paste.
         */
        if (result.messageId) {
          const now = new Date().toISOString();
          const sendState = result.state === "queued" ? ("queued" as const) : ("starting" as const);
          const messageId = result.messageId;
          return {
            ...ready,
            pins: ready.pins.map((pin) => ({
              ...pin,
              liveSends: [
                ...(pin.liveSends ?? []),
                {
                  /* The row wears the pin's own words for it — its staged
                     notes — falling back to the board's one instruction. */
                  text:
                    pin.annotation.trim().replace(/\s*\n\s*/g, " · ") ||
                    ready.globalInstruction.trim() ||
                    "Board submission",
                  at: now,
                  messageId,
                  state: sendState,
                  versionNo: null,
                  head: health.versions?.head ?? null,
                },
              ],
            })),
          };
        }
      } catch (error) {
        throw new Error(
          `Could not send the board to the agent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return ready;
    });

    for (const pinId of droppedSilent) await store.dropScreenshot(pinId);
    await notifyBoardChanged(boardId);
    const pushed = push.value;
    return {
      board,
      pointer: pushed?.pointer ?? `Load Pinnables board "${board.id}" and implement it.`,
      materialized: true,
      transport: pushed?.transport ?? "clipboard",
      messageId: pushed?.messageId ?? null,
      agentId: pushed?.agentId ?? null,
      url: pushed?.url ?? null,
    };
  },

  async "pin/update"({ pinId, patch }) {
    const found = await store.boardForPin(pinId);
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.map((p) =>
          p.id === pinId
            ? // Any direct edit is the user speaking — the pin stops being
              // provisional the moment it carries their words.
              { ...p, ...patch, provisional: false, updatedAt: new Date().toISOString() }
            : p,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { board };
  },

  async "pin/setStatus"({ pinId, status }) {
    return handlers["pin/update"]({ pinId, patch: { status } }, {} as chrome.runtime.MessageSender);
  },

  async "pin/discardProvisional"({ pinId }) {
    let discarded = false;
    const found = await store.boardForPin(pinId).catch(() => null);
    if (!found) return { discarded };
    await store.mutateBoard(found.id, (b) => {
      if (b.status !== "draft") return b;
      const pin = b.pins.find((p) => p.id === pinId);
      if (!pin || !isSilentProvisional(pin, b)) return b;
      discarded = true;
      // Silent by definition means unreferenced — no relationship cleanup.
      return { ...b, pins: b.pins.filter((p) => p.id !== pinId) };
    });
    if (discarded) {
      await store.dropScreenshot(pinId);
      await notifyBoardChanged(found.id);
    }
    return { discarded };
  },

  async "pin/delete"({ pinId }) {
    const found = await store.boardForPin(pinId);
    /* Boards from before version keys carry none of the new fields — readBoard
       hands back raw storage, so every read of them has to say "or nothing". */
    const versionNos = found.pins.find((p) => p.id === pinId)?.versions?.map((v) => v.no) ?? [];
    const board = await store.mutateBoard(found.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.filter((p) => p.id !== pinId),
        relationships: b.relationships
          .filter((r) => r.sourcePinId !== pinId)
          .map((r) => ({ ...r, targetPinIds: r.targetPinIds.filter((t) => t !== pinId) }))
          .filter((r) => r.targetPinIds.length > 0),
        /* Its set-down versions have nothing left to belong to. */
        captures: (b.captures ?? []).filter((cap) => cap.pinId !== pinId),
      };
    });
    // Drop its stored artifacts only after deletion wins its place in the board
    // queue. A concurrent re-capture can otherwise write a fresh image after an
    // early drop and leave that image orphaned once the queued delete removes it.
    await store.dropScreenshot(pinId);
    await store.dropVersionShots(pinId, versionNos);
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

  async "panel/open"(_req, sender) {
    /*
     * Everything this needs comes off the sender synchronously. Looking the
     * window up with chrome.tabs.query would spend the gesture before the
     * call, which is why opening the panel from the page never worked
     * reliably before — Chrome refuses sidePanel.open() once the gesture is
     * gone, and the message dispatcher hands us the click still warm.
     */
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) return { ok: false };
    const opening = chrome.sidePanel.open({ windowId });
    return await opening.then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
  },

  async "tab/whoami"(_req, sender) {
    return { tabId: sender.tab?.id ?? null };
  },

  async "pin/summon"({ pinId }) {
    const board = await store.boardForPin(pinId);
    if (!board.pins.some((p) => p.id === pinId)) return { ok: false };
    return { ok: await deliverHere({ kind: "summon-pins", pinIds: [pinId] }) };
  },

  async "pin/dismiss"({ pinId }) {
    // Straight to the active tab, no navigation: dismissing something that is
    // on screen only ever concerns the page in front of the user.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false };
    broadcastToTab(tab.id, { kind: "dismiss-pins", pinIds: [pinId] });
    return { ok: true };
  },

  async "relationship/summon"({ relationshipId }) {
    const board = await store.boardForRelationship(relationshipId);
    const relationship = board.relationships.find((r) => r.id === relationshipId)!;
    const pinIds = [relationship.sourcePinId, ...relationship.targetPinIds];
    // The whole cluster lands on the page in front of the user. Members that
    // live here become live targets; the rest ride along as capture cards,
    // which is the arrangement a cross-site relationship exists to be seen in.
    if (!board.pins.some((p) => p.id === relationship.sourcePinId)) return { ok: false };
    return { ok: await deliverHere({ kind: "summon-pins", pinIds }) };
  },

  async "group/record"({ pinIds }) {
    const board = await store.ensureActiveBoard();
    let groupId = "";
    await store.mutateBoard(board.id, (b) => {
      assertDraftBoard(b);
      const members = b.pins.filter((pin) => pinIds.includes(pin.id));
      const shared = members[0]?.groupId ?? null;
      groupId =
        shared && members.every((pin) => pin.groupId === shared)
          ? shared
          : `grp-${Date.now().toString(36)}`;
      return {
        ...b,
        pins: b.pins.map((pin) =>
          pinIds.includes(pin.id) ? { ...pin, groupId, provisional: false } : pin,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { groupId };
  },

  async "relate/setMode"({ sourcePinId }) {
    const message: Broadcast = { kind: "relate-mode", sourcePinId };
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) if (tab.id) broadcastToTab(tab.id, message);
    return {};
  },

  async "group/summon"({ groupId }) {
    const board = await store.ensureActiveBoard();
    const members = board.pins
      .filter((pin) => pin.groupId === groupId && pin.kind === "element")
      .sort((a, b) => a.order - b.order);
    if (members.length < 2) return { ok: false };
    // Here, like every other summon. Members from elsewhere ride along as
    // capture cards, same as a relationship's cluster.
    return {
      ok: await deliverHere({
        kind: "summon-group",
        pinIds: members.map((pin) => pin.id),
      }),
    };
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

  async "agent/send"({ text, pinIds, relationshipId, drawingSummary, resendOf }) {
    if (pinIds.length === 0) throw new Error("A live message needs at least one pin");
    const board = await store.boardForPin(pinIds[0]);

    /*
     * Pen marks are photographed onto the route's region pin, not the element
     * crop. A live send that illustrated a component still has to carry that
     * region shot or the agent never sees the drawing.
     */
    const screenshotIds = new Set(pinIds);
    for (const pin of board.pins) {
      if (pin.kind !== "region" || pin.drawings.length === 0) continue;
      const relevant =
        pinIds.includes(pin.id) ||
        pin.drawings.some(
          (shape) => shape.ownerPinId !== null && pinIds.includes(shape.ownerPinId),
        );
      if (relevant) screenshotIds.add(pin.id);
    }
    const screenshots: Record<string, string> = {};
    for (const pinId of screenshotIds) {
      const shot = await store.getScreenshot(pinId);
      if (shot) screenshots[pinId] = shot;
    }

    const result = await sendAgentMessage({
      text,
      board,
      pinIds,
      relationshipId,
      drawingSummary,
      screenshots,
    });
    const { messageId } = result;
    const sendState =
      result.state === "queued" ? ("queued" as const) : ("starting" as const);

    /*
     * Delivery recorded only after the service accepted it. `liveSends` is
     * what stops a later board submit from re-issuing this as new work — an
     * agent quietly doing the same change twice is a failure nobody sees.
     * The head is the chapter the message belongs to; when a commit closes
     * it, the row keeps its words and leaves the box.
     */
    const now = new Date().toISOString();
    const sendHead = (await getHealth())?.versions?.head ?? null;
    await store.mutateBoard(board.id, (b) => {
      assertDraftBoard(b);
      return {
        ...b,
        pins: b.pins.map((pin) =>
          pinIds.includes(pin.id)
            ? {
                ...pin,
                liveSends: [
                  // A resend supersedes the entry it retries — the history
                  // keeps one line per intention, not one per attempt.
                  ...pin.liveSends.filter(
                    (sent) => !resendOf || sent.messageId !== resendOf,
                  ),
                  { text, at: now, messageId, state: sendState, versionNo: null, head: sendHead },
                ],
                provisional: false,
                updatedAt: now,
              }
            : pin,
        ),
      };
    });
    await notifyBoardChanged(board.id);
    return { messageId, url: result.url ?? null, state: sendState };
  },

  async "agent/status"({ messageId }) {
    return agentMessageStatus(messageId);
  },

  async "agent/recordOutcome"({ messageId, state }) {
    /*
     * The message decides which board answers, not the active pointer: a
     * board push lands its outcome on the board it froze, minutes after
     * submission already replaced the active draft. No draft assertion
     * either — recording what a run did is bookkeeping about the past, not
     * the user editing a submitted brief.
     */
    const holders = (await store.listBoards()).filter((b) =>
      b.pins.some((pin) => (pin.liveSends ?? []).some((sent) => sent.messageId === messageId)),
    );
    const board = holders[0] ?? (await store.ensureActiveBoard());
    let touched = false;
    /*
     * A key is only minted when the service can honour it — no git tree, no
     * snapshot, and a numeral with nothing behind it would be a lie. The run
     * outcome itself is still recorded either way. The head rides along:
     * a key belongs to the chapter its snapshot was cut in.
     */
    const health = state === "done" ? await getHealth() : null;
    const canMint = state === "done" && Boolean(health?.versions?.ok);
    const mintHead = health?.versions?.head ?? null;
    const evictedShots: Array<{ pinId: string; no: number }> = [];
    await store.mutateBoard(board.id, (b) => {
      /* Boards from before version keys read back raw, without the new
         fields — every read below tolerates their absence. */
      let captures = b.captures ?? [];
      const pins = b.pins.map((pin) => {
        if (!pin.liveSends.some((sent) => sent.messageId === messageId)) return pin;
        let changed = false;
        let liveSends = pin.liveSends.map((sent) => {
          if (sent.messageId !== messageId || sent.state === state) return sent;
          changed = true;
          return { ...sent, state };
        });
        if (!changed) return pin;
        touched = true;
        if (state !== "done" || !canMint) return { ...pin, liveSends };

        /*
         * The run landed — it earns a key. Minted here because this is the
         * one place completion is recorded whatever surface was watching,
         * so a run that finishes with the dialog closed still gets its
         * number. Idempotent by construction: the state comparison above
         * means a second "done" for the same message never reaches this.
         */
        let versions = pin.versions ?? [];
        let seq = pin.versionSeq ?? 0;
        if (versions.length === 0) {
          /*
           * The original slips in as key 1 the moment the first run lands,
           * so there is a way back to before anything happened. Its
           * snapshot is the chapter's baseline, taken by the service before
           * that first run started.
           */
          seq += 1;
          versions = [
            ...versions,
            {
              no: versionKeyFor(seq),
              messageId: null,
              label: "original",
              at: pin.createdAt,
              screenshotKey: null,
              head: mintHead,
            },
          ];
        }
        seq += 1;
        const no = versionKeyFor(seq);
        /*
         * The numeral is taken from whoever wore it before — the ring stays
         * five keys wide without anything being renumbered. The evicted
         * version leaves every rail: captures holding it give it up, and a
         * capture emptied by that has nothing left to show and goes too.
         */
        const evicted = versions.find((v) => v.no === no);
        if (evicted) evictedShots.push({ pinId: pin.id, no });
        versions = versions.filter((v) => v.no !== no);
        captures = captures
          .map((cap) =>
            cap.pinId === pin.id && cap.keys.includes(no)
              ? { ...cap, keys: cap.keys.filter((k) => k !== no) }
              : cap,
          )
          .filter((cap) => cap.keys.length > 0)
          .map((cap) =>
            cap.keys.includes(cap.current) ? cap : { ...cap, current: cap.keys[0] },
          );
        const sent = liveSends.find((s) => s.messageId === messageId);
        versions = [
          ...versions,
          {
            no,
            messageId,
            label: sent?.text ?? "",
            at: new Date().toISOString(),
            screenshotKey: null,
            head: mintHead,
          },
        ];
        liveSends = liveSends.map((s) =>
          s.messageId === messageId ? { ...s, versionNo: no } : s,
        );
        return {
          ...pin,
          liveSends,
          versions,
          versionSeq: seq,
          /* The tree is wearing the run's result right now — the new key is lit. */
          currentVersionNo: no,
        };
      });
      return { ...b, pins, captures };
    });
    /* Best-effort: an evicted key's picture goes with it. */
    for (const gone of evictedShots) {
      void store.dropVersionShots(gone.pinId, [gone.no]).catch(() => {});
    }
    if (touched) await notifyBoardChanged(board.id);
    return {};
  },

  /*
   * Press a key: the working tree goes back to the state it names. The
   * service does the file work (reverse the current patch, apply the
   * target's); this handler owns the bookkeeping — which key is lit — so
   * the answer survives whichever surface asked.
   */
  async "version/restore"({ pinId, no }) {
    const found = await store.boardForPin(pinId);
    const pin = found.pins.find((p) => p.id === pinId);
    if (!pin) throw new Error("Unknown pin");
    const versions = pin.versions ?? [];
    const target = versions.find((v) => v.no === no);
    if (!target) throw new Error(`No version ${no} on this pin`);
    if (pin.currentVersionNo === no) return { board: found, conflicts: [] };

    const from = versions.find((v) => v.no === pin.currentVersionNo);
    const result = await restoreVersion({
      boardId: found.id,
      messageId: target.messageId ?? "baseline",
      /* Null messageId is the original; its snapshot is the baseline. */
      fromMessageId: pin.currentVersionNo === null ? null : (from?.messageId ?? "baseline"),
    });

    const board = await store.mutateBoard(found.id, (b) => ({
      ...b,
      pins: b.pins.map((p) =>
        p.id === pinId ? { ...p, currentVersionNo: no, updatedAt: new Date().toISOString() } : p,
      ),
    }));
    await notifyBoardChanged(board.id);
    return { board, conflicts: result.conflicts };
  },

  /*
   * Photograph the element as it looks right now, for the version that just
   * landed. The overlay supplies the rect because only the page knows where
   * the element is; the crop machinery is the same one pin capture uses.
   */
  async "version/shot"({ pinId, no, rect, devicePixelRatio }, sender) {
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) return { ok: false };
    try {
      const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const { full } = await crop(shot, rect, devicePixelRatio);
      await store.putVersionShot(pinId, no, full);
      const found = await store.boardForPin(pinId);
      await store.mutateBoard(found.id, (b) => ({
        ...b,
        pins: b.pins.map((p) =>
          p.id === pinId
            ? {
                ...p,
                versions: p.versions.map((v) =>
                  v.no === no ? { ...v, screenshotKey: versionShotKey(pinId, no) } : v,
                ),
              }
            : p,
        ),
      }));
      await notifyBoardChanged(found.id);
      return { ok: true };
    } catch {
      /* Throttled captureVisibleTab, background tab — the capture just falls
         back to the pin's own screenshot. */
      return { ok: false };
    }
  },

  /*
   * The overlay owns capture gestures; each one commits its outcome as the
   * whole next state. Validated against the pins so a stale write can never
   * invent a key: unknown versions drop out, emptied captures go with them.
   */
  async "capture/save"({ boardId, captures }) {
    const board = await store.mutateBoard(boardId, (b) => {
      assertDraftBoard(b);
      const valid = captures
        .map((cap) => {
          const pin = b.pins.find((p) => p.id === cap.pinId);
          if (!pin) return null;
          const keys = cap.keys.filter((no) => (pin.versions ?? []).some((v) => v.no === no));
          if (keys.length === 0) return null;
          return {
            ...cap,
            keys,
            current: keys.includes(cap.current) ? cap.current : keys[0],
          };
        })
        .filter((cap): cap is NonNullable<typeof cap> => cap !== null);
      return { ...b, captures: valid };
    });
    await notifyBoardChanged(board.id);
    return { board };
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

      // Relating pins is speaking about all of them at once.
      const involved = new Set([sourcePinId, ...uniqueTargetIds]);
      const promoted = b.pins.map((pin) =>
        involved.has(pin.id) && pin.provisional ? { ...pin, provisional: false } : pin,
      );

      /*
       * One relationship per source. A second connector drawn from the same
       * source does not open a parallel conversation about the same
       * reference — it extends the existing one into a multi-target
       * relationship, which is what dragging another wire visibly says.
       */
      const existingForSource = b.relationships.find(
        (candidate) => candidate.sourcePinId === sourcePinId,
      );
      if (existingForSource) {
        const mergedTargets = [
          ...existingForSource.targetPinIds,
          ...uniqueTargetIds.filter((id) => !existingForSource.targetPinIds.includes(id)),
        ];
        relationship =
          mergedTargets.length === existingForSource.targetPinIds.length
            ? existingForSource
            : { ...existingForSource, targetPinIds: mergedTargets };
        return {
          ...b,
          pins: promoted,
          relationships: b.relationships.map((candidate) =>
            candidate.id === relationship!.id ? relationship! : candidate,
          ),
        };
      }

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
      return { ...b, pins: promoted, relationships: [...b.relationships, relationship] };
    });
    await notifyBoardChanged(board.id);

    /*
     * Creating a relationship is the moment the user wants to see it: the
     * panel jumps to its diff card, and the page composes source-capture plus
     * live targets. One broadcast for both surfaces, from the one place every
     * creation path funnels through.
     *
     * It lands where the user is, never on the source's page. The source is the
     * thing being referenced *from elsewhere* — its whole reason to exist as a
     * capture is that you are standing somewhere else, looking at the target.
     * Sending the scene to the source's url navigated the target's tab away to
     * the source (vercel.com), which is the one place the relationship cannot be
     * seen, since the target does not live there. Delivered here, the source
     * rides along as a capture card beside the live target — the arrangement the
     * relationship was made to be read in. On-page creation paths suppress their
     * own echo (`suppressFocusRelationshipId`) and compose locally.
     */
    const focus: Broadcast = { kind: "focus-relationship", relationshipId: relationship!.id };
    chrome.runtime.sendMessage(focus).catch(() => {});
    void deliverHere(focus);

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
      return { ...b, pins: [], relationships: [], captures: [] };
    });
    await chrome.storage.local.set({
      [CLEAR_STASH_KEY]: { board: stashed, clearedAt: new Date().toISOString() },
    });
    if (previous) {
      await Promise.all(
        previous.pins.map(async (pin) => {
          await store.dropScreenshot(pin.id);
          await store.dropVersionShots(pin.id, (pin.versions ?? []).map((v) => v.no));
        }),
      );
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
  void carryFocusToTab(tabId).catch(() => {});
});

chrome.tabs.onCreated?.addListener((tab) => {
  // Loading tabs are handled once by onUpdated. A tab can also be created in a
  // complete state (for example, session restore), so do not make onUpdated the
  // only entry point.
  if (tab.status !== "complete") return;
  void rearmCaptureTab(tab).catch(() => {});
});

/**
 * A closed tab has nothing on screen. Its presence record would otherwise
 * outlive it and, once Chrome reused the id, hand the shelf somebody else's
 * answer.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.local.remove(onScreenPinsKey(tabId)).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  // Presence used to live in two unscoped keys. Nothing reads them now, and a
  // stale one would linger in local storage forever.
  void chrome.storage.local.remove(LEGACY_PRESENCE_KEYS).catch(() => {});
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
