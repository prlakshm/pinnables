import assert from "node:assert/strict";
import test from "node:test";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean;
type ActivatedListener = (info: { tabId: number; windowId: number }) => void;

const ACCESSION_TAB = 1;
const VERCEL_TAB = 2;

const vercelPin = {
  id: "pin-banner",
  kind: "element",
  url: "https://vercel.com/",
  route: "/",
  selector: ".logos",
  domPath: "body > .logos",
  provisional: false,
  elementText: "",
};
const catalogueLede = {
  id: "pin-lede",
  kind: "element",
  url: "http://localhost:5185/#/catalogue",
  route: "/catalogue",
  selector: ".lede",
  domPath: "body > .lede",
  provisional: false,
  elementText: "Twelve months",
};

function freshBoard() {
  return {
    id: "board-1",
    schemaVersion: 1,
    status: "draft",
    projectId: "local",
    title: "b",
    globalInstruction: "",
    generatedAt: null,
    createdAt: "",
    updatedAt: "",
    pins: [structuredClone(vercelPin), structuredClone(catalogueLede)],
    relationships: [],
  };
}

/** A Map-backed chrome.storage.local: get(key)→{[key]:val}, set(obj), remove(key|keys). */
const store = new Map<string, unknown>();
let runtimeListener: RuntimeListener | null = null;
let activatedListener: ActivatedListener | null = null;
let activeTabId = ACCESSION_TAB;
const delivered: Array<{ tabId: number; message: { kind?: string; pinIds?: string[]; relationshipId?: string } }> = [];
const navigations: Array<{ tabId: number; url: string }> = [];
const created: string[] = [];

function tabRecord(id: number): chrome.tabs.Tab {
  const url = id === VERCEL_TAB ? "https://vercel.com/" : "http://localhost:5185/#/catalogue";
  return { id, url, status: "complete", windowId: 1, active: id === activeTabId } as chrome.tabs.Tab;
}

function seed(overrides: Record<string, unknown> = {}) {
  store.clear();
  store.set("boardIds", ["board-1"]);
  store.set("board:board-1", freshBoard());
  store.set("state", { captureMode: true, activeBoardId: "board-1" });
  for (const [k, v] of Object.entries(overrides)) store.set(k, v);
  delivered.length = 0;
  navigations.length = 0;
  created.length = 0;
}

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      getManifest: () => ({ content_scripts: [{ js: ["assets/content-loader.js"] }] }),
      sendMessage: async () => {},
      onMessage: { addListener: (l: RuntimeListener) => (runtimeListener = l) },
      onInstalled: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
    windows: { update: async () => ({}) },
    tabs: {
      query: async (q: chrome.tabs.QueryInfo) => {
        if (typeof q.url === "string") return [];
        if (q.active && q.currentWindow) return [tabRecord(activeTabId)];
        return [tabRecord(ACCESSION_TAB), tabRecord(VERCEL_TAB)];
      },
      get: async (id: number) => tabRecord(id),
      create: async ({ url }: chrome.tabs.CreateProperties) => {
        created.push(url ?? "");
        return tabRecord(ACCESSION_TAB);
      },
      update: async (tabId: number, u: chrome.tabs.UpdateProperties) => {
        if (u.url !== undefined) navigations.push({ tabId, url: u.url });
        return tabRecord(tabId);
      },
      sendMessage: async (tabId: number, message: { kind?: string }) => {
        delivered.push({ tabId, message });
        return true;
      },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: (l: ActivatedListener) => (activatedListener = l) },
    },
    scripting: { executeScript: async () => [] },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
  },
});

await import("../packages/extension/src/background/index.ts");

function dispatch(type: string, payload: Record<string, unknown>): Promise<{ data: unknown }> {
  assert.ok(runtimeListener, "background should register its message listener");
  return new Promise((resolve) => {
    runtimeListener!({ type, ...payload }, {}, (response) => resolve(response as { data: unknown }));
  });
}

async function activate(tabId: number) {
  activeTabId = tabId;
  assert.ok(activatedListener, "background should listen for tab activation");
  activatedListener({ tabId, windowId: 1 });
  // Let the carry's storage reads and delivery settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const summons = () => delivered.filter((d) => d.message.kind === "summon-pins");
const focusBroadcasts = () => delivered.filter((d) => d.message.kind === "focus-relationship");

/*
 * Bug #3: creating a relationship through the panel navigated the target's tab
 * back to the source's page (vercel.com) — the one page where the relationship
 * cannot be seen, because the target does not live there.
 */
test("a relationship lands where the user is, never on the source's page", async () => {
  seed();
  activeTabId = ACCESSION_TAB;

  const response = await dispatch("relationship/create", {
    sourcePinId: vercelPin.id,
    targetPinIds: [catalogueLede.id],
  });

  assert.ok((response.data as { relationship?: unknown }).relationship);
  assert.deepEqual(navigations, [], "the target's tab is not sent to vercel");
  assert.deepEqual(created, [], "and no tab is opened for the source");
  const onAccession = focusBroadcasts().filter((d) => d.tabId === ACCESSION_TAB);
  assert.equal(onAccession.length, 1, "the cluster composes on the tab the user is on");
});

/*
 * Bug #1: the focused pin should follow across a tab switch, because switching
 * tabs is not clicking elsewhere to defocus.
 */
test("the pin on screen when you leave a tab is re-seated on the tab you arrive at", async () => {
  seed({
    [`onScreenPins:${VERCEL_TAB}`]: [vercelPin.id],
    lastActiveTabId: VERCEL_TAB,
  });

  await activate(ACCESSION_TAB);

  const carried = summons().filter((d) => d.tabId === ACCESSION_TAB);
  assert.equal(carried.length, 1, "the vercel capture follows onto accession");
  assert.deepEqual(carried[0].message.pinIds, [vercelPin.id]);
  assert.deepEqual(navigations, [], "following is not travelling — the tab stays put");
});

test("nothing follows while the tool is closed", async () => {
  seed({
    state: { captureMode: false, activeBoardId: "board-1" },
    [`onScreenPins:${VERCEL_TAB}`]: [vercelPin.id],
    lastActiveTabId: VERCEL_TAB,
  });

  await activate(ACCESSION_TAB);

  assert.deepEqual(summons(), [], "browsing with capture off carries no focus");
});

test("a pin deleted since it was on screen does not travel", async () => {
  seed({
    [`onScreenPins:${VERCEL_TAB}`]: ["pin-ghost"],
    lastActiveTabId: VERCEL_TAB,
  });

  await activate(ACCESSION_TAB);

  assert.deepEqual(summons(), [], "a stale id is dropped, not summoned onto the new page");
});

test("the very first activation has no prior tab to carry from", async () => {
  seed(); // no lastActiveTabId recorded yet

  await activate(ACCESSION_TAB);

  assert.deepEqual(summons(), []);
  assert.equal(store.get("lastActiveTabId"), ACCESSION_TAB, "but it remembers this tab for next time");
});
