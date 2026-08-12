import assert from "node:assert/strict";
import test from "node:test";

type InstalledListener = () => void;

const queried: chrome.tabs.QueryInfo[] = [];
const pinged: number[] = [];
const injected: number[] = [];
let onInstalled: InstalledListener | null = null;

const webTabs: chrome.tabs.Tab[] = [
  { id: 1, url: "http://localhost:5180/dashboard", index: 0, pinned: false, highlighted: true, active: true, incognito: false },
  { id: 2, url: "https://example.com/app", index: 1, pinned: false, highlighted: false, active: false, incognito: false },
  { id: 3, url: "https://unpermitted.example/app", index: 2, pinned: false, highlighted: false, active: false, incognito: false },
];

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    runtime: {
      getManifest: () => ({
        content_scripts: [
          {
            matches: ["http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"],
            js: ["assets/content-loader.js"],
          },
        ],
      }),
      onMessage: { addListener: () => {} },
      onInstalled: {
        addListener: (listener: InstalledListener) => {
          onInstalled = listener;
        },
      },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      open: async () => {},
    },
    storage: { local: { remove: async () => {} } },
    tabs: {
      query: async (query: chrome.tabs.QueryInfo) => {
        queried.push(query);
        const urls = Array.isArray(query.url) ? query.url : [query.url];
        const coversAllWeb = urls.includes("http://*/*") && urls.includes("https://*/*");
        return coversAllWeb ? webTabs : webTabs.slice(0, 1);
      },
      sendMessage: async (tabId: number) => {
        pinged.push(tabId);
        if (tabId === 2) return true;
        throw new Error("No receiver");
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    scripting: {
      executeScript: async ({ target }: chrome.scripting.ScriptInjection) => {
        injected.push(target.tabId);
        if (target.tabId === 3) throw new Error("Missing host permission");
        return [];
      },
    },
    action: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
  },
});

await import("../packages/extension/src/background/index.ts");

test("extension reload checks every HTTP(S) tab and safely skips pages it cannot inject", async () => {
  assert.ok(onInstalled, "background should register its installation listener");

  onInstalled();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(queried[0], { url: ["http://*/*", "https://*/*"] });
  assert.deepEqual(pinged, [1, 2, 3]);
  assert.deepEqual(injected, [1, 3]);
});
