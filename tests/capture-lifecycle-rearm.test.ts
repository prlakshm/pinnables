import assert from "node:assert/strict";
import test from "node:test";

type UpdatedListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
type ActivatedListener = Parameters<typeof chrome.tabs.onActivated.addListener>[0];
type CreatedListener = Parameters<typeof chrome.tabs.onCreated.addListener>[0];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

let captureMode = true;
const updatedListeners: UpdatedListener[] = [];
const activatedListeners: ActivatedListener[] = [];
const createdListeners: CreatedListener[] = [];
const tabs = new Map<number, chrome.tabs.Tab>();
const liveTabs = new Set<number>();
const blockedTabs = new Set<number>();
const delayedLoaderTabs = new Set<number>();
const injectionGates = new Map<number, Deferred<void>>();
const injections: number[] = [];
const captureMessages: Array<{ tabId: number; enabled: boolean }> = [];

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: {
      local: {
        async get(key: string) {
          return key === "state"
            ? { state: { captureMode, activeBoardId: null, serviceOnline: false, cursorOnline: false } }
            : {};
        },
        async set() {},
        async remove() {},
      },
    },
    runtime: {
      id: "capture-lifecycle-test",
      getManifest: () => ({
        content_scripts: [{ js: ["assets/content-loader.js"] }],
      }),
      sendMessage: async () => undefined,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: {
      query: async () => [],
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("No tab");
        return tab;
      },
      sendMessage: async (tabId: number, message: { kind?: string; enabled?: boolean }) => {
        if (message.kind === "capture-mode") {
          captureMessages.push({ tabId, enabled: Boolean(message.enabled) });
        }
        if (!liveTabs.has(tabId)) throw new Error("No receiver");
        return undefined;
      },
      update: async () => undefined,
      captureVisibleTab: async () => "data:image/png;base64,frame",
      onUpdated: {
        addListener(listener: UpdatedListener) {
          updatedListeners.push(listener);
        },
        removeListener() {},
      },
      onActivated: {
        addListener(listener: ActivatedListener) {
          activatedListeners.push(listener);
        },
      },
      onCreated: {
        addListener(listener: CreatedListener) {
          createdListeners.push(listener);
        },
      },
    },
    scripting: {
      async executeScript({ target }: chrome.scripting.ScriptInjection) {
        const tabId = target.tabId;
        injections.push(tabId);
        const gate = injectionGates.get(tabId);
        if (gate) await gate.promise;
        if (blockedTabs.has(tabId)) throw new Error("Missing host permission");
        if (!delayedLoaderTabs.has(tabId)) liveTabs.add(tabId);
        return [];
      },
    },
    sidePanel: {
      setPanelBehavior: async () => undefined,
      open: async () => undefined,
    },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
  },
});

await import("../packages/extension/src/background/index.ts");

test("capture mode rearms navigated, activated, and newly-created web tabs exactly once", async () => {
  assert.equal(updatedListeners.length, 1, "one navigation listener should be registered");
  assert.equal(activatedListeners.length, 1, "one activation listener should be registered");
  assert.equal(createdListeners.length, 1, "one creation listener should be registered");

  const navigated = {
    id: 11,
    url: "https://navigation.example/dashboard",
    status: "complete" as const,
  };
  tabs.set(11, navigated);
  updatedListeners[0](11, { status: "complete" }, navigated);

  const activated = {
    id: 12,
    url: "https://activation.example/settings",
    status: "complete" as const,
  };
  tabs.set(12, activated);
  activatedListeners[0]({ tabId: 12, windowId: 1 });

  const created = {
    id: 13,
    url: "https://created.example/report",
    status: "complete" as const,
  };
  tabs.set(13, created);
  createdListeners[0](created);

  await eventually(
    () => [11, 12, 13].every((tabId) => liveTabs.has(tabId)),
    "all eligible lifecycle events should inject and arm their tabs",
  );
  assert.deepEqual(injections.slice().sort((a, b) => a - b), [11, 12, 13]);

  const overlapGate = deferred<void>();
  injectionGates.set(14, overlapGate);
  const overlapping = {
    id: 14,
    url: "https://overlap.example/app",
    status: "complete" as const,
  };
  tabs.set(14, overlapping);
  updatedListeners[0](14, { status: "complete" }, overlapping);
  activatedListeners[0]({ tabId: 14, windowId: 1 });
  createdListeners[0](overlapping);

  await eventually(
    () => injections.filter((tabId) => tabId === 14).length > 0,
    "the overlapping lifecycle operation should begin",
  );
  assert.equal(
    injections.filter((tabId) => tabId === 14).length,
    1,
    "overlapping events must share one injection",
  );
  overlapGate.resolve();
  await eventually(() => liveTabs.has(14), "the shared injection should finish");

  // A later complete event reaches the existing listener instead of injecting
  // another loader into the same document.
  updatedListeners[0](14, { status: "complete" }, overlapping);
  await eventually(
    () => captureMessages.filter((message) => message.tabId === 14).length >= 3,
    "the already-live tab should still receive the current capture state",
  );
  assert.equal(injections.filter((tabId) => tabId === 14).length, 1);
});

test("capture lifecycle ignores unsupported or inactive states and contains injection failures", async () => {
  const unsupported = {
    id: 21,
    url: "chrome://settings/",
    status: "complete" as const,
  };
  tabs.set(21, unsupported);
  updatedListeners[0](21, { status: "complete" }, unsupported);

  const loading = {
    id: 22,
    url: "https://loading.example/app",
    status: "loading" as const,
  };
  tabs.set(22, loading);
  updatedListeners[0](22, { status: "loading" }, loading);

  captureMode = false;
  const inactive = {
    id: 23,
    url: "https://inactive.example/app",
    status: "complete" as const,
  };
  tabs.set(23, inactive);
  createdListeners[0](inactive);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(injections.some((tabId) => [21, 22, 23].includes(tabId)), false);

  captureMode = true;
  blockedTabs.add(24);
  const blocked = {
    id: 24,
    url: "https://blocked.example/app",
    status: "complete" as const,
  };
  tabs.set(24, blocked);
  updatedListeners[0](24, { status: "complete" }, blocked);
  await eventually(
    () => injections.includes(24),
    "a permitted-looking URL should let executeScript perform the permission check",
  );

  const recovery = {
    id: 25,
    url: "https://recovery.example/app",
    status: "complete" as const,
  };
  tabs.set(25, recovery);
  createdListeners[0](recovery);
  await eventually(
    () => liveTabs.has(25),
    "a denied origin must not poison later lifecycle events",
  );

  // executeScript resolves before the loader's dynamic import necessarily
  // installs its listener. That gap must not be mistaken for a reason to inject
  // a second copy; the loader self-arms from persisted state when it mounts.
  delayedLoaderTabs.add(26);
  const delayed = {
    id: 26,
    url: "https://delayed-loader.example/app",
    status: "complete" as const,
  };
  tabs.set(26, delayed);
  updatedListeners[0](26, { status: "complete" }, delayed);
  await eventually(() => injections.includes(26), "the delayed loader should be injected");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(injections.filter((tabId) => tabId === 26).length, 1);
});
