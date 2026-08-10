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

let runtimeListener: RuntimeListener | null = null;
let scenario: "recover" | "blocked" = "recover";
let activeTab: chrome.tabs.Tab;
let destinationComplete = false;
let getCalls = 0;
let revealAttempts = 0;
let sentBeforeComplete = false;
let injected = false;
const injections: chrome.scripting.ScriptInjection[] = [];
const updatedUrls: string[] = [];
const updatedListeners = new Set<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>();

function reset(nextScenario: typeof scenario, alreadyAtDestination = false) {
  scenario = nextScenario;
  destinationComplete = alreadyAtDestination;
  getCalls = 0;
  revealAttempts = 0;
  sentBeforeComplete = false;
  injected = false;
  injections.length = 0;
  updatedUrls.length = 0;
  activeTab = {
    id: 7,
    url: alreadyAtDestination ? destinationUrl : "http://localhost:5180/dashboard",
    status: alreadyAtDestination ? "complete" : "loading",
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
  };
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
      },
    },
    tabs: {
      query: async (query: chrome.tabs.QueryInfo) =>
        query.active && query.currentWindow ? [activeTab] : [],
      update: async (_tabId: number, update: chrome.tabs.UpdateProperties) => {
        updatedUrls.push(update.url ?? "");
        activeTab = { ...activeTab, url: update.url, status: "loading" };
        destinationComplete = false;
        return activeTab;
      },
      get: async () => {
        getCalls += 1;
        if (getCalls >= 2) {
          destinationComplete = true;
          activeTab = { ...activeTab, status: "complete" };
        }
        return activeTab;
      },
      sendMessage: async (_tabId: number, message: { kind?: string }) => {
        if (message.kind !== "reveal-pin") return true;
        revealAttempts += 1;
        if (!destinationComplete) sentBeforeComplete = true;
        if (scenario === "recover" && destinationComplete && injected && revealAttempts >= 3) {
          return true;
        }
        throw new Error("No receiver");
      },
      onUpdated: {
        addListener: (listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0]) => {
          updatedListeners.add(listener);
          queueMicrotask(() => {
            destinationComplete = true;
            activeTab = { ...activeTab, status: "complete" };
            listener(7, { status: "complete", url: destinationUrl }, activeTab);
          });
        },
        removeListener: (listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0]) => {
          updatedListeners.delete(listener);
        },
      },
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

test("reveal waits for navigation, injects the content loader, and retries delivery", async () => {
  reset("recover");
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
    nativeSetTimeout(callback, delay === 700 ? 0 : delay, ...args)) as typeof setTimeout;

  try {
    const response = await dispatchReveal();

    assert.deepEqual(response, { ok: true, data: { ok: true } });
    assert.deepEqual(updatedUrls, [destinationUrl]);
    assert.equal(sentBeforeComplete, false);
    assert.equal(revealAttempts, 3);
    assert.deepEqual(injections, [
      { target: { tabId: 7 }, files: ["assets/content-loader.js"] },
    ]);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test("reveal reports failure when the destination cannot accept the content loader", async () => {
  reset("blocked", true);

  const response = await dispatchReveal();

  assert.deepEqual(response, { ok: true, data: { ok: false } });
  assert.equal(revealAttempts, 1);
  assert.deepEqual(injections, [
    { target: { tabId: 7 }, files: ["assets/content-loader.js"] },
  ]);
});
