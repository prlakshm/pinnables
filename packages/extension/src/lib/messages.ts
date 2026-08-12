import type { Board, DrawShape, Pin, PinStatus, Relationship, Viewport } from "@pinnables/shared";

/**
 * The one message contract shared by the content script, the service worker,
 * and the side panel. Defined before any of the three surfaces so they can't
 * drift — every send goes through `send()` below and is typed end to end.
 */

/** What the content script measures about an element before the worker crops it. */
export interface CapturedElement {
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  url: string;
  route: string;
  viewport: Viewport;
  selector: string;
  domPath: string;
  outerHtml: string;
  classList: string[];
  elementText: string;
  /** See `describeElement` — the element's own best name, for when the build has none. */
  elementLabel: string;
  componentName: string | null;
  sourceFile: string | null;
  computedStyles: Record<string, string>;
}

export interface ExtensionState {
  captureMode: boolean;
  activeBoardId: string | null;
  serviceOnline: boolean;
  /** True when the local service can push to Cursor agents. */
  cursorOnline: boolean;
  /**
   * Cloud Agents live at cursor.com/agents. Local agents edit the project
   * directory on disk — no web URL.
   */
  cursorAgentUrl: string | null;
  /** local = edits this machine's checkout; cloud = remote VM / optional PR. */
  cursorRuntime: "local" | "cloud" | null;
  /** Directory the local agent writes into (PINNABLES_PROJECT_DIR / cwd). */
  cursorProjectDir: string | null;
}

/**
 * Why the overlay is or is not on the tab in front of you.
 *
 * Arming a tab fails in several ordinary ways and every one of them used to
 * fail silently — the button said "Capturing" and the page did nothing, with no
 * way to tell which of them had happened. Naming them is the difference between
 * a broken product and one that says what it needs.
 */
export type TabArmState =
  /** The overlay is up. */
  | "armed"
  /** Nothing was listening, so the script was injected and armed. */
  | "injected"
  /**
   * Nothing was listening and injecting was refused. Almost always a missing
   * host permission: `content_scripts` matches do not grant one, so a tab whose
   * script died with an extension reload cannot be revived without it.
   */
  | "blocked"
  /** chrome://, the Web Store, a PDF. No permission will help. */
  | "unsupported";

/** Requests, keyed by type, each paired with its response shape. */
export interface Contract {
  "state/get": { req: Record<string, never>; res: ExtensionState };
  "capture/setMode": {
    req: { enabled: boolean };
    res: ExtensionState & { activeTab: TabArmState };
  };
  "capture/element": { req: { element: CapturedElement }; res: { pin: Pin } };

  /**
   * Save the marks for a route. Upsert, not create: a route has one region pin
   * and drawing on it edits that pin, which is what makes marks reappear when
   * you navigate back. Sending an empty list deletes it.
   */
  "drawing/save": {
    req: {
      shapes: DrawShape[];
      url: string;
      route: string;
      viewport: Viewport;
      /**
       * Where the marks are in the viewport, for the worker to photograph and
       * crop to. Null when they are scrolled out of view — there is nothing
       * worth a picture, and the previous one is kept.
       */
      shotRect: { x: number; y: number; width: number; height: number } | null;
    };
    res: { pin: Pin | null };
  };

  "board/get": { req: { boardId?: string }; res: { board: Board | null } };
  "board/list": { req: Record<string, never>; res: { boards: Board[] } };
  "board/create": { req: { title: string }; res: { board: Board } };
  "board/setInstruction": { req: { boardId: string; instruction: string }; res: { board: Board } };
  "board/markReady": {
    req: { boardId: string };
    res: {
      board: Board;
      pointer: string;
      materialized: boolean;
      transport: "cursor" | "clipboard";
      messageId: string | null;
      agentId: string | null;
      url: string | null;
    };
  };

  "pin/update": {
    req: {
      pinId: string;
      patch: Partial<Pick<Pin, "annotation" | "status" | "order" | "groupId" | "styleEdits" | "name">>;
    };
    res: { board: Board };
  };
  "pin/delete": { req: { pinId: string }; res: { board: Board } };
  /**
   * Quietly remove a provisional pin whose selection was dismissed unspoken.
   * The worker verifies silence itself — no annotation, sends, drawings,
   * relationships, group or name — so a discard that races a promotion is a
   * safe no-op rather than a lost pin.
   */
  "pin/discardProvisional": { req: { pinId: string }; res: { discarded: boolean } };
  "pin/reorder": { req: { pinId: string; beforePinId: string | null }; res: { board: Board } };
  "pin/setStatus": { req: { pinId: string; status: PinStatus }; res: { board: Board } };
  "pin/revealSource": { req: { pinId: string }; res: { ok: boolean } };

  "relationship/create": {
    req: { sourcePinId: string; targetPinIds: string[] };
    res: { board: Board; relationship: Relationship };
  };
  "relationship/update": {
    req: { relationshipId: string; patch: Partial<Pick<Relationship, "properties" | "exception" | "instruction" | "targetPinIds">> };
    res: { board: Board };
  };
  "relationship/delete": { req: { relationshipId: string }; res: { board: Board } };

  /**
   * Empty the board — every pin, every relationship, every screenshot. One
   * message rather than a loop of deletes from the panel, so a board half-
   * cleared by a worker that went to sleep is not a state that can exist.
   */
  "board/clear": { req: { boardId: string }; res: { board: Board } };

  /**
   * Put back what the last clear removed. Clearing is a single click now, so
   * this is the safety net: the worker stashes the cleared board and holds its
   * screenshots until the next clear overwrites the slot. Fails once new pins
   * exist — undo must never destroy work that happened after the clear.
   */
  "board/undoClear": { req: { boardId: string }; res: { board: Board } };

  /**
   * Deliver one message to an agent right now — spawn-per-message, via the
   * local service. The worker gathers the pins' context and screenshots; the
   * service writes them to disk and starts a headless agent run. The returned
   * id is what `agent/status` polls. Throws when the service is offline, which
   * the dialog reports as "no agent connected" rather than pretending.
   */
  "agent/send": {
    req: {
      text: string;
      pinIds: string[];
      relationshipId?: string;
      /** Marks the strokes flushed with this message — see DrawShape.ownerPinId. */
      drawingSummary?: string;
      /**
       * The messageId this send replaces. A resent message supersedes its
       * failed ancestor in the pins' history — one intention, one entry.
       */
      resendOf?: string;
    };
    res: { messageId: string; url: string | null; state: "queued" | "starting" | "working" };
  };

  /** Where a live message stands. Every state is verifiable, never guessed. */
  "agent/status": {
    req: { messageId: string };
    res: {
      state: "queued" | "starting" | "working" | "done" | "failed";
      detail: string | null;
      url?: string;
    };
  };

  /**
   * Record where a live run stands on the pins that sent it, so the message's
   * tag can resolve — and survive the surface that happened to be polling.
   * Written to the board because how the run is going is a fact about the
   * message, not about whichever bar was open at the time. "working" is
   * recorded the moment the service confirms the agent started.
   */
  "agent/recordOutcome": {
    req: { messageId: string; state: "starting" | "working" | "done" | "failed" };
    res: Record<string, never>;
  };

  /**
   * Put a pin's capture (or a relationship's whole cluster) on screen as the
   * single focus context. Navigates the active tab to the pin's page first
   * when needed — same delivery machinery as pin/revealSource.
   */
  /**
   * Open the side panel from the page. Chrome only honours sidePanel.open()
   * while the click's user gesture is still live, so the worker answers this
   * one before it awaits anything.
   */
  "panel/open": { req: Record<string, never>; res: { ok: boolean } };

  /**
   * Which tab am I? A content script cannot ask Chrome directly, and it needs
   * an answer because what is on screen is a fact about one tab — see
   * `onScreenPinsKey`.
   */
  "tab/whoami": { req: Record<string, never>; res: { tabId: number | null } };
  "pin/summon": { req: { pinId: string }; res: { ok: boolean } };
  /**
   * A multi-selection that received a message becomes a group — that is the
   * moment it stops being an ephemeral gesture and starts being a
   * conversation worth reopening. Members already sharing a group keep it;
   * otherwise the newest grouping wins.
   */
  "group/record": { req: { pinIds: string[] }; res: { groupId: string } };
  /** Put the whole group back on screen as the live multi-selection. */
  "group/summon": { req: { groupId: string }; res: { ok: boolean } };
  /**
   * The panel's relate flow, mirrored to the page. While a source is set,
   * page clicks pick targets instead of selecting — the live page becomes
   * the same picker the shelf rows are. Null ends the mode.
   */
  "relate/setMode": { req: { sourcePinId: string | null }; res: Record<string, never> };
  /**
   * The other half of the shelf pin's toggle: take this pin's capture off the
   * page (and defocus it, if it was the live selection). No navigation — a
   * pin that is on screen is on the active tab by definition.
   */
  "pin/dismiss": { req: { pinId: string }; res: { ok: boolean } };
  "relationship/summon": { req: { relationshipId: string }; res: { ok: boolean } };

  /**
   * Follow a relationship to one of its pins' own pages — the off-page target
   * chip. Navigates there and recomposes the relationship's focus context, so
   * the pin that was a stale capture here becomes the live selection there.
   */
  "relationship/open": {
    req: { relationshipId: string; atPinId: string };
    res: { ok: boolean };
  };
}

export type RequestType = keyof Contract;

export type Message<K extends RequestType = RequestType> = {
  [T in K]: { type: T } & Contract[T]["req"];
}[K];

export type Response<K extends RequestType> =
  | { ok: true; data: Contract[K]["res"] }
  | { ok: false; error: string };

/** Typed sender used by the side panel and the content script. */
/**
 * Thrown when the extension was reloaded or updated while this content script
 * was still live in the page. The script keeps running but its bridge to the
 * extension is gone, so every message from here on fails.
 *
 * There is no recovery from inside the page — only a reload re-injects a script
 * bound to the new context — so callers should surface this rather than retry.
 */
export class ExtensionReloadedError extends Error {
  constructor() {
    super("Pinnables was reloaded. Refresh the page to continue.");
    this.name = "ExtensionReloadedError";
  }
}

/**
 * `chrome.runtime.id` reads undefined once the context is torn down, which is
 * the only reliable check available before attempting a call.
 */
export function isContextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

const RELOADED_PATTERNS = [
  "Extension context invalidated",
  "Receiving end does not exist",
  "message port closed",
];

export async function send<K extends RequestType>(
  type: K,
  payload: Contract[K]["req"] = {} as Contract[K]["req"],
): Promise<Contract[K]["res"]> {
  if (!isContextAlive()) throw new ExtensionReloadedError();

  let res: Response<K> | undefined;
  try {
    res = (await chrome.runtime.sendMessage({ type, ...payload })) as Response<K> | undefined;
  } catch (err) {
    // Chrome reports a torn-down context as a generic Error whose message is
    // the only thing distinguishing it, so match on the text.
    const message = err instanceof Error ? err.message : String(err);
    if (RELOADED_PATTERNS.some((p) => message.includes(p))) throw new ExtensionReloadedError();
    throw err;
  }

  if (!res) throw new Error(`No response from background for "${type}"`);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Worker → content-script and worker → panel broadcasts. */
export type Broadcast =
  | { kind: "capture-mode"; enabled: boolean }
  | { kind: "board-updated"; boardId: string }
  | { kind: "reveal-pin"; pinId: string; selector: string; domPath: string; elementText: string }
  /**
   * Show these pins' captures as the one focus context on screen. Carries the
   * whole cluster at once so a relationship summon is a single state change,
   * not a race of per-pin messages.
   */
  | { kind: "summon-pins"; pinIds: string[] }
  /** Take these pins off the page; live selections among them defocus. */
  | { kind: "dismiss-pins"; pinIds: string[] }
  /**
   * Reopen a messaged multi-selection: live-select every member on its route
   * so the combined annotation bar returns with the group's shared history.
   */
  | { kind: "summon-group"; pinIds: string[] }
  /** The panel's target-picking state, on or off, mirrored to every page. */
  | { kind: "relate-mode"; sourcePinId: string | null }
  /** A page click picked this pin as a relate target; the panel toggles it. */
  | { kind: "relate-picked"; pinId: string }
  /**
   * A relationship was just created, whichever surface did it. The panel
   * opens the Relationships tab scrolled to this card; the page puts the
   * source up as a capture and live-selects the targets on its route.
   */
  | { kind: "focus-relationship"; relationshipId: string };

export function broadcastToTab(tabId: number, message: Broadcast): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    /* No listener in that tab — expected on pages without the content script. */
  });
}
