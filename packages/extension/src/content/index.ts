import type { Broadcast } from "../lib/messages";

/**
 * Tier 1. This is the only Pinnables code resident on the page until the user
 * activates — a listener and nothing else. No DOM observation, no capture
 * capability, no React. The picker and overlay are a separate chunk fetched on
 * activation, which is what lets "enter capture mode in 200ms" and "no
 * background capture when inactive" both be true.
 *
 * The cost of that split is that the overlay chunk has to be web-accessible to
 * whatever origin the page is on. The bundler derives those matches from
 * `content_scripts`, which is localhost only, so the manifest declares a wider
 * `web_accessible_resources` by hand — otherwise a site reached through an
 * optional host permission would run this file and then fail on the import.
 */

/**
 * The worker injects this script into tabs that were open before the extension
 * loaded, which means a page can end up running two copies — each with its own
 * module scope and so its own idea of whether an overlay exists. A sentinel on
 * the page keeps the first one authoritative and makes the second a no-op.
 */
const SENTINEL = "__pinnablesContentScript";
const globals = globalThis as unknown as Record<string, boolean>;
const alreadyResident = globals[SENTINEL] === true;
globals[SENTINEL] = true;

type Overlay = Awaited<ReturnType<typeof import("./mount").mountOverlay>>;

let overlay: Overlay | null = null;
let loading: Promise<Overlay> | null = null;

async function ensureOverlay(): Promise<Overlay> {
  if (overlay) return overlay;
  if (!loading) {
    loading = import("./mount").then(async (mod) => {
      overlay = await mod.mountOverlay();
      return overlay;
    });
  }
  return loading;
}

if (!alreadyResident) {
  chrome.runtime.onMessage.addListener(listen);

  // A tab opened while capture mode was already on should come up armed. This
  // also covers the injected case, where the worker's message can land before
  // the listener above is registered.
  void chrome.runtime
    .sendMessage({ type: "state/get" })
    .then((res: { ok: boolean; data?: { captureMode: boolean } } | undefined) => {
      if (res?.ok && res.data?.captureMode) void ensureOverlay().then((o) => o.setEnabled(true));
    })
    .catch(() => {});
}

function listen(message: Broadcast) {
  if (message.kind === "capture-mode") {
    if (message.enabled) {
      void ensureOverlay().then((o) => o.setEnabled(true));
    } else {
      overlay?.setEnabled(false);
    }
    return;
  }

  if (message.kind === "board-updated") {
    overlay?.refresh();
    return;
  }

  if (message.kind === "reveal-pin") {
    void ensureOverlay().then((o) => o.reveal(message));
  }
}
