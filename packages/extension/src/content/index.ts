import type { Broadcast } from "../lib/messages";
import { OVERLAY_HOST_ID } from "../lib/overlay-host";

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

/*
 * There used to be a sentinel on globalThis here, to stop a page running two
 * copies of this script. It was worse than the problem.
 *
 * An isolated world's globalThis outlives the extension context that wrote to
 * it. Reloading the extension leaves the flag set and the old listener dead, so
 * the fresh copy the worker injects saw "already resident", did nothing, and
 * capture mode turned on to complete silence.
 *
 * The double-injection it guarded cannot actually happen: the worker only
 * injects *after* a sendMessage fails, and a failed sendMessage means nothing is
 * listening. So the guard is gone, and `mountOverlay` clears any stale host so a
 * new script takes the page over cleanly.
 */

type Overlay = Awaited<ReturnType<typeof import("./mount").mountOverlay>>;

let overlay: Overlay | null = null;
let loading: Promise<Overlay> | null = null;
let desiredEnabled = false;
let receivedCaptureMessage = false;

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

/** Apply the latest requested state even when the overlay chunk is still loading. */
async function syncOverlayEnabled(): Promise<void> {
  if (!desiredEnabled) {
    overlay?.setEnabled(false);
    return;
  }
  const current = await ensureOverlay();
  // `desiredEnabled` may have changed while the dynamic import was in flight.
  current.setEnabled(desiredEnabled);
}

/*
 * A dead script's overlay outlives it: the host is plain DOM and nothing
 * removes it when the extension context goes. `mountOverlay` clears it, but
 * only if something mounts — with capture off, the stale toolbar would sit
 * there taking clicks that go nowhere. This script is the live one now, so it
 * takes the page over on arrival rather than on first use.
 */
document.getElementById(OVERLAY_HOST_ID)?.remove();

chrome.runtime.onMessage.addListener(listen);

// A tab opened while capture mode was already on should come up armed. This also
// covers the injected case, where the worker's message can land before the
// listener above is registered.
void chrome.runtime
  .sendMessage({ type: "state/get" })
  .then((res: { ok: boolean; data?: { captureMode: boolean } } | undefined) => {
    // A live capture-mode message is newer than this startup read. Do not let a
    // delayed response turn the overlay back on after the user has switched it
    // off.
    if (receivedCaptureMessage || !res?.ok) return;
    desiredEnabled = Boolean(res.data?.captureMode);
    void syncOverlayEnabled();
  })
  .catch(() => {});

function listen(message: Broadcast | { kind: "ping" }, _sender: unknown, respond: (v: unknown) => void) {
  /*
   * "Are you alive?" — the one message a dead script cannot answer.
   *
   * The worker asks before injecting, so a tab that already has a working
   * script is left alone. Without it, every reload stacked a second loader on
   * top of a live one, and the copies that lost the race threw on a
   * `chrome.runtime` that no longer existed.
   */
  if (message.kind === "ping") {
    respond(true);
    return;
  }

  if (message.kind === "capture-mode") {
    receivedCaptureMessage = true;
    desiredEnabled = message.enabled;
    void syncOverlayEnabled();
    return;
  }

  if (message.kind === "board-updated") {
    overlay?.refresh();
    return;
  }

  if (message.kind === "reveal-pin") {
    void ensureOverlay().then((o) => o.reveal(message));
    return;
  }

  if (message.kind === "summon-pins") {
    void ensureOverlay().then((o) => o.summon(message));
  }
}
