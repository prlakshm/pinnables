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
  /** The shelf asked for these pins' captures on screen — the focus context. */
  summon: SummonMessage | null;
  /** The shelf asked for these pins to leave the screen. */
  dismiss: DismissMessage | null;
  /** A relationship was just created; the page composes its cluster. */
  focusRelationship: FocusRelationshipMessage | null;
  /** The shelf asked for a messaged group's combined bar back. */
  summonGroup: SummonGroupMessage | null;
  /** The panel's relate flow: while set, page clicks pick targets. */
  relateSourcePinId: string | null;
}

type RevealMessage = Extract<Broadcast, { kind: "reveal-pin" }>;
type SummonMessage = Extract<Broadcast, { kind: "summon-pins" }>;
type DismissMessage = Extract<Broadcast, { kind: "dismiss-pins" }>;
type FocusRelationshipMessage = Extract<Broadcast, { kind: "focus-relationship" }>;
type SummonGroupMessage = Extract<Broadcast, { kind: "summon-group" }>;
type RelateModeMessage = Extract<Broadcast, { kind: "relate-mode" }>;

export interface OverlayApi {
  setEnabled(enabled: boolean): void;
  refresh(): void;
  reveal(message: RevealMessage): void;
  summon(message: SummonMessage): void;
  dismiss(message: DismissMessage): void;
  focusRelationship(message: FocusRelationshipMessage): void;
  summonGroup(message: SummonGroupMessage): void;
  relateMode(message: RelateModeMessage): void;
  destroy(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): OverlayState;
}

function createApi(teardown: () => void): OverlayApi {
  let state: OverlayState = {
    enabled: false,
    revision: 0,
    reveal: null,
    summon: null,
    dismiss: null,
    focusRelationship: null,
    summonGroup: null,
    relateSourcePinId: null,
  };
  const listeners = new Set<() => void>();

  const commit = (next: Partial<OverlayState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };

  return {
    setEnabled: (enabled) =>
      commit({
        enabled,
        reveal: enabled ? state.reveal : null,
        summon: enabled ? state.summon : null,
        focusRelationship: enabled ? state.focusRelationship : null,
        summonGroup: enabled ? state.summonGroup : null,
        relateSourcePinId: enabled ? state.relateSourcePinId : null,
      }),
    refresh: () => commit({ revision: state.revision + 1 }),
    reveal: (message) => commit({ reveal: message, revision: state.revision + 1 }),
    summon: (message) => commit({ summon: message, revision: state.revision + 1 }),
    dismiss: (message) => commit({ dismiss: message, revision: state.revision + 1 }),
    focusRelationship: (message) =>
      commit({ focusRelationship: message, revision: state.revision + 1 }),
    summonGroup: (message) => commit({ summonGroup: message, revision: state.revision + 1 }),
    relateMode: (message) => commit({ relateSourcePinId: message.sourcePinId }),
    destroy: teardown,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };
}

export async function mountOverlay(): Promise<OverlayApi> {
  /*
   * A host left behind by a previous script has to go. After an extension
   * reload the old copy is dead but its DOM is not, and two hosts means two
   * toolbars — one of which answers nothing.
   */
  document.getElementById(OVERLAY_HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  host.setAttribute("data-pinnables", "");
  /*
   * Absolute and zero-sized, not fixed.
   *
   * The ink layer is positioned in document coordinates so it scrolls with the
   * page for free — and an absolutely positioned child resolves against its
   * nearest positioned ancestor, so a fixed host would nail the marks to the
   * viewport. Everything that *should* stay put says so itself: `.pin-overlay`
   * and the draw bar are `position: fixed`, which still resolves to the viewport
   * regardless of this element.
   *
   * The host never intercepts pointer events; only the toolbar and pin objects
   * inside it opt back in.
   */
  Object.assign(host.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
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

  /*
   * A render crash unmounts the whole overlay and leaves the page looking
   * like capture simply did nothing — no trace, no error surface of ours.
   * React names the component only through this hook, so log it: the next
   * silent death should be a console read, not an afternoon's hunt.
   */
  const root = createRoot(mountPoint, {
    onUncaughtError: (error, errorInfo) => {
      console.error(
        "[pinnables] overlay render crashed",
        error,
        errorInfo.componentStack ?? "",
      );
    },
  });
  const api = createApi(() => {
    root.unmount();
    host.remove();
  });

  root.render(<OverlayRoot api={api} />);
  return api;
}
