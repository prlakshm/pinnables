import assert from "node:assert/strict";
import test from "node:test";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean;

const destinationUrl = "https://example.com/components/card";
const pin = {
  id: "pin-card",
  url: destinationUrl,
  selector: ".card",
  domPath: "body > main > .card",
  elementText: "Card",
};
const board = { id: "board-1", pins: [pin], relationships: [] };

const ACTIVE_TAB_ID = 7;
const OPEN_TAB_ID = 9;
const CREATED_TAB_ID = 11;

let runtimeListener: RuntimeListener | null = null;
let scenario: "recover" | "blocked" = "recover";
let activeTab: chrome.tabs.Tab;
/** A tab already showing the destination, when the scenario has one. */
let openTab: chrome.tabs.Tab | null = null;
let revealTargets: number[] = [];
let revealAttempts = 0;
let sentBeforeComplete = false;
let injected = false;
let complete = new Set<number>();
const injections: chrome.scripting.ScriptInjection[] = [];
const navigations: Array<{ tabId: number; url: string }> = [];
const activations: number[] = [];
const created: string[] = [];
const focusedWindows: number[] = [];

function makeTab(id: number, url: string, status: string): chrome.tabs.Tab {
  return {
    id,
    url,
    status,
    windowId: 1,
    index: 0,
    pinned: false,
    highlighted: true,
    active: id === ACTIVE_TAB_ID,
    incognito: false,
  } as chrome.tabs.Tab;
}

function reset(options: {
  scenario?: typeof scenario;
  activeUrl: string;
  destinationAlreadyOpen?: boolean;
}) {
  scenario = options.scenario ?? "recover";
  revealTargets = [];
  revealAttempts = 0;
  sentBeforeComplete = false;
  injected = false;
  complete = new Set([ACTIVE_TAB_ID, OPEN_TAB_ID]);
  injections.length = 0;
  navigations.length = 0;
  activations.length = 0;
  created.length = 0;
  focusedWindows.length = 0;
  activeTab = makeTab(ACTIVE_TAB_ID, options.activeUrl, "complete");
  openTab = options.destinationAlreadyOpen
    ? makeTab(OPEN_TAB_ID, destinationUrl, "complete")
    : null;
}

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      getManifest: () => ({ content_scripts: [{ js: ["assets/content-loader.js"] }] }),
      sendMessage: async () => {},
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          runtimeListener = listener;
        },
      },
      onInstalled: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (key: string) => {
          if (key === "boardIds") return { boardIds: [board.id] };
          if (key === `board:${board.id}`) return { [`board:${board.id}`]: board };
          return {};
        },
        remove: async () => {},
      },
    },
    windows: {
      update: async (windowId: number) => {
        focusedWindows.push(windowId);
        return {};
      },
    },
    tabs: {
      query: async (query: chrome.tabs.QueryInfo) => {
        if (typeof query.url === "string") {
          return openTab && openTab.url === query.url ? [openTab] : [];
        }
        if (query.active && query.currentWindow) return [activeTab];
        return [];
      },
      create: async ({ url }: chrome.tabs.CreateProperties) => {
        created.push(url ?? "");
        openTab = makeTab(CREATED_TAB_ID, url ?? "", "loading");
        complete.delete(CREATED_TAB_ID);
        return openTab;
      },
      update: async (tabId: number, update: chrome.tabs.UpdateProperties) => {
        if (update.url === undefined) {
          activations.push(tabId);
          return activeTab;
        }
        navigations.push({ tabId, url: update.url });
        complete.delete(tabId);
        activeTab = makeTab(tabId, update.url, "loading");
        return activeTab;
      },
      get: async (tabId: number) => (tabId === activeTab.id ? activeTab : (openTab ?? activeTab)),
      sendMessage: async (tabId: number, message: { kind?: string }) => {
        if (message.kind !== "reveal-pin") return true;
        revealAttempts += 1;
        revealTargets.push(tabId);
        if (!complete.has(tabId)) sentBeforeComplete = true;
        if (scenario === "recover" && injected && revealAttempts >= 3) return true;
        throw new Error("No receiver");
      },
      onUpdated: {
        addListener: (listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0]) => {
          queueMicrotask(() => {
            // The background registers a module-level listener at import, before
            // any scenario exists. Nothing to settle then.
            if (!activeTab) return;
            const target = openTab?.id ?? ACTIVE_TAB_ID;
            const url = (openTab?.url ?? activeTab.url ?? destinationUrl) as string;
            complete.add(target);
            const settled = makeTab(target, url, "complete");
            if (openTab?.id === target) openTab = settled;
            else activeTab = settled;
            listener(target, { status: "complete" }, settled);
          });
        },
        removeListener: () => {},
      },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    scripting: {
      executeScript: async (injection: chrome.scripting.ScriptInjection) => {
        injections.push(injection);
        if (scenario === "blocked") throw new Error("Missing host permission");
        injected = true;
        return [];
      },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
  },
});

await import("../packages/extension/src/background/index.ts");

function dispatchReveal(): Promise<{ ok: true; data: { ok: boolean } }> {
  assert.ok(runtimeListener, "background should register its message listener");
  return new Promise((resolve) => {
    const keepAlive = runtimeListener!(
      { type: "pin/revealSource", pinId: pin.id },
      {},
      (response) => resolve(response as { ok: true; data: { ok: boolean } }),
    );
    assert.equal(keepAlive, true);
  });
}

test("a tab already showing the page is raised, never navigated", async () => {
  reset({ activeUrl: "http://localhost:5180/dashboard", destinationAlreadyOpen: true });

  const response = await dispatchReveal();

  assert.deepEqual(response, { ok: true, data: { ok: true } });
  assert.deepEqual(activations, [OPEN_TAB_ID], "the existing tab is brought forward");
  assert.deepEqual(focusedWindows, [1], "and its window with it");
  assert.deepEqual(navigations, [], "nothing is sent anywhere");
  assert.deepEqual(created, [], "and no second copy is opened");
  assert.deepEqual([...new Set(revealTargets)], [OPEN_TAB_ID]);
});

test("travel happens in place only within the same app", async () => {
  reset({ activeUrl: "https://example.com/pricing" });

  const response = await dispatchReveal();

  assert.deepEqual(response, { ok: true, data: { ok: true } });
  assert.deepEqual(navigations, [{ tabId: ACTIVE_TAB_ID, url: destinationUrl }]);
  assert.deepEqual(created, []);
  assert.equal(sentBeforeComplete, false, "delivery waits for the destination");
  assert.equal(revealAttempts, 3, "and retries past the injection");
  assert.deepEqual(injections, [
    { target: { tabId: ACTIVE_TAB_ID }, files: ["assets/content-loader.js"] },
  ]);
});

/**
 * The bug this exists to prevent: pressing the shelf pin on a capture from
 * another site used to navigate whatever tab you happened to be on, so asking a
 * question about somebody else's banner cost you the app you were working in.
 */
test("crossing to another site opens a tab and leaves the current one alone", async () => {
  reset({ activeUrl: "http://localhost:5180/dashboard" });

  const response = await dispatchReveal();

  assert.deepEqual(response, { ok: true, data: { ok: true } });
  assert.deepEqual(created, [destinationUrl]);
  assert.deepEqual(navigations, [], "the tab holding the app is untouched");
  assert.deepEqual([...new Set(revealTargets)], [CREATED_TAB_ID]);
});

test("reveal reports failure when the destination cannot accept the content loader", async () => {
  reset({ scenario: "blocked", activeUrl: destinationUrl });

  const response = await dispatchReveal();

  assert.deepEqual(response, { ok: true, data: { ok: false } });
  assert.equal(revealAttempts, 1);
  assert.deepEqual(injections, [
    { target: { tabId: ACTIVE_TAB_ID }, files: ["assets/content-loader.js"] },
  ]);
});
