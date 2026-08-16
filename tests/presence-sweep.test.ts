import assert from "node:assert/strict";
import test from "node:test";

/**
 * The shelf's filled pin icon reads per-tab `onScreenPins:*` records. Overlays
 * clear their own record when capture flips — but only a live content script
 * can. These tests pin the background's side of the contract: the capture
 * toggle and browser startup sweep every record, including those whose writer
 * is gone (navigated tab, extension reload, restarted browser reusing ids).
 */

type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

type WireResponse<T> = { ok: true; data: T } | { ok: false; error: string };

let memory: Record<string, unknown> = {};
let backgroundListener: BackgroundListener | null = null;
let startupListener: (() => void) | null = null;

const chromeStub = {
  storage: {
    local: {
      async get(key: string | string[] | null) {
        if (key === null) return structuredClone(memory);
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.map((k) => [k, structuredClone(memory[k])]));
      },
      // Chrome 130+; the sweep prefers it over materializing every value.
      async getKeys() {
        return Object.keys(memory);
      },
      async set(entries: Record<string, unknown>) {
        Object.assign(memory, structuredClone(entries));
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete memory[k];
      },
    },
  },
  runtime: {
    id: "presence-sweep-test",
    getManifest: () => ({ content_scripts: [] }),
    sendMessage: async () => undefined,
    onMessage: {
      addListener(listener: BackgroundListener) {
        backgroundListener = listener;
      },
    },
    onInstalled: { addListener() {} },
    onStartup: {
      addListener(listener: () => void) {
        startupListener = listener;
      },
    },
  },
  tabs: {
    // No tabs: arming is out of scope here, the sweep must not depend on it.
    query: async () => [],
    sendMessage: async () => undefined,
    onRemoved: { addListener() {}, removeListener() {} },
    onUpdated: { addListener() {}, removeListener() {} },
  },
  scripting: { executeScript: async () => [] },
  sidePanel: {
    setPanelBehavior: async () => undefined,
    open: async () => undefined,
  },
  action: { onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeStub as unknown as typeof chrome,
});

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          home: "/tmp",
          cursor: { configured: false, ok: false, detail: "CURSOR_API_KEY not set" },
        }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  },
});

await import("../packages/extension/src/background/index.ts");

function dispatch<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const handled = backgroundListener?.(
      message,
      {} as chrome.runtime.MessageSender,
      (response) => {
        const wire = response as WireResponse<T>;
        if (wire.ok) resolve(wire.data);
        else reject(new Error(wire.error));
      },
    );
    if (!handled) reject(new Error("background listener did not handle the message"));
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "condition never became true");
}

const seeded = () => ({
  state: { captureMode: true },
  // Tab 17 is "live"; 4012 belongs to a tab whose script died before it
  // could clean up. The background cannot tell them apart — both must go.
  "onScreenPins:17": ["pin-a"],
  "onScreenPins:4012": ["pin-b", "pin-c"],
  "overlayFocus:https://app.test": { origin: "https://app.test" },
  "board:b1": { id: "b1" },
  "shot:pin-a": "data:image/png;base64,x",
});

test("turning capture off removes every tab's on-screen record", async () => {
  memory = seeded();
  await dispatch({ type: "capture/setMode", enabled: false });
  assert.ok(!("onScreenPins:17" in memory), "live tab record must be swept");
  assert.ok(!("onScreenPins:4012" in memory), "dead tab record must be swept");
  assert.ok("overlayFocus:https://app.test" in memory, "focus snapshots are not presence");
  assert.ok("board:b1" in memory);
  assert.ok("shot:pin-a" in memory);
  assert.equal((memory.state as { captureMode: boolean }).captureMode, false);
});

test("turning capture on also starts from a clean slate", async () => {
  memory = { ...seeded(), state: { captureMode: false } };
  await dispatch({ type: "capture/setMode", enabled: true });
  assert.ok(!("onScreenPins:17" in memory));
  assert.ok(!("onScreenPins:4012" in memory));
  assert.ok("board:b1" in memory);
});

test("browser startup sweeps records left by the previous session's tab ids", async () => {
  memory = seeded();
  assert.ok(startupListener, "background must register an onStartup listener");
  startupListener?.();
  await until(() => !("onScreenPins:17" in memory) && !("onScreenPins:4012" in memory));
  assert.ok("overlayFocus:https://app.test" in memory);
  assert.ok("board:b1" in memory);
});
