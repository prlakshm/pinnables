import assert from "node:assert/strict";
import test from "node:test";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean;

/** A capture taken on somebody else's site. */
const foreignPin = {
  id: "pin-banner",
  kind: "element",
  url: "https://vercel.com/",
  route: "/",
  groupId: "grp-1",
  order: 1,
  selector: ".logos",
  domPath: "body > .logos",
  elementText: "",
};
/** A component in the user's own app, on the page they are looking at. */
const localPin = {
  id: "pin-lede",
  kind: "element",
  url: "http://localhost:5185/#/catalogue",
  route: "/catalogue",
  groupId: "grp-1",
  order: 2,
  selector: ".lede",
  domPath: "body > .lede",
  elementText: "Twelve months",
};
const relationship = {
  id: "rel-1",
  boardId: "board-1",
  type: "match",
  sourcePinId: foreignPin.id,
  targetPinIds: [localPin.id],
  properties: [],
  exception: "",
  instruction: "",
};
const board = {
  id: "board-1",
  status: "draft",
  pins: [foreignPin, localPin],
  relationships: [relationship],
};

const ACTIVE_TAB_ID = 4;
let runtimeListener: RuntimeListener | null = null;
const navigations: string[] = [];
const created: string[] = [];
const delivered: Array<{ tabId: number; message: { kind?: string; pinIds?: string[] } }> = [];

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
          if (key === "state") return { state: { activeBoardId: board.id } };
          return {};
        },
        set: async () => {},
        remove: async () => {},
      },
    },
    windows: { update: async () => ({}) },
    tabs: {
      // The user is standing on their own app, and the pin is not from it.
      query: async (query: chrome.tabs.QueryInfo) => {
        if (typeof query.url === "string") return [];
        if (query.active && query.currentWindow) {
          return [
            {
              id: ACTIVE_TAB_ID,
              url: "http://localhost:5185/#/catalogue",
              status: "complete",
              windowId: 1,
            },
          ];
        }
        return [];
      },
      create: async ({ url }: chrome.tabs.CreateProperties) => {
        created.push(url ?? "");
        return { id: 99, url, status: "loading", windowId: 1 };
      },
      update: async (_tabId: number, update: chrome.tabs.UpdateProperties) => {
        if (update.url !== undefined) navigations.push(update.url);
        return {};
      },
      get: async () => ({ id: ACTIVE_TAB_ID, status: "complete" }),
      sendMessage: async (tabId: number, message: { kind?: string; pinIds?: string[] }) => {
        delivered.push({ tabId, message });
        return true;
      },
      onUpdated: {
        // Settle whatever tab reveal just opened, so its wait resolves at once
        // instead of running down the navigation timeout.
        addListener: (listener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0]) => {
          queueMicrotask(() => {
            if (created.length === 0) return;
            const tab = { id: 99, url: created[created.length - 1], status: "complete", windowId: 1 };
            listener(99, { status: "complete" }, tab as chrome.tabs.Tab);
          });
        },
        removeListener() {},
      },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: async () => [] },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
  },
});

await import("../packages/extension/src/background/index.ts");

function dispatch(type: string, payload: Record<string, unknown>): Promise<{ data: { ok: boolean } }> {
  assert.ok(runtimeListener, "background should register its message listener");
  return new Promise((resolve) => {
    runtimeListener!({ type, ...payload }, {}, (response) =>
      resolve(response as { data: { ok: boolean } }),
    );
  });
}

function reset() {
  navigations.length = 0;
  created.length = 0;
  delivered.length = 0;
}

/**
 * The point of pinning something on another site is to stand it beside your own
 * component. Summoning used to open the site it came from, which put the two
 * things you were comparing in two different tabs — the one arrangement in
 * which neither can be seen next to the other.
 */
test("summoning a capture from another site lands it on the page you are on", async () => {
  reset();
  const response = await dispatch("pin/summon", { pinId: foreignPin.id });

  assert.equal(response.data.ok, true);
  assert.deepEqual(navigations, [], "the page you are on is not sent anywhere");
  assert.deepEqual(created, [], "and no tab is opened for the site it came from");
  assert.deepEqual(delivered, [
    { tabId: ACTIVE_TAB_ID, message: { kind: "summon-pins", pinIds: [foreignPin.id] } },
  ]);
});

test("a cross-site relationship arrives whole, wherever you are standing", async () => {
  reset();
  const response = await dispatch("relationship/summon", { relationshipId: relationship.id });

  assert.equal(response.data.ok, true);
  assert.deepEqual(navigations, []);
  assert.deepEqual(created, []);
  assert.deepEqual(delivered, [
    {
      tabId: ACTIVE_TAB_ID,
      message: { kind: "summon-pins", pinIds: [foreignPin.id, localPin.id] },
    },
  ]);
});

test("a group reunites here too, rather than on its first member's page", async () => {
  reset();
  const response = await dispatch("group/summon", { groupId: "grp-1" });

  assert.equal(response.data.ok, true);
  assert.deepEqual(navigations, []);
  assert.deepEqual(created, []);
  assert.deepEqual(delivered, [
    {
      tabId: ACTIVE_TAB_ID,
      message: { kind: "summon-group", pinIds: [foreignPin.id, localPin.id] },
    },
  ]);
});

/**
 * The other half of the split: "take me to where this lives" still travels.
 * Only summon means "bring it here".
 */
test("revealing a source still goes to the page that holds it", async () => {
  reset();
  await dispatch("pin/revealSource", { pinId: foreignPin.id });

  assert.deepEqual(created, [foreignPin.url], "crossing sites opens a tab");
  assert.deepEqual(navigations, [], "and never repurposes the one you are on");
});
