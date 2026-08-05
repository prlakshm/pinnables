import { createRoot } from "react-dom/client";
import css from "../ui/ui.css?inline";
import { OVERLAY_HOST_ID } from "../lib/capture";
import type { Broadcast } from "../lib/messages";
import { OverlayRoot } from "./Overlay";

/**
 * Tier 2. Everything renders inside a shadow root so the host page's CSS can't
 * reach it — without that, a page with aggressive global styles would take our
 * toolbar apart, and this thing has to look identical on every app it floats
 * over.
 */

export interface OverlayState {
  enabled: boolean;
  /** Bumped to force a re-read of board state from the worker. */
  revision: number;
  reveal: RevealMessage | null;
}

type RevealMessage = Extract<Broadcast, { kind: "reveal-pin" }>;

export interface OverlayApi {
  setEnabled(enabled: boolean): void;
  refresh(): void;
  reveal(message: RevealMessage): void;
  destroy(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): OverlayState;
}

function createApi(teardown: () => void): OverlayApi {
  let state: OverlayState = { enabled: false, revision: 0, reveal: null };
  const listeners = new Set<() => void>();

  const commit = (next: Partial<OverlayState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };

  return {
    setEnabled: (enabled) => commit({ enabled, reveal: enabled ? state.reveal : null }),
    refresh: () => commit({ revision: state.revision + 1 }),
    reveal: (message) => commit({ reveal: message, revision: state.revision + 1 }),
    destroy: teardown,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };
}

export async function mountOverlay(): Promise<OverlayApi> {
  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  host.setAttribute("data-pinnables", "");
  // The host itself must never intercept pointer events — only the toolbar and
  // pin objects inside it opt back in.
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    pointerEvents: "none",
  });

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.append(style);

  const mountPoint = document.createElement("div");
  mountPoint.className = "pin-root";
  shadow.append(mountPoint);
  document.documentElement.append(host);

  const root = createRoot(mountPoint);
  const api = createApi(() => {
    root.unmount();
    host.remove();
  });

  root.render(<OverlayRoot api={api} />);
  return api;
}
