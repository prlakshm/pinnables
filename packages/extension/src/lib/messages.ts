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
  componentName: string | null;
  sourceFile: string | null;
  computedStyles: Record<string, string>;
}

export interface ExtensionState {
  captureMode: boolean;
  activeBoardId: string | null;
  serviceOnline: boolean;
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

  /**
   * Open the side panel for the tab this came from. It has to be the worker that
   * calls `chrome.sidePanel.open` — the API does not exist in a content script,
   * and it needs the window id the content script cannot see.
   */
  "panel/open": { req: Record<string, never>; res: { ok: boolean } };

  "board/get": { req: { boardId?: string }; res: { board: Board | null } };
  "board/list": { req: Record<string, never>; res: { boards: Board[] } };
  "board/create": { req: { title: string }; res: { board: Board } };
  "board/setInstruction": { req: { boardId: string; instruction: string }; res: { board: Board } };
  "board/markReady": {
    req: { boardId: string };
    res: { board: Board; pointer: string; materialized: boolean };
  };

  "pin/update": {
    req: {
      pinId: string;
      patch: Partial<Pick<Pin, "annotation" | "status" | "order" | "groupId" | "styleEdits">>;
    };
    res: { board: Board };
  };
  "pin/delete": { req: { pinId: string }; res: { board: Board } };
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
  | { kind: "reveal-pin"; pinId: string; selector: string; domPath: string; elementText: string };

export function broadcastToTab(tabId: number, message: Broadcast): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    /* No listener in that tab — expected on pages without the content script. */
  });
}
