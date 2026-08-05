import type { Broadcast } from "../lib/messages";

/**
 * Tier 1. This is the only Pinnables code resident on the page until the user
 * activates — a listener and nothing else. No DOM observation, no capture
 * capability, no React. The picker and overlay are a separate chunk fetched on
 * activation, which is what lets "enter capture mode in 200ms" and "no
 * background capture when inactive" both be true.
 */

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

chrome.runtime.onMessage.addListener((message: Broadcast) => {
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
});

// A tab opened while capture mode was already on should come up armed.
void chrome.runtime
  .sendMessage({ type: "state/get" })
  .then((res: { ok: boolean; data?: { captureMode: boolean } } | undefined) => {
    if (res?.ok && res.data?.captureMode) void ensureOverlay().then((o) => o.setEnabled(true));
  })
  .catch(() => {});
