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

/** Requests, keyed by type, each paired with its response shape. */
export interface Contract {
  "state/get": { req: Record<string, never>; res: ExtensionState };
  "capture/setMode": { req: { enabled: boolean }; res: ExtensionState };
  "capture/element": { req: { element: CapturedElement }; res: { pin: Pin } };

  /**
   * Freeze the viewport so the user draws on an immutable frame rather than a
   * live page. This is what makes marks safe on animated or reflowing pages —
   * there is nothing left to re-anchor to.
   */
  "capture/freeze": { req: Record<string, never>; res: { frame: string; viewport: Viewport } };
  "capture/discardFreeze": { req: Record<string, never>; res: { ok: boolean } };
  "capture/region": {
    req: {
      shapes: DrawShape[];
      url: string;
      route: string;
      viewport: Viewport;
      label: string;
    };
    res: { pin: Pin };
  };

  "board/get": { req: { boardId?: string }; res: { board: Board | null } };
  "board/list": { req: Record<string, never>; res: { boards: Board[] } };
  "board/create": { req: { title: string }; res: { board: Board } };
  "board/setInstruction": { req: { boardId: string; instruction: string }; res: { board: Board } };
  "board/markReady": {
    req: { boardId: string };
    res: { board: Board; pointer: string; materialized: boolean };
  };

  "pin/update": {
    req: { pinId: string; patch: Partial<Pick<Pin, "annotation" | "status" | "order" | "groupId">> };
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
export async function send<K extends RequestType>(
  type: K,
  payload: Contract[K]["req"] = {} as Contract[K]["req"],
): Promise<Contract[K]["res"]> {
  const res = (await chrome.runtime.sendMessage({ type, ...payload })) as Response<K> | undefined;
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
