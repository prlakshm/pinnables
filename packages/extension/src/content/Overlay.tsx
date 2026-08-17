import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_DRAW_COLOR,
  STYLE_INITIAL_VALUES,
  applicabilityGuard,
  describeDrawings,
  expandProperties,
  isLocalUrl,
  isPinOnPage,
  pinLabel,
  sourceLabel,
  type Board,
  type DrawShape,
  type Pin,
  type Relationship,
} from "@pinnables/shared";
import {
  OVERLAY_HOST_ID,
  maskSensitive,
  measureElement,
  refindElement,
  routeForLocation,
} from "../lib/capture";
import { isLostLiveSendError, pendingLiveSendIds, recordableLiveSendState } from "../lib/live-send";
import { ExtensionReloadedError, send, type Broadcast, type Contract } from "../lib/messages";
import { onScreenPinsKey, overlayFocusKey } from "../lib/presence";
import { CloseIcon } from "../ui/icons";
import type { OverlayApi } from "./mount";
import { Toolbar, type DrawTool, type ToolMode } from "./Toolbar";
import { PinObject } from "./PinObject";
import { Composer } from "./Composer";
import { resetChordHint, SelectionDialog } from "./SelectionDialog";
import { VersionLayer } from "./VersionRail";
import { DrawLayer } from "./DrawLayer";
import {
  createDrawingSaveCoordinator,
  type DrawingSaveCoordinator,
} from "./drawing-save";
import { InkLayer, placeShapes, shapeBox, usePlacedShapes, type Box } from "./InkLayer";
import {
  placeFloatingPinBeside,
  placeGroupComposer,
  shouldRevealForCapture,
  unionBoxes,
} from "./overlay-geometry";
import {
  placeSelectionChrome,
  type BoxSeat,
  type ChromePlacement,
  type RailSeat,
} from "./chrome-placement";
import { defaultEdgeFor, detectScheme, watchScheme, type AnchorEdge, type Scheme } from "../ui/theme";

interface HighlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  /**
   * The element's own border-radius, so the outline traces the thing rather
   * than imposing a shape on it. A fixed radius is wrong twice: square corners
   * on a rounded card leave four visible gaps, and rounded corners on a table
   * cut the corners off. Tracing is never wrong, and it removes the question of
   * what radius the picker "should" have.
   */
  radius: string;
}

export interface FloatPosition {
  x: number;
  y: number;
}

interface OverlayOperationError {
  title: string;
  detail: string;
}

/** Never turn an empty-page click into a viewport-sized pin. */
export function isCapturablePageElement(
  element: Element | null,
  roots: Pick<Document, "documentElement" | "body"> = document,
): element is Element {
  return Boolean(element && element !== roots.documentElement && element !== roots.body);
}

/**
 * A keyboard-generated click reports (0, 0), which is the top-left page pixel,
 * not the control the person intentionally focused. Pointer clicks still use
 * hit-testing; keyboard activation uses the browser's focus owner exclusively.
 */
export function pickerTargetForActivation(
  event: Pick<MouseEvent, "detail" | "clientX" | "clientY">,
  roots: Pick<
    Document,
    "activeElement" | "elementFromPoint" | "documentElement" | "body"
  > = document,
): Element | null {
  if (event.detail === 0) {
    const focused = roots.activeElement;
    return isCapturablePageElement(focused, roots) ? focused : null;
  }
  const pointed = roots.elementFromPoint(event.clientX, event.clientY);
  return isCapturablePageElement(pointed, roots) ? pointed : null;
}

function operationFailure(
  title: string,
  context: string,
  error: unknown,
): OverlayOperationError {
  const detail = error instanceof Error && error.message.trim() ? ` ${error.message}` : "";
  return { title, detail: `${context}${detail}` };
}

/** UI surfaces whose pointer gestures must preserve the current pin selection. */
export function isPinSelectionOwner(classList: Pick<DOMTokenList, "contains">): boolean {
  return classList.contains("pin-object") || classList.contains("pin-note--floating");
}

interface Point {
  x: number;
  y: number;
}

interface Connecting {
  fromPinId: string;
  fromEdge: AnchorEdge;
  cursor: Point;
  /** The live component under the cursor, highlighted as the drop candidate. */
  target: HighlightBox | null;
}

/**
 * The wire being dragged from a live element toward its target-to-be. The pin
 * itself is the cursor: a thumbnail of the source rides the pointer, and the
 * component under it highlights as the candidate target.
 */
interface LiveConnect {
  fromPinId: string;
  cursor: Point;
  /** Small capture image riding the cursor; null until storage answers. */
  thumb: string | null;
  /** The candidate target under the pointer, highlighted gray. */
  target: HighlightBox | null;
}

/** A live-selected element, measured for its outline, anchor, and wires. */
interface LiveRect {
  rect: DOMRect;
  radius: string;
  label: string;
}

const posKey = (pinId: string) => `pos:${pinId}`;

/** Stable identity for the exact set of pins whose positions should be loaded. */
export function positionScopeKey(board: Board | null): string {
  if (!board) return "";
  return JSON.stringify([board.id, board.pins.map((pin) => pin.id).sort()]);
}

/** Read only the current board's valid positions from a storage result. */
export function storedPositionsForBoard(
  board: Board,
  bag: Record<string, unknown>,
): Record<string, FloatPosition> {
  const positions: Record<string, FloatPosition> = {};
  for (const pin of board.pins) {
    const value = bag[posKey(pin.id)] as Partial<FloatPosition> | undefined;
    if (
      value &&
      typeof value.x === "number" &&
      Number.isFinite(value.x) &&
      typeof value.y === "number" &&
      Number.isFinite(value.y)
    ) {
      positions[pin.id] = { x: value.x, y: value.y };
    }
  }
  return positions;
}

/**
 * Reconcile an async storage read with newer in-memory movement.
 *
 * Within one board the in-memory value wins: a newly captured pin can be
 * persisted while an earlier get is still in flight. Across boards it must not
 * win, even if two boards happen to contain the same pin id.
 */
export function mergeStoredPositionsForBoard(
  board: Board,
  bag: Record<string, unknown>,
  current: Record<string, FloatPosition>,
  preserveCurrent: boolean,
): Record<string, FloatPosition> {
  const next = storedPositionsForBoard(board, bag);
  if (!preserveCurrent) return next;
  for (const pin of board.pins) {
    if (current[pin.id]) next[pin.id] = current[pin.id];
  }
  return next;
}

/** Prune state that refers to pins no longer present on the active board. */
export function retainExistingPinIds(ids: string[], pins: readonly Pin[]): string[] {
  const valid = new Set(pins.map((pin) => pin.id));
  const retained = ids.filter((id) => valid.has(id));
  return retained.length === ids.length ? ids : retained;
}

/**
 * Focus context survives a page reload (Vite HMR after a live edit). The overlay
 * is a content script: a new document is a new React tree, so selection has to
 * live in extension storage, not in component state. See `overlayFocusKey` for
 * why the key carries the origin.
 */
export interface OverlayFocusSnapshot {
  origin: string;
  route: string;
  liveSelected: string[];
  focusCards: string[];
  selected: string[];
}

export function overlayFocusLocation(): { origin: string; route: string } {
  return { origin: location.origin, route: routeForLocation() };
}

/**
 * The same question as `onThisPage`, asked of the live document rather than of
 * the rendered route. Callbacks that fire on the same tick as a navigation run
 * before React has the new route, and seating a card against a stale one puts
 * it on the wrong page.
 */
export function pinIsHereNow(pin: Pin): boolean {
  return isPinOnPage(pin, overlayFocusLocation());
}

export function applyOverlayFocusSnapshot(
  snapshot: OverlayFocusSnapshot | null | undefined,
  pins: readonly Pin[],
  here: { origin: string; route: string },
): OverlayFocusSnapshot | null {
  if (!snapshot || overlayFocusRestoreDecision(snapshot, here) !== "apply") return null;
  const next: OverlayFocusSnapshot = {
    origin: snapshot.origin,
    route: snapshot.route,
    liveSelected: retainExistingPinIds(snapshot.liveSelected, pins),
    focusCards: retainExistingPinIds(snapshot.focusCards, pins),
    selected: retainExistingPinIds(snapshot.selected, pins),
  };
  if (
    next.liveSelected.length === 0 &&
    next.focusCards.length === 0 &&
    next.selected.length === 0
  ) {
    return null;
  }
  return next;
}

export type OverlayFocusRestoreDecision = "apply" | "wait" | "skip";

/**
 * A live edit often reloads before the SPA has the stored route. Consuming
 * the snapshot there would mark focus ready and persist an empty selection.
 */
export function overlayFocusRestoreDecision(
  snapshot: OverlayFocusSnapshot | null | undefined,
  here: { origin: string; route: string },
): OverlayFocusRestoreDecision {
  if (!snapshot) return "skip";
  if (snapshot.origin !== here.origin) return "skip";
  if (snapshot.route !== here.route) return "wait";
  return "apply";
}

export function shouldPersistOverlayFocus(
  snapshot: OverlayFocusSnapshot,
  dismissed: boolean,
): boolean {
  if (
    snapshot.liveSelected.length > 0 ||
    snapshot.focusCards.length > 0 ||
    snapshot.selected.length > 0
  ) {
    return true;
  }
  return dismissed;
}

/**
 * Drop ids only once this board has shown them and then lost them. A pin
 * created this click is not in a racing `recordOutcome` snapshot yet.
 */
export function retainFocusIds(
  ids: string[],
  pins: readonly Pin[],
  seenPinIds: ReadonlySet<string>,
): string[] {
  const valid = new Set(pins.map((pin) => pin.id));
  const retained = ids.filter((id) => valid.has(id) || !seenPinIds.has(id));
  return retained.length === ids.length ? ids : retained;
}

/** Keep last-known boxes for pins still selected but missing from this pass. */
export function holdLiveRects<T>(
  previous: Record<string, T>,
  selectedIds: readonly string[],
  measured: Record<string, T>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const id of selectedIds) {
    if (measured[id]) next[id] = measured[id];
    else if (previous[id]) next[id] = previous[id];
  }
  return next;
}

/**
 * Hide only the overlay chrome that would land inside the crop.
 *
 * The screenshot is of the whole viewport but only the element's rect is kept,
 * so the single thing that must not be photographed is whatever overlaps that
 * rect. Hiding the entire host instead made every capture blink the labels,
 * cards and bars off and back on — the flicker you see when a selection becomes
 * a source or gains a second member. Wires are checked path by path, since
 * their SVG spans the viewport while the lines themselves rarely cross the
 * crop.
 */
function maskOverlayForCapture(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): () => void {
  const root = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot;
  if (!root) return () => {};
  const hits = (box: { left: number; top: number; right: number; bottom: number }) =>
    box.right > rect.x &&
    box.left < rect.x + rect.width &&
    box.bottom > rect.y &&
    box.top < rect.y + rect.height;

  const hidden: HTMLElement[] = [];
  const consider = (node: Element) => {
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return;
    const overlaps =
      node instanceof SVGSVGElement
        ? [...node.querySelectorAll("path, circle")].some((mark) =>
            hits(mark.getBoundingClientRect()),
          )
        : hits(node.getBoundingClientRect());
    if (!overlaps) return;
    const el = node as HTMLElement;
    el.style.visibility = "hidden";
    hidden.push(el);
  };

  root.querySelectorAll(".pin-overlay > *").forEach(consider);
  // Document-space layers (ink, draw surface) live outside .pin-overlay.
  root.querySelectorAll(".pin-ink, .pin-draw").forEach(consider);

  return () => {
    for (const el of hidden) el.style.visibility = "";
  };
}

/** Claim one reveal message by object identity; a fresh request may target the same pin. */
export function claimRevealRequest<T extends object>(
  handled: { current: T | null },
  request: T,
): boolean {
  if (handled.current === request) return false;
  handled.current = request;
  return true;
}

/** Relationship styles applied to the live DOM target while its diff is ticked. */
export function computeLivePreviews(board: Board): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const relationship of board.relationships) {
    const source = board.pins.find((pin) => pin.id === relationship.sourcePinId);
    if (!source) continue;
    const wanted = expandProperties(relationship.properties);
    if (wanted.length === 0) continue;

    for (const targetId of relationship.targetPinIds) {
      const target = board.pins.find((pin) => pin.id === targetId);
      if (!target) continue;
      const styles = map.get(targetId) ?? {};
      const applicable = applicabilityGuard(source, target);

      for (const property of wanted) {
        if (!applicable(property).applicable) continue;
        const value = source.computedStyles[property] ?? STYLE_INITIAL_VALUES[property];
        const targetValue = target.computedStyles[property] ?? STYLE_INITIAL_VALUES[property];
        if (value === undefined || targetValue === value) continue;
        styles[property] = value;
      }
      if (Object.keys(styles).length > 0) map.set(targetId, styles);
    }
  }
  return map;
}

function HighlightOutline({ highlight }: { highlight: HighlightBox }) {
  return (
    <div
      className="pin-highlight"
      // The label rides above the box, except when the box is already at the
      // top of the viewport and there is nowhere above to ride.
      data-label={highlight.y < 22 ? "inside" : "above"}
      style={{
        left: highlight.x,
        top: highlight.y,
        width: highlight.width,
        height: highlight.height,
        borderRadius: highlight.radius,
      }}
    >
      <span className="pin-highlight__label">{highlight.label}</span>
    </div>
  );
}

/** One shared empty array, so "no marks" is a stable dependency. */
const NO_SHAPES: DrawShape[] = [];

/** The midpoint of one edge of a rect, in viewport coordinates. */
function edgePoint(rect: DOMRect, edge: AnchorEdge): Point {
  switch (edge) {
    case "left":
      return { x: rect.left, y: rect.top + rect.height / 2 };
    case "right":
      return { x: rect.right, y: rect.top + rect.height / 2 };
    case "top":
      return { x: rect.left + rect.width / 2, y: rect.top };
    case "bottom":
      return { x: rect.left + rect.width / 2, y: rect.bottom };
  }
}

/**
 * A smooth connector between two points. Control points push out along the
 * dominant axis so the curve leaves an edge perpendicular to it, the way a
 * node-graph wire does — a straight line between two cards reads as a stray
 * rule, a curve reads as a link.
 */
function wirePath(a: Point, b: Point): string {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  /*
   * The bow never reaches past the run's midpoint. A fixed minimum used to
   * push the control points of adjacent cards' wires through each other,
   * kinking a 40px hop into an S — short runs now pull nearly taut, and only
   * long ones get the full node-graph swing.
   */
  const along = Math.max(dx, dy);
  const bow = Math.min(120, Math.max(10, along / 2));
  const horizontal = dx >= dy;
  const c1 = horizontal ? { x: a.x + (b.x > a.x ? bow : -bow), y: a.y } : { x: a.x, y: a.y + (b.y > a.y ? bow : -bow) };
  const c2 = horizontal ? { x: b.x + (b.x > a.x ? -bow : bow), y: b.y } : { x: b.x, y: b.y + (b.y > a.y ? -bow : bow) };
  return `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
}

/** The edge pair that gives the shortest run between two rects. */
function bestEdges(a: DOMRect, b: DOMRect): [AnchorEdge, AnchorEdge] {
  if (b.left > a.right - 8) return ["right", "left"];
  if (b.right < a.left + 8) return ["left", "right"];
  return b.top > a.top ? ["bottom", "top"] : ["top", "bottom"];
}

export function OverlayRoot({ api }: { api: OverlayApi }) {
  const state = useSyncExternalStore(api.subscribe, api.snapshot);
  const [mode, setMode] = useState<ToolMode>("pin");
  const [drawTool, setDrawTool] = useState<DrawTool>("draw");
  const [drawColor, setDrawColor] = useState<string>(DEFAULT_DRAW_COLOR);
  const [board, setBoard] = useState<Board | null>(null);
  const [highlight, setHighlight] = useState<HighlightBox | null>(null);
  const [positions, setPositions] = useState<Record<string, FloatPosition>>({});
  /*
   * The one focus context, in two halves.
   *
   * `liveSelected` are pins whose LIVE page elements are selected — outline,
   * anchors and the chat dialog attach to the real component, order kept
   * because the first is the reference. `focusCards` are pins showing as
   * floating captures — a summoned receipt, or a relationship source that
   * stays on screen because it is wired to the live target. Everything else
   * lives only on the shelf. One context at a time: starting a new one
   * replaces the old, and nothing here deletes a pin.
   */
  const [liveSelected, setLiveSelected] = useState<string[]>([]);
  const [focusCards, setFocusCards] = useState<string[]>([]);
  const [liveRects, setLiveRects] = useState<Record<string, LiveRect>>({});
  const [liveConnect, setLiveConnect] = useState<LiveConnect | null>(null);
  /** A version restore in flight — the rail and the chat keys go quiet. */
  const [versionBusy, setVersionBusy] = useState(false);
  /** Whether minting can be honoured (needs a git tree). The rail
      still shows stored keys while this is false, and restore still runs. */
  const [versionsOk, setVersionsOk] = useState(false);
  /** Live measurements, fed to the placement module each pass. */
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  const [railSize, setRailSize] = useState<{ width: number; height: number } | null>(null);
  /** Seats are sticky: the module keeps these while they stay legal. */
  const [preferredSeats, setPreferredSeats] = useState<{ box: BoxSeat | null; rail: RailSeat | null }>({
    box: null,
    rail: null,
  });
  /** Viewport position of the box while the user is dragging it. */
  const [boxDragPos, setBoxDragPos] = useState<{ x: number; y: number } | null>(null);
  /** Seam scoot while a rail drag is live; the module's value rules at rest. */
  const [liveScoot, setLiveScoot] = useState(0);
  const dialogObserver = useRef<ResizeObserver | null>(null);

  /*
   * The box measures itself. Its height is an input to the ladder — an
   * "above" seat is bottom-anchored, so it can only be placed once its real
   * height is known, and it changes as history rows arrive.
   */
  const onDialogRootEl = useCallback((el: HTMLDivElement | null) => {
    dialogObserver.current?.disconnect();
    dialogObserver.current = null;
    if (!el) return;
    const measure = () =>
      setBoxSize((prev) =>
        prev && prev.width === el.offsetWidth && prev.height === el.offsetHeight
          ? prev
          : { width: el.offsetWidth, height: el.offsetHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    dialogObserver.current = observer;
  }, []);

  useEffect(() => () => dialogObserver.current?.disconnect(), []);
  /** The open chapter — the commit the project stands on. Keys and rows
      stamped with an earlier head keep their words and go quiet. */
  const [projectHead, setProjectHead] = useState<string | null>(null);
  const [justPinned, setJustPinned] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<OverlayOperationError | null>(null);
  const [stale, setStale] = useState(false);
  /**
   * Ordered, because the first selected pin is the reference when relating a
   * group and the last is the one that renders the composer.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [cardRects, setCardRects] = useState<Record<string, DOMRect>>({});
  const [scheme, setScheme] = useState<Scheme>(() => detectScheme());
  const [domRevision, setDomRevision] = useState(0);
  /**
   * Which page we are on, watched rather than read once.
   *
   * Marks belong to a route, and a single-page app changes route without ever
   * reloading — so nothing would tell us to swap them. History is patched
   * because pushState and replaceState fire no event of their own.
   */
  const [route, setRoute] = useState(() => routeForLocation());
  /**
   * This page, origin included. Route alone answered "is this pin mine?" while
   * every page was the one dev server; a capture from vercel.com has route `/`
   * and so does every other site's homepage. See `isPinOnPage`.
   */
  const here = useMemo(() => ({ origin: location.origin, route }), [route]);
  /** Against the rendered route. For callbacks that run ahead of it, see `pinIsHereNow`. */
  const onThisPage = useCallback(
    (pin: Pin | undefined) => (pin === undefined ? false : isPinOnPage(pin, here)),
    [here],
  );
  /** Which tab this is, from the background — Chrome never tells the page. */
  const [tabId, setTabId] = useState<number | null>(null);
  const hovered = useRef<Element | null>(null);
  const pressStartedInOurs = useRef(false);
  const captureStartedOnPress = useRef(false);
  const hoverAnchor = useRef<{ pinId: string; edge: AnchorEdge } | null>(null);
  const handledReveal = useRef<typeof state.reveal>(null);
  const handledSummon = useRef<typeof state.summon>(null);
  const handledDismiss = useRef<typeof state.dismiss>(null);
  const handledFocusRelationship = useRef<typeof state.focusRelationship>(null);
  const handledSummonGroup = useRef<typeof state.summonGroup>(null);
  /** Set when this page composed the cluster itself; its own echo is skipped. */
  const suppressFocusRelationshipId = useRef<string | null>(null);
  /** A creation waiting for its board refresh; user action abandons it. */
  const pendingFocusRelationship = useRef<string | null>(null);
  const revealCleanup = useRef<(() => void) | null>(null);
  const stateBoardId = useRef<string | null>(null);
  const positionBoardId = useRef<string | null>(null);
  /** Synchronous capture lock — see the guard inside `capture`. */
  const captureBusy = useRef(false);
  /** The element the live-connect pointer is currently over, when capturable. */
  const liveConnectTarget = useRef<Element | null>(null);
  /** The source element during live connect, so it can't target itself. */
  const liveConnectSource = useRef<Element | null>(null);
  /** Latest selection, for callbacks that must not rebuild per keystroke. */
  const liveSelectedRef = useRef<string[]>([]);
  const visibleShapesRef = useRef<DrawShape[]>(NO_SHAPES);
  /** False until a stored focus snapshot has been applied or ruled out. */
  const focusReady = useRef(false);
  /** True when the user cleared focus; empty snapshots may then overwrite storage. */
  const focusDismissed = useRef(false);
  /** Pin ids this board has already presented — in-flight captures are absent. */
  const seenPinIds = useRef(new Set<string>());
  /** Last DOM mutation, so a hot-reload swap is not treated as a click-outside. */
  const lastDomMutationAt = useRef(0);

  useEffect(
    () => () => {
      revealCleanup.current?.();
    },
    [],
  );

  /** The overlay and shelf follow the browser/OS scheme as one product. */
  useEffect(() => {
    const root = document
      .getElementById(OVERLAY_HOST_ID)
      ?.shadowRoot?.querySelector<HTMLElement>(".pin-root");
    root?.setAttribute("data-scheme", scheme);
  }, [scheme]);

  useEffect(() => watchScheme(setScheme), []);

  // Each capture session gets one fresh chord lesson in the annotation bar.
  useEffect(() => {
    if (state.enabled) resetChordHint();
  }, [state.enabled]);

  /*
   * Arming always begins visible. If anything ever aborts a capture between
   * hide and restore — a crash, a torn-down context — the stuck-invisible
   * overlay must not survive into the next session.
   */
  useEffect(() => {
    if (!state.enabled) return;
    const host = document.getElementById(OVERLAY_HOST_ID);
    if (host) host.style.visibility = "";
  }, [state.enabled]);

  /**
   * Ask which tab this is, once. A content script has no way to find out for
   * itself, and `onScreenPinsKey` needs the answer before the shelf can be told
   * anything true about what is in front of the user.
   */
  useEffect(() => {
    let cancelled = false;
    void send("tab/whoami", {})
      .then(({ tabId: id }) => {
        if (!cancelled && id !== null) setTabId(id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Whether minting can work — the service needs a git tree —
      and which chapter is open. Asked when the overlay arms and again on
      every selection change. The rail itself does not wait on this: stored
      keys show as soon as the element is re-found, and a visible key still
      restores even when this probe timed out. */
  const selectionKey = liveSelected.join(" ");
  useEffect(() => {
    if (!state.enabled) return;
    let cancelled = false;
    void send("state/get", {})
      .then((s) => {
        if (cancelled) return;
        setVersionsOk(s.versionsOk);
        setProjectHead(s.projectHead ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.enabled, selectionKey]);

  useEffect(() => {
    const read = () => setRoute(routeForLocation());
    const patch = (name: "pushState" | "replaceState") => {
      const original = history[name];
      history[name] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        read();
        return result;
      };
      return () => {
        history[name] = original;
      };
    };
    const undo = [patch("pushState"), patch("replaceState")];
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    return () => {
      undo.forEach((fn) => fn());
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
    };
  }, []);

  /**
   * Reloading the extension leaves this script running in the page with a dead
   * bridge to it. Nothing here can recover — only a page reload re-injects a
   * script bound to the new context — so callers funnel failures through here.
   */
  const guard = useCallback((err: unknown) => {
    if (err instanceof ExtensionReloadedError) {
      setStale(true);
      return true;
    }
    return false;
  }, []);

  /*
   * Frameworks routinely replace a component node without changing the board.
   * Re-run DOM binding once per frame when that happens. Attributes are
   * deliberately excluded: relationship previews write inline styles and must
   * not create their own observer loop.
   */
  useEffect(() => {
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      lastDomMutationAt.current = Date.now();
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setDomRevision((revision) => revision + 1);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  /*
   * History tags live on the pin. The bar that sent the message may already
   * be gone (another component selected), so the overlay watches every
   * in-flight send on the board and records starting/working/done itself.
   *
   * Keyed by message id, not the board object: recording Working rewrites
   * the board and must not cancel the poll that still owes Done to an
   * earlier send. A later Send while the first is Working is the same list
   * plus a new id — both keep ticking until they settle.
   */
  const pendingLiveKey = board ? pendingLiveSendIds(board.pins).join("\0") : "";
  useEffect(() => {
    if (!pendingLiveKey) return;
    const pending = pendingLiveKey.split("\0");
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      for (const messageId of pending) {
        if (cancelled) return;
        try {
          const status = await send("agent/status", { messageId });
          if (cancelled) return;
          const recorded = recordableLiveSendState(status.state);
          if (recorded) {
            await send("agent/recordOutcome", { messageId, state: recorded });
          }
        } catch (err) {
          if (isLostLiveSendError(err)) {
            await send("agent/recordOutcome", { messageId, state: "failed" }).catch(() => {});
          }
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 2_500);
    };
    timer = window.setTimeout(() => void tick(), 400);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pendingLiveKey]);

  /* ------------------------------------------------------------- board sync */

  useEffect(() => {
    let cancelled = false;
    void send("board/get", {})
      .then(({ board: next }) => {
        if (!cancelled) setBoard(next);
      })
      .catch((err) => {
        if (!cancelled) guard(err);
      });
    return () => {
      cancelled = true;
    };
  }, [state.revision, guard]);

  const positionScope = positionScopeKey(board);

  useEffect(() => {
    if (!board) {
      positionBoardId.current = null;
      setPositions({});
      return;
    }
    let cancelled = false;
    const currentBoard = board;
    const preserveCurrent = positionBoardId.current === currentBoard.id;
    positionBoardId.current = currentBoard.id;
    const keys = currentBoard.pins.map((pin) => posKey(pin.id));
    if (!preserveCurrent) setPositions({});
    void chrome.storage.local.get(keys).then((bag) => {
      if (cancelled) return;
      setPositions((current) =>
        mergeStoredPositionsForBoard(currentBoard, bag, current, preserveCurrent),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [positionScope]);

  useEffect(() => {
    const pins = board?.pins ?? [];
    const validIds = new Set(pins.map((pin) => pin.id));
    const previousBoardId = stateBoardId.current;
    const nextBoardId = board?.id ?? null;
    // First load is not a switch — wiping here would drop a restored focus.
    const switchingBoards = previousBoardId !== null && previousBoardId !== nextBoardId;
    stateBoardId.current = nextBoardId;
    if (switchingBoards) seenPinIds.current = new Set();
    const seen = seenPinIds.current;
    for (const pin of pins) seen.add(pin.id);

    setSelected((previous) => retainFocusIds(switchingBoards ? [] : previous, pins, seen));
    setLiveSelected((previous) => retainFocusIds(switchingBoards ? [] : previous, pins, seen));
    setFocusCards((previous) => retainFocusIds(switchingBoards ? [] : previous, pins, seen));
    setConnecting((current) =>
      !switchingBoards && current && validIds.has(current.fromPinId) ? current : null,
    );
    setLiveConnect((current) =>
      !switchingBoards && current && validIds.has(current.fromPinId) ? current : null,
    );
    if (hoverAnchor.current && !validIds.has(hoverAnchor.current.pinId)) hoverAnchor.current = null;
  }, [positionScope]);

  useEffect(() => {
    liveSelectedRef.current = liveSelected;
  }, [liveSelected]);

  /** Live position, per frame. State only — dragging must not touch storage. */
  const moveTo = useCallback((pinId: string, position: FloatPosition) => {
    setPositions((prev) => ({ ...prev, [pinId]: position }));
  }, []);

  /** Where it came to rest. The one write. */
  const persistPosition = useCallback((pinId: string, position: FloatPosition) => {
    setPositions((prev) => ({ ...prev, [pinId]: position }));
    void chrome.storage.local.set({ [posKey(pinId)]: position });
  }, []);

  /**
   * Seat a capture card exactly where its live element stands, when that
   * element is still in view. A source that just joined a relationship takes
   * its component's own place on screen — the capture stands in for the thing
   * it pictures, rather than materializing wherever it was last dragged.
   */
  const seatCardAtElement = useCallback(
    (pin: Pin): boolean => {
      if (pin.kind !== "element" || !pinIsHereNow(pin)) return false;
      const found = refindElement(pin);
      if (!found) return false;
      const rect = found.element.getBoundingClientRect();
      const visible =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      if (!visible) return false;
      persistPosition(pin.id, { x: rect.left, y: rect.top });
      return true;
    },
    [persistPosition],
  );

  /* ------------------------------------------------------------------ ink */

  const regionPin = board?.pins.find((p) => p.kind === "region" && onThisPage(p)) ?? null;
  /*
   * Memoised, and `?? []` would not be. A fresh array literal on every render is
   * a fresh dependency, which rebuilt the measure callback, which re-ran its
   * effect, which set state, which rendered again. The empty case is a module
   * constant for the same reason.
   */
  const shapes = useMemo(() => regionPin?.drawings ?? NO_SHAPES, [regionPin]);
  /*
   * The board arrives by worker round trip, while ink has to appear on pointer
   * up. Keep the newest local list visible until the board acknowledges the
   * exact edit; this is also the list the debounced screenshot photographs.
   */
  const [workingShapes, setWorkingShapes] = useState<{
    route: string;
    shapes: DrawShape[];
  } | null>(null);
  const visibleShapes = workingShapes?.route === route ? workingShapes.shapes : shapes;
  const placed = usePlacedShapes(visibleShapes);
  const drawingSave = useRef<DrawingSaveCoordinator | null>(null);
  visibleShapesRef.current = visibleShapes;

  useEffect(() => {
    if (workingShapes?.route !== route) return;
    if (JSON.stringify(workingShapes.shapes) === JSON.stringify(shapes)) setWorkingShapes(null);
  }, [route, shapes, workingShapes]);

  /**
   * Marks save as they are drawn — there is no commit step, because a route's
   * marks *are* its region pin rather than a draft of one.
   *
   * The screenshot is the agent's copy of what was drawn and can only be taken
   * of what is on screen, so it is skipped when the marks are scrolled out of
   * view. The worker keeps the previous one in that case: stale beats wrong.
   */
  const persistShapes = useCallback(
    async (next: DrawShape[], includeScreenshot: boolean) => {
      let shotRect: Contract["drawing/save"]["req"]["shotRect"] = null;
      let snapshotRoot: HTMLElement | null = null;
      let unmask: (() => void) | null = null;

      if (includeScreenshot && routeForLocation() === route) {
        const boxes = placeShapes(next)
          .map(({ shape, rect }) => shapeBox(shape, rect))
          .filter((b): b is Box => b !== null);
        if (boxes.length > 0) {
          const union = {
            x: Math.min(...boxes.map((b) => b.x)),
            y: Math.min(...boxes.map((b) => b.y)),
            right: Math.max(...boxes.map((b) => b.x + b.width)),
            bottom: Math.max(...boxes.map((b) => b.y + b.height)),
          };
          // Document space to viewport space, padded, then clamped to the fold.
          const pad = 24;
          const vx = Math.max(0, union.x - window.scrollX - pad);
          const vy = Math.max(0, union.y - window.scrollY - pad);
          const vw = Math.min(window.innerWidth - vx, union.right - union.x + pad * 2);
          const vh = Math.min(window.innerHeight - vy, union.bottom - union.y + pad * 2);
          if (vw > 8 && vh > 8) {
            shotRect = { x: vx, y: vy, width: vw, height: vh };
          }
        }
      }

      try {
        if (shotRect) {
          snapshotRoot = document
            .getElementById(OVERLAY_HOST_ID)
            ?.shadowRoot?.querySelector<HTMLElement>(".pin-root") ?? null;
          /*
           * The screenshot is a page artifact, not a picture of the extension.
           * Keep the authored ink visible, hide toolbar/pins/draft chrome, and
           * use the same password/data-pin-redact masking as element capture.
           */
          snapshotRoot?.setAttribute("data-drawing-snapshot", "true");
          unmask = maskSensitive();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        }
        await send("drawing/save", {
          shapes: next,
          url: location.href,
          route,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          shotRect,
        });
        setOperationError((current) =>
          current?.title === "Drawing wasn’t saved" ? null : current,
        );
        api.refresh();
      } catch (err) {
        if (!guard(err)) {
          setOperationError(
            operationFailure(
              "Drawing wasn’t saved",
              "Your mark is still visible, but it hasn’t reached the board.",
              err,
            ),
          );
          console.error("[pinnables] could not save marks", err);
        }
      } finally {
        unmask?.();
        snapshotRoot?.removeAttribute("data-drawing-snapshot");
      }
    },
    [route, api, guard],
  );

  useEffect(() => {
    const coordinator = createDrawingSaveCoordinator(persistShapes);
    drawingSave.current = coordinator;
    return () => {
      coordinator.dispose();
      if (drawingSave.current === coordinator) drawingSave.current = null;
    };
  }, [persistShapes]);

  const saveShapes = useCallback(
    (next: DrawShape[]) => {
      /*
       * Ownership is decided at draw time, not send time. A stroke that first
       * appears while a component is selected illustrates what is being said
       * about it, so it is stamped with that pin and flushes with its live
       * send. Strokes made with nothing selected stay page-level and go with
       * the board submit, exactly as before.
       */
      const owner = liveSelectedRef.current[0] ?? null;
      const known = new Set(visibleShapesRef.current.map((shape) => shape.id));
      const tagged = owner
        ? next.map((shape) =>
            known.has(shape.id) || shape.ownerPinId ? shape : { ...shape, ownerPinId: owner },
          )
        : next;
      setWorkingShapes({ route, shapes: tagged });
      drawingSave.current?.update(tagged);
    },
    [route],
  );

  const exitCapture = useCallback(async () => {
    const coordinator = drawingSave.current;
    coordinator?.flushScreenshot();
    await coordinator?.whenIdle();
    await send("capture/setMode", { enabled: false }).catch(guard);
  }, [guard]);

  /* --------------------------------------------------------- live preview */

  /**
   * Selected differences, applied to the real element on the page.
   *
   * Ticking a property is a claim about how the page should look, and the
   * fastest way to know whether the claim was right is to see it. So the target
   * element takes the source's values as inline styles, immediately — no button,
   * no round trip through an agent.
   *
   * It is a preview and nothing more. Inline styles die with the page, touch no
   * source file, and are lifted the moment the property is unticked. The agent
   * is still what makes any of it real.
   *
   * Derived rather than applied inline, because the answer has two consumers:
   * the real element on the page, and the pinned card floating over it.
   * Computing it once keeps them the same claim rather than two that drift, and
   * keeps a render loop out of an effect that also mutates the DOM.
   */
  const previews = useMemo(
    () => (board ? computeLivePreviews(board) : new Map<string, Record<string, string>>()),
    [board],
  );

  useEffect(() => {
    if (!board || capturing) return;
    const touched: Array<{
      element: HTMLElement;
      property: string;
      had: string;
      priority: string;
    }> = [];

    for (const [targetId, styles] of previews) {
      const target = board.pins.find((p) => p.id === targetId);
      if (!target || !onThisPage(target)) continue;
      const found = refindElement(target);
      if (!found) continue;
      const element = found.element as HTMLElement;

      const set = (property: string, value: string) => {
        touched.push({
          element,
          property,
          had: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
        });
        element.style.setProperty(property, value, "important");
      };

      for (const [property, value] of Object.entries(styles)) {
        set(property, value);
        /*
         * A flex item's width is not decided by `width`.
         *
         * `flex: 1` means `flex-basis: 0%` and `flex-grow: 1` — the row sizes
         * the item and `width` is ignored no matter how loudly it is set.
         *
         * Only a fallback: `flex-basis` and `flex-grow` are captured now, so
         * the diff usually carries them itself, and the source's real values
         * beat anything guessed here.
         */
        const axis = property === "width" ? "row" : property === "height" ? "column" : null;
        if (!axis) continue;
        if ("flex-basis" in styles || "flex-grow" in styles) continue;
        const parent = element.parentElement;
        if (!parent) continue;
        const parentDisplay = getComputedStyle(parent).display;
        if (parentDisplay !== "flex" && parentDisplay !== "inline-flex") continue;
        const direction = getComputedStyle(parent).flexDirection.startsWith("column")
          ? "column"
          : "row";
        if (direction !== axis) continue;
        set("flex-basis", "auto");
        set("flex-grow", "0");
      }
    }

    return () => {
      // Put back exactly what was there, which for almost every property is "".
      for (const { element, property, had, priority } of touched) {
        if (had) element.style.setProperty(property, had, priority);
        else element.style.removeProperty(property);
      }
    };
  }, [board, route, previews, domRevision, capturing]);

  /* ---------------------------------------------------------- multi-select */

  const dismissPin = useCallback((pinId: string) => {
    setFocusCards((previous) => previous.filter((id) => id !== pinId));
    setSelected((previous) => previous.filter((id) => id !== pinId));
    setConnecting((current) => (current?.fromPinId === pinId ? null : current));
    if (hoverAnchor.current?.pinId === pinId) hoverAnchor.current = null;
  }, []);

  /**
   * Plain click replaces the selection; meta, ctrl or shift adds to it, and
   * re-clicking a selected pin removes it. Order is kept because the first pin
   * is the reference when relating a group.
   */
  const selectPin = useCallback((pinId: string, additive: boolean) => {
    setSelected((prev) => {
      if (!additive) return prev.length === 1 && prev[0] === pinId ? prev : [pinId];
      return prev.includes(pinId) ? prev.filter((id) => id !== pinId) : [...prev, pinId];
    });
  }, []);

  /** One prompt, however many pins — the note is appended to each in turn. */
  const commitNote = useCallback(
    async (text: string) => {
      const pins = board?.pins ?? [];
      for (const pinId of selected) {
        const pin = pins.find((p) => p.id === pinId);
        if (!pin) continue;
        const annotation = pin.annotation ? `${pin.annotation}\n${text}` : text;
        try {
          await send("pin/update", { pinId, patch: { annotation } });
        } catch (err) {
          if (guard(err)) return;
          throw err;
        }
      }
      api.refresh();
    },
    [selected, board, api, guard],
  );

  const reportRelationshipFailure = useCallback(
    (err: unknown) => {
      if (guard(err)) return;
      setOperationError(
        operationFailure(
          "Relationship wasn’t created",
          "The pins are unchanged.",
          err,
        ),
      );
      console.error("[pinnables] could not relate pins", err);
    },
    [guard],
  );

  /**
   * Every overlay relationship gesture shares one visible success/failure
   * path. Returns whether the relationship exists, because callers reshape
   * the focus context on the answer — rewiring the screen around a
   * relationship that was never written would be a lie about the board.
   */
  const createRelationship = useCallback(
    async (sourcePinId: string, targetPinIds: string[]): Promise<Relationship | null> => {
      try {
        const { relationship } = await send("relationship/create", { sourcePinId, targetPinIds });
        setOperationError((current) =>
          current?.title === "Relationship wasn’t created" ? null : current,
        );
        api.refresh();
        return relationship;
      } catch (err) {
        reportRelationshipFailure(err);
        return null;
      }
    },
    [api, reportRelationshipFailure],
  );

  /**
   * Relate the whole selection in one gesture instead of dragging N wires: the
   * first pin selected becomes the reference, every later one a target — which
   * is exactly the one-source-many-targets shape the schema already holds.
   */
  const relateSelected = useCallback(async () => {
    const elementIds = selected.filter(
      (pinId) => board?.pins.find((pin) => pin.id === pinId)?.kind === "element",
    );
    const [source, ...targets] = elementIds;
    if (!source || targets.length === 0) return;
    await createRelationship(source, targets);
  }, [selected, board, createRelationship]);

  /* ------------------------------------------------------- connector layout */

  /**
   * Wires are drawn from measured geometry rather than stored positions: a pin
   * card's height depends on its screenshot, which is only known once loaded.
   */
  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, DOMRect> = {};
      const host = document.getElementById(OVERLAY_HOST_ID);
      host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-pin-id]").forEach((node) => {
        const id = node.dataset.pinId;
        const card = node.querySelector<HTMLElement>(".pin-object__card");
        if (id && card) next[id] = card.getBoundingClientRect();
      });
      setCardRects(next);

      /*
       * Live selections are measured in the same pass, because they serve the
       * same consumers: outlines, the dialog under the selection, and wire
       * endpoints. One measure means the outline and the wire can never
       * disagree about where the element is mid-scroll.
       */
      const nextLive: Record<string, LiveRect> = {};
      /*
       * Only pins on this exact page get a live rect held.
       *
       * A held rect is what lets an outline survive a transient measure miss
       * mid-scroll or across a hot-reload's DOM swap. But a pin selected on
       * another route is not a transient miss — its element is genuinely gone —
       * so holding its last rect painted a stale ghost label on the wrong page
       * (a component that only matched because the new page reuses the same one).
       * Off-route selections keep their rect out of the held set, so the outline
       * and its label simply leave with the element.
       */
      const hereSelected: string[] = [];
      for (const pinId of liveSelected) {
        const pin = board?.pins.find((candidate) => candidate.id === pinId);
        if (!pin || pin.kind !== "element" || !pinIsHereNow(pin)) continue;
        hereSelected.push(pinId);
        const found = refindElement(pin);
        if (!found) continue;
        nextLive[pinId] = {
          rect: found.element.getBoundingClientRect(),
          radius: getComputedStyle(found.element).borderRadius,
          label: pinLabel(pin, board?.pins ?? []),
        };
      }
      setLiveRects((previous) => holdLiveRects(previous, hereSelected, nextLive));
    };
    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [positions, board, selected.length, focusCards, liveSelected, domRevision, route]);

  const onAnchorDown = useCallback((pinId: string, edge: AnchorEdge, event: React.PointerEvent) => {
    setConnecting({
      fromPinId: pinId,
      fromEdge: edge,
      cursor: { x: event.clientX, y: event.clientY },
      target: null,
    });
    event.preventDefault();
  }, []);


  /**
   * Enter/Space on an anchor starts, cancels, or completes the same connector
   * flow as dragging. While a connection is active every eligible pin exposes
   * its anchor, so the destination is reachable with Tab.
   */
  const onAnchorKeyboardActivate = useCallback(
    (pinId: string, edge: AnchorEdge) => {
      if (!connecting) {
        const rect = cardRects[pinId];
        setConnecting({
          fromPinId: pinId,
          fromEdge: edge,
          cursor: rect ? edgePoint(rect, edge) : { x: 0, y: 0 },
          target: null,
        });
        return;
      }
      const from = connecting.fromPinId;
      setConnecting(null);
      if (from === pinId) return;
      void createRelationship(from, [pinId]);
    },
    [cardRects, connecting, createRelationship],
  );

  /* ----------------------------------------------------------------- picker */

  const isOurs = (node: EventTarget | null): boolean =>
    node instanceof Element && (node.id === OVERLAY_HOST_ID || node.closest(`#${OVERLAY_HOST_ID}`) !== null);

  /**
   * Whether the gesture in progress started on our own UI.
   *
   * `click` fires on the nearest common ancestor of where the press began and
   * where it ended, so dragging a pin across the page and releasing over it
   * produced a click on <body> — which the picker happily treated as "pin this",
   * capturing whatever the card had been dragged over. Checking the click target
   * cannot catch that; only remembering where the press landed can.
   */
  useEffect(() => {
    if (!state.enabled) return;
    const onDown = (event: PointerEvent) => {
      pressStartedInOurs.current = event
        .composedPath()
        .some((n) => n instanceof Element && n.id === OVERLAY_HOST_ID);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [state.enabled]);

  useEffect(() => {
    const clearHover = () => {
      setHighlight(null);
      hovered.current = null;
    };

    if (!state.enabled || mode !== "pin" || capturing || stale || connecting || liveConnect) {
      clearHover();
      return;
    }

    const onMove = (event: MouseEvent) => {
      if (isOurs(event.target)) {
        clearHover();
        return;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!isCapturablePageElement(el)) {
        clearHover();
        return;
      }
      if (el === hovered.current) return;

      hovered.current = el;
      const rect = el.getBoundingClientRect();
      const name = el.getAttribute("data-pin-component") ?? el.tagName.toLowerCase();
      setHighlight({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        label: `${name} · ${Math.round(rect.width)}×${Math.round(rect.height)}`,
        radius: getComputedStyle(el).borderRadius,
      });
    };

    document.addEventListener("mousemove", onMove, true);
    window.addEventListener("blur", clearHover);
    document.documentElement.addEventListener("mouseleave", clearHover);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("blur", clearHover);
      document.documentElement.removeEventListener("mouseleave", clearHover);
    };
  }, [state.enabled, mode, capturing, stale, connecting, liveConnect]);

  /**
   * What a capture is *for*. The photograph is identical either way; what
   * changes is where the focus context lands afterward.
   */
  type CaptureIntent =
    /** A picker click: select the live element, dialog attached in place. */
    | { kind: "select"; additive: boolean }
    /** Panel relate flow: pick as target, leave the focus context alone. */
    | { kind: "relate" }
    /** A connect drop: this element becomes the target of a new relationship. */
    | { kind: "target"; sourcePinId: string };

  const capture = useCallback(
    async (element: Element, intent: CaptureIntent = { kind: "select", additive: false }) => {
      if (!isCapturablePageElement(element)) return;
      /*
       * Synchronous re-entrancy guard. The `capturing` state commits a frame
       * too late to stop two captures racing from adjacent pointerdowns — and
       * overlapped captures each snapshotted the other's hidden host as their
       * "restore" value, leaving the entire overlay permanently invisible
       * while its document-level listeners kept pinning. A ref is checked and
       * set before the first await, so a second capture cannot start at all.
       */
      if (captureBusy.current) return;
      captureBusy.current = true;
      setCapturing(true);
      setCaptureError(null);
      setHighlight(null);
      let unmask: (() => void) | null = null;
      let unmaskOverlay: (() => void) | null = null;
      const host = document.getElementById(OVERLAY_HOST_ID);
      /*
       * Our own overlay is not part of the component.
       *
       * `captureVisibleTab` photographs the viewport and the result is cropped
       * to the element, so anything of ours sitting over that rect lands inside
       * the crop — a floating pin parked on a neighbouring card, the toolbar, a
       * hover outline. The pin then shows the component wearing Pinnables.
       *
       * Hidden rather than unmounted: the tree keeps its state and comes back
       * in the same frame, where a remount would drop positions and re-run the
       * mount effects for the sake of one screenshot.
       */
      try {
        /*
         * Capturing turns off relationship previews. Two frames let React commit
         * that state and run the preview effect's cleanup before computed styles
         * or pixels are read, so a temporary target style never becomes the
         * target's new baseline on recapture.
         */
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        let measured = measureElement(element);

        /*
         * The worker can only crop the visible tab. If the whole component can
         * fit, bring it fully into view and measure its new viewport coordinates
         * rather than stretching neighbouring pixels into the clipped edge.
         */
        if (shouldRevealForCapture(measured.rect, measured.viewport)) {
          element.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          measured = measureElement(element);
        }

        unmask = maskSensitive();
        unmaskOverlay = maskOverlayForCapture(measured.rect);
        // One frame so the redaction covers are painted before the shot.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const { pin } = await send("capture/element", { element: measured });
        // Same sizing rule the card renders with: actual size, capped only
        // by a viewport share — so the stored beside-placement fits the card
        // that will actually appear.
        const capWidth = Math.max(420, Math.round(measured.viewport.width * 0.72));
        const capHeight = Math.max(260, Math.round(measured.viewport.height * 0.72));
        const fit = Math.min(
          1,
          capHeight / Math.max(1, measured.rect.height),
          capWidth / Math.max(1, measured.rect.width),
        );
        const floatingSize = {
          width: Math.max(200, Math.round(measured.rect.width * fit)),
          height: Math.round(measured.rect.height * fit) + 64,
        };
        // Stored even though no card appears yet — this is where the capture
        // lands when the shelf summons it later.
        persistPosition(
          pin.id,
          placeFloatingPinBeside(measured.rect, floatingSize, measured.viewport),
        );

        if (intent.kind === "relate") {
          /*
           * The panel owns this flow. The click's whole meaning is "this one
           * too" — the pin exists (or refreshed), the panel hears about it
           * and toggles its target chip. Selection, cards, dialogs: all
           * untouched, so picking three targets never disturbs the shelf's
           * matching state. A second click on the same component resolves to
           * the same pin and toggles it back off.
           */
          chrome.runtime
            .sendMessage({ kind: "relate-picked", pinId: pin.id } satisfies Broadcast)
            .catch(() => {});
          const rect = element.getBoundingClientRect();
          setHighlight({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            label: "picked as target",
            radius: getComputedStyle(element).borderRadius,
          });
          window.setTimeout(() => setHighlight(null), 900);
        } else if (intent.kind === "target") {
          /*
           * The drop that created this capture also creates the relationship,
           * and the focus follows the conversation: the dialog moves to the
           * target, while the source stays on screen as a capture card —
           * pinned, because it is now wired to something live. When the write
           * fails, the target is still pinned and selected, but the screen
           * must not stage a relationship that does not exist.
           */
          const related = await createRelationship(intent.sourcePinId, [pin.id]);
          /*
           * Compose from the relationship the worker returned, not from a
           * guess: a second connector merges into the existing relationship,
           * and the whole target set comes back selected — this page's
           * targets live, off-route ones as capture cards. Waiting for the
           * board broadcast to do this raced the refresh and lost.
           */
          const liveTargets = related
            ? related.targetPinIds.filter(
                (targetId) =>
                  targetId === pin.id ||
                  onThisPage(board?.pins.find((candidate) => candidate.id === targetId)),
              )
            : [pin.id];
          const cardTargets = related
            ? related.targetPinIds.filter((targetId) => !liveTargets.includes(targetId))
            : [];
          setLiveSelected(liveTargets);
          setSelected([]);
          setFocusCards(related ? [intent.sourcePinId, ...cardTargets] : []);
          if (related) suppressFocusRelationshipId.current = related.id;
          if (related) {
            const sourcePin = board?.pins.find(
              (candidate) => candidate.id === intent.sourcePinId,
            );
            if (sourcePin) seatCardAtElement(sourcePin);
          }
        } else {
          // Every click pins. Selecting is the conversation; the shelf entry
          // is the memory of it, whether or not anything gets said.
          focusDismissed.current = false;
          setLiveSelected((previous) =>
            intent.additive
              ? [...previous.filter((id) => id !== pin.id), pin.id]
              : [pin.id],
          );
          if (!intent.additive) {
            setFocusCards([]);
            setSelected([]);
          }
        }
        setJustPinned(pin.id);
        window.setTimeout(() => setJustPinned((id) => (id === pin.id ? null : id)), 900);
      } catch (err) {
        if (!guard(err)) {
          const detail = err instanceof Error && err.message.trim() ? err.message : "Try again.";
          setCaptureError(`Couldn’t capture this item. ${detail}`);
          console.error("[pinnables] capture failed", err);
        }
      } finally {
        /*
         * Visible, unconditionally. With re-entry impossible everything was
         * visible before this capture, and "restore what was there" is the
         * pattern that once wrote `hidden` back as the baseline. The host's
         * own visibility is cleared too, in case an older build left it set.
         */
        if (host) host.style.visibility = "";
        unmaskOverlay?.();
        unmask?.();
        captureBusy.current = false;
        setCapturing(false);
      }
    },
    [persistPosition, guard, createRelationship, board, seatCardAtElement],
  );

  /*
   * Card-anchor wires. Declared after `capture` because a drop on a live
   * component captures it as the target, exactly like the live-connect
   * gesture's drop.
   */
  useEffect(() => {
    if (!connecting) return;

    /*
     * The wire's end is the picker: while the drag is live, whatever
     * component sits under the cursor lights up as the drop candidate, the
     * same hover-select the capture picker gives. The source's own element
     * is excluded — a wire back onto itself is not a relationship.
     */
    const sourcePin = board?.pins.find((candidate) => candidate.id === connecting.fromPinId);
    const sourceElement =
      sourcePin && onThisPage(sourcePin) ? (refindElement(sourcePin)?.element ?? null) : null;

    const onMove = (event: PointerEvent) => {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const candidate =
        under &&
        !isOurs(under) &&
        isCapturablePageElement(under) &&
        under !== sourceElement &&
        !sourceElement?.contains(under)
          ? under
          : null;
      const target: HighlightBox | null = candidate
        ? (() => {
            const rect = candidate.getBoundingClientRect();
            const name =
              candidate.getAttribute("data-pin-component") ?? candidate.tagName.toLowerCase();
            return {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              label: `target · ${name}`,
              radius: getComputedStyle(candidate).borderRadius,
            };
          })()
        : null;
      setConnecting((c) =>
        c ? { ...c, cursor: { x: event.clientX, y: event.clientY }, target } : c,
      );
    };

    const onUp = (event: PointerEvent) => {
      const target = hoverAnchor.current;
      const from = connecting.fromPinId;
      setConnecting(null);
      if (target && target.pinId !== from) {
        void createRelationship(from, [target.pinId]);
        return;
      }
      /*
       * No card anchor under the pointer — the same drop the live-connect
       * gesture accepts: a live component becomes the target, captured and
       * related in one release. Without this, a wire dragged from a seated
       * source card onto the page died silently, and drawing the second
       * connector of a multi-target relationship was impossible.
       */
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (!under || isOurs(under) || !isCapturablePageElement(under)) return;
      const sourcePin = board?.pins.find((candidate) => candidate.id === from);
      const sourceElement =
        sourcePin && onThisPage(sourcePin) ? (refindElement(sourcePin)?.element ?? null) : null;
      // Dropping back onto the source's own component is not a relationship.
      if (sourceElement && (under === sourceElement || sourceElement.contains(under))) return;
      void capture(under, { kind: "target", sourcePinId: from });
    };

    // The browser fires pointercancel instead of pointerup when it takes the
    // gesture over (scroll, focus loss). That is a cancellation, never a drop
    // — an armed pointerup arriving later must not connect to whatever the
    // cursor happens to rest on.
    const onCancel = () => setConnecting(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [connecting, createRelationship, board, route, capture]);

  /* --------------------------------------------------- live connect gesture */

  /**
   * Drag from a selected element's anchor, and the pin becomes the cursor: a
   * thumbnail of the capture rides the pointer, the component underneath
   * highlights gray as the candidate, and releasing on it makes it the target
   * — captured, related, and handed the dialog in one gesture.
   */
  const beginLiveConnect = useCallback(
    (pinId: string, event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const pin = board?.pins.find((candidate) => candidate.id === pinId);
      liveConnectSource.current = pin ? (refindElement(pin)?.element ?? null) : null;
      liveConnectTarget.current = null;
      setLiveConnect({
        fromPinId: pinId,
        cursor: { x: event.clientX, y: event.clientY },
        thumb: null,
        target: null,
      });
      void chrome.storage.local.get(`thumb:${pinId}`).then((bag) => {
        setLiveConnect((current) =>
          current && current.fromPinId === pinId
            ? { ...current, thumb: (bag[`thumb:${pinId}`] as string | undefined) ?? null }
            : current,
        );
      });
    },
    [board],
  );

  useEffect(() => {
    if (!liveConnect) return;
    const fromPinId = liveConnect.fromPinId;

    const onMove = (event: PointerEvent) => {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const candidate =
        under &&
        !isOurs(under) &&
        isCapturablePageElement(under) &&
        under !== liveConnectSource.current &&
        !liveConnectSource.current?.contains(under)
          ? under
          : null;
      liveConnectTarget.current = candidate;
      const target: HighlightBox | null = candidate
        ? (() => {
            const rect = candidate.getBoundingClientRect();
            const name =
              candidate.getAttribute("data-pin-component") ?? candidate.tagName.toLowerCase();
            return {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              label: `target · ${name}`,
              radius: getComputedStyle(candidate).borderRadius,
            };
          })()
        : null;
      setLiveConnect((current) =>
        current
          ? { ...current, cursor: { x: event.clientX, y: event.clientY }, target }
          : current,
      );
    };

    const onUp = () => {
      const element = liveConnectTarget.current;
      liveConnectTarget.current = null;
      liveConnectSource.current = null;
      setLiveConnect(null);
      // Released over nothing capturable — the gesture simply ends, exactly
      // like dropping a card wire on empty page.
      if (element) void capture(element, { kind: "target", sourcePinId: fromPinId });
    };

    // A taken-over gesture cancels; it never captures whatever sits under the
    // cursor when a stray pointerup finally lands.
    const onCancel = () => {
      liveConnectTarget.current = null;
      liveConnectSource.current = null;
      setLiveConnect(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // Keyed on the gesture, not the cursor — the handlers read fresh state.
  }, [liveConnect?.fromPinId, capture]);

  useEffect(() => {
    if (!state.enabled || mode !== "pin" || stale || connecting || liveConnect) return;

    const targetAt = (event: MouseEvent | PointerEvent) =>
      document.elementFromPoint(event.clientX, event.clientY);
    const blockPageGesture = (event: MouseEvent | PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onPickerPointerDown = (event: PointerEvent) => {
      if (isOurs(event.target) || pressStartedInOurs.current) return;
      const target = targetAt(event);
      if (!isCapturablePageElement(target)) return;
      blockPageGesture(event);
      captureStartedOnPress.current = true;
      // Shift adds to the selection, Cursor-style — the first stays the
      // reference. In the panel's relate flow the same click means "pick this
      // as a target" instead.
      if (!capturing)
        void capture(
          target,
          state.relateSourcePinId !== null
            ? { kind: "relate" }
            : { kind: "select", additive: event.shiftKey },
        );
    };

    // Some pages install mouse handlers rather than pointer handlers. Keep a
    // dedicated capture-phase guard so neither family can focus, toggle, or
    // navigate the target before its screenshot is measured.
    const onPickerMouseDown = (event: MouseEvent) => {
      if (isOurs(event.target) || pressStartedInOurs.current) return;
      const target = targetAt(event);
      if (!isCapturablePageElement(target)) return;
      blockPageGesture(event);
    };

    const onPickerClick = (event: MouseEvent) => {
      if (isOurs(event.target) || pressStartedInOurs.current) return;
      const target = pickerTargetForActivation(event);
      if (!target) return;
      blockPageGesture(event);
      if (captureStartedOnPress.current) {
        captureStartedOnPress.current = false;
        return;
      }
      // Keyboard/synthetic clicks have no pointerdown. Preserve the old click
      // path as an accessibility fallback, with the same target validation.
      if (!capturing)
        void capture(
          target,
          state.relateSourcePinId !== null
            ? { kind: "relate" }
            : { kind: "select", additive: event.shiftKey },
        );
    };

    document.addEventListener("pointerdown", onPickerPointerDown, true);
    document.addEventListener("mousedown", onPickerMouseDown, true);
    document.addEventListener("click", onPickerClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPickerPointerDown, true);
      document.removeEventListener("mousedown", onPickerMouseDown, true);
      document.removeEventListener("click", onPickerClick, true);
    };
  }, [state.enabled, mode, capture, capturing, stale, connecting, liveConnect, state.relateSourcePinId]);

  /* -------------------------------------------------------- deselect on out */

  useEffect(() => {
    if (!state.enabled) return;

    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.isConnected) return;
      // Composed path, because a click inside the shadow root reports the host
      // as its target from the page's perspective.
      const insideSelectionOwner = event
        .composedPath()
        .some((n) => n instanceof Element && isPinSelectionOwner(n.classList));
      if (!insideSelectionOwner) setSelected([]);

      /*
       * The live focus survives presses on ANY of our UI — switching to the
       * draw tool to circle something is part of the conversation, not the end
       * of it. It clears only on genuinely empty page space: a press on a
       * capturable element is already a new selection via the picker.
       *
       * A live edit's DOM swap can land a press on html/body for a frame.
       * That is not a dismissal.
       */
      const insideOurs = event
        .composedPath()
        .some((n) => n instanceof Element && n.id === OVERLAY_HOST_ID);
      if (!insideOurs && !isCapturablePageElement(target)) {
        if (capturing || Date.now() - lastDomMutationAt.current < 500) return;
        focusDismissed.current = true;
        pendingFocusRelationship.current = null;
        setLiveSelected([]);
        setFocusCards([]);
      }
    };

    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [state.enabled, capturing]);

  /* -------------------------------------------------------------- esc layer */

  useEffect(() => {
    if (!state.enabled) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Draw mode owns Escape while it is up — it has a frozen frame to discard.
      if (mode === "draw") return;

      /*
       * Yield Escape to the *page's* own text fields, never to ours.
       *
       * The composer is where Escape matters most — it is the "clear what's on
       * screen" gesture, and pressing it with the note focused should dismiss
       * the whole context, cards included. It did the opposite: the overlay
       * lives in a shadow root, so a keydown from our textarea is retargeted to
       * the host element, which matched the `closest(host)` guard and bailed.
       * The card was left stranded on the page while the note vanished — the one
       * thing this handler exists to prevent. Only a field that is genuinely the
       * page's (outside our host) gets to keep Escape for itself.
       */
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inPageField =
        target !== null &&
        target.closest(`#${OVERLAY_HOST_ID}`) === null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inPageField) return;

      // Layered: drop the wire, then the focus context, then the mode, and
      // only then exit. Escape belongs to the page until we have something of
      // our own to dismiss.
      if (liveConnect) {
        event.preventDefault();
        liveConnectTarget.current = null;
        liveConnectSource.current = null;
        setLiveConnect(null);
        return;
      }
      if (connecting) {
        event.preventDefault();
        setConnecting(null);
        return;
      }
      if (liveSelected.length > 0 || focusCards.length > 0 || selected.length > 0) {
        event.preventDefault();
        focusDismissed.current = true;
        pendingFocusRelationship.current = null;
        setLiveSelected([]);
        setFocusCards([]);
        setSelected([]);
        return;
      }
      /*
       * Escape never changes the tool anymore. It used to fall through to
       * browse mode, which silently disarmed the picker — the next click did
       * nothing, with the only evidence a small toolbar icon. Leaving a mode
       * is the toolbar's job; Escape only dismisses what is dismissable, and
       * exits capture only from browse, where an exit is the one thing left.
       */
      if (mode === "browse") {
        event.preventDefault();
        void send("capture/setMode", { enabled: false }).catch(guard);
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    state.enabled,
    mode,
    selected.length,
    liveSelected.length,
    focusCards.length,
    connecting,
    liveConnect,
    guard,
  ]);

  /* --------------------------------------------------------- reveal a pin */

  useEffect(() => {
    const request = state.reveal;
    const stopActiveReveal = () => {
      revealCleanup.current?.();
      revealCleanup.current = null;
    };
    if (!request) {
      stopActiveReveal();
      setHighlight(null);
      return;
    }
    if (handledReveal.current === request) return;

    /* Region messages intentionally carry no DOM selector. Wait for the board
       read that identifies their drawing pin before consuming the request. */
    if (!request.selector && !request.domPath && !board) return;
    if (!claimRevealRequest(handledReveal, request)) return;

    stopActiveReveal();

    const keepHighlightAttached = (update: () => void) => {
      window.addEventListener("scroll", update, true);
      let cleanup: () => void;
      const timer = window.setTimeout(() => {
        window.removeEventListener("scroll", update, true);
        if (revealCleanup.current === cleanup) revealCleanup.current = null;
        setHighlight(null);
      }, 2400);
      cleanup = () => {
        window.removeEventListener("scroll", update, true);
        window.clearTimeout(timer);
      };
      revealCleanup.current = cleanup;
    };

    const revealedPin = board?.pins.find((pin) => pin.id === request.pinId);

    if (revealedPin?.kind === "region") {
      const resolved =
        regionPin?.id === revealedPin.id ? placed : placeShapes(revealedPin.drawings);
      const boxes = resolved
        .map(({ shape, rect }) => shapeBox(shape, rect))
        .filter((box): box is Box => box !== null);
      const bounds = unionBoxes(boxes);
      if (!bounds) {
        setHighlight(null);
        return;
      }

      setSelected([revealedPin.id]);
      const padding = 12;
      const updateHighlight = () => {
        setHighlight({
          x: bounds.x - window.scrollX - padding,
          y: bounds.y - window.scrollY - padding,
          width: bounds.width + padding * 2,
          height: bounds.height + padding * 2,
          label: `${boxes.length} mark${boxes.length === 1 ? "" : "s"}`,
          radius: "6px",
        });
      };
      updateHighlight();
      window.scrollTo({
        left: Math.max(0, bounds.x + bounds.width / 2 - window.innerWidth / 2),
        top: Math.max(0, bounds.y + bounds.height / 2 - window.innerHeight / 2),
        behavior: "smooth",
      });
      keepHighlightAttached(updateHighlight);
      return;
    }

    // A consumed region whose pin no longer exists must not fall through and
    // let an empty selector's text fallback frame an arbitrary page wrapper.
    if (!request.selector && !request.domPath) {
      setHighlight(null);
      return;
    }
    const found = refindElement(request);
    if (!found) {
      setHighlight(null);
      return;
    }
    /*
     * Selected, not just pointed at.
     *
     * "Go to pin" is already a statement about which pin you mean, and in the
     * single-focus flow that means the live element itself: the dialog opens
     * on it, ready to continue the conversation the shelf row started.
     */
    focusDismissed.current = false;
    setLiveSelected([request.pinId]);
    setFocusCards([]);
    setSelected([]);
    const updateElementHighlight = () => {
      const rect = found.element.getBoundingClientRect();
      setHighlight({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        label:
          found.confidence === 1
            ? "exact match"
            : `${Math.round(found.confidence * 100)}% match`,
        radius: getComputedStyle(found.element).borderRadius,
      });
    };
    updateElementHighlight();
    found.element.scrollIntoView({ behavior: "smooth", block: "center" });
    keepHighlightAttached(updateElementHighlight);
  }, [state.reveal, positionScope, placed, board, regionPin]);

  /* -------------------------------------------------------------- summoning */

  /**
   * The shelf's pin button, landing. The summoned captures become the entire
   * focus context — one lone receipt, or a relationship's whole cluster with
   * its wires — and whatever was on screen before steps aside. Cards without a
   * remembered position are seated beside their live element, so the capture
   * reads as "this, as it was" next to "this, as it is".
   */
  useEffect(() => {
    const request = state.summon;
    if (!request || !board) return;
    if (!claimRevealRequest(handledSummon, request)) return;

    const valid = request.pinIds.filter((pinId) =>
      board.pins.some((pin) => pin.id === pinId && pin.kind === "element"),
    );
    if (valid.length === 0) return;

    /*
     * Summoning adds; it never steals. The label and bar stay on whatever is
     * selected, and the summoned captures simply join the screen — the shelf
     * pin is a toggle for presence, not a context switch.
     */
    setFocusCards((previous) => [
      ...previous,
      ...valid.filter((pinId) => !previous.includes(pinId)),
    ]);

    /*
     * Placement, in order of truth. A component still on screen is the best
     * possible seat: the capture lands exactly on top of it, standing in for
     * the thing it pictures — even over a remembered drag position, because
     * "show me this pin" means "show me it here". Only when the element is
     * gone or scrolled away does the remembered position matter, and only
     * with neither does the beside-placement fallback run. Positions come
     * from storage directly, not the `positions` state — the async state
     * load can still be in flight when a summon lands.
     */
    void chrome.storage.local.get(valid.map(posKey)).then((bag) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      for (const pinId of valid) {
        const pin = board.pins.find((candidate) => candidate.id === pinId);
        if (!pin) continue;
        if (seatCardAtElement(pin)) continue;
        if (bag[posKey(pinId)]) continue;
        const found = onThisPage(pin) ? refindElement(pin) : null;
        if (!found) continue;
        const rect = found.element.getBoundingClientRect();
        const fit = Math.min(1, 260 / Math.max(1, pin.elementSize.height || 1));
        persistPosition(
          pinId,
          placeFloatingPinBeside(
            { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            {
              width: Math.max(200, Math.min(420, Math.round(pin.elementSize.width * fit))),
              height: Math.round((pin.elementSize.height || 120) * fit) + 64,
            },
            viewport,
          ),
        );
      }
    });
  }, [state.summon, board, route, persistPosition, seatCardAtElement]);

  /**
   * The shelf pin's off half. The capture leaves the screen; if the pin was
   * the live selection, it defocuses — label and bar gone, nothing selected.
   * The pin itself always survives on the shelf.
   */
  useEffect(() => {
    const request = state.dismiss;
    if (!request) return;
    if (!claimRevealRequest(handledDismiss, request)) return;
    const leaving = new Set(request.pinIds);
    setFocusCards((previous) => previous.filter((pinId) => !leaving.has(pinId)));
    setLiveSelected((previous) => previous.filter((pinId) => !leaving.has(pinId)));
    setSelected((previous) => previous.filter((pinId) => !leaving.has(pinId)));
  }, [state.dismiss]);

  /**
   * A relationship was just created — somewhere. The page composes the scene
   * the panel path cannot compose itself: the source up as a capture card,
   * every target on this route live-selected (labels on each, the bar between
   * them), and targets on other routes as capture cards, since there is no
   * live element here to select.
   */
  useEffect(() => {
    const request = state.focusRelationship;
    if (!request) return;
    // Claimed immediately; the id waits in the pending slot until the board
    // refresh carries the relationship. Waiting *unclaimed* meant a slow
    // refresh could replay the request after the user had already pressed
    // Escape — resurrecting a context they had just dismissed.
    if (!claimRevealRequest(handledFocusRelationship, request)) return;
    if (request.relationshipId === suppressFocusRelationshipId.current) {
      suppressFocusRelationshipId.current = null;
      return;
    }
    pendingFocusRelationship.current = request.relationshipId;
  }, [state.focusRelationship]);

  useEffect(() => {
    const relationshipId = pendingFocusRelationship.current;
    if (!relationshipId || !board) return;
    const relationship = board.relationships.find((rel) => rel.id === relationshipId);
    if (!relationship) return;
    pendingFocusRelationship.current = null;

    const targets = relationship.targetPinIds.filter((pinId) =>
      board.pins.some((pin) => pin.id === pinId && pin.kind === "element"),
    );
    const live = targets.filter(
      (pinId) => onThisPage(board.pins.find((pin) => pin.id === pinId)),
    );
    const cardTargets = targets.filter((pinId) => !live.includes(pinId));
    setSelected([]);
    setLiveSelected(live);
    setFocusCards([relationship.sourcePinId, ...cardTargets]);
    // The source capture takes its component's own place when it is in view.
    const source = board.pins.find((pin) => pin.id === relationship.sourcePinId);
    if (source) seatCardAtElement(source);
  }, [board, route, state.focusRelationship, seatCardAtElement]);

  /**
   * The shelf's group row, landing. Reopening a messaged multi-selection is a
   * context switch, not an addition: members on this route come back as the
   * live selection — combined bar, shared history and all — and members from
   * other routes ride along as capture cards, exactly like a relationship's
   * cluster does.
   */
  useEffect(() => {
    const request = state.summonGroup;
    if (!request || !board) return;
    if (!claimRevealRequest(handledSummonGroup, request)) return;

    const members = request.pinIds.filter((pinId) =>
      board.pins.some((pin) => pin.id === pinId && pin.kind === "element"),
    );
    if (members.length === 0) return;
    const live = members.filter(
      (pinId) => onThisPage(board.pins.find((pin) => pin.id === pinId)),
    );
    pendingFocusRelationship.current = null;
    setSelected([]);
    setLiveSelected(live);
    setFocusCards(members.filter((pinId) => !live.includes(pinId)));

    const first = board.pins.find((pin) => pin.id === live[0]);
    const found = first ? refindElement(first) : null;
    found?.element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [state.summonGroup, board, route]);

  /*
   * The dismissal side of "the shelf records what you said": a provisional
   * pin whose selection ends unspoken is quietly discarded. The worker
   * verifies silence itself, so a discard racing a promotion is a no-op —
   * this watcher only has to notice departures, never adjudicate them.
   */
  const previousLiveSelected = useRef<string[]>([]);
  useEffect(() => {
    const departed = previousLiveSelected.current.filter((id) => !liveSelected.includes(id));
    previousLiveSelected.current = liveSelected;
    if (!board || departed.length === 0) return;
    for (const pinId of departed) {
      const pin = board.pins.find((candidate) => candidate.id === pinId);
      if (!pin?.provisional) continue;
      void send("pin/discardProvisional", { pinId })
        .then(({ discarded }) => {
          if (discarded) api.refresh();
        })
        .catch(() => {});
    }
  }, [liveSelected, board, api]);

  /**
   * Restore the last focus on this page. A live edit's HMR reload remounts the
   * overlay; without this the selected component would vanish even though the
   * pin is still on the board.
   */
  useEffect(() => {
    if (!state.enabled || !board || focusReady.current) return;
    if (liveSelected.length > 0 || focusCards.length > 0 || selected.length > 0) {
      focusReady.current = true;
      return;
    }
    let cancelled = false;
    const key = overlayFocusKey(location.origin);
    void chrome.storage.local.get(key).then((bag) => {
      if (cancelled || focusReady.current) return;
      const snapshot = bag[key] as OverlayFocusSnapshot | undefined;
      const here = overlayFocusLocation();
      if (overlayFocusRestoreDecision(snapshot, here) === "wait") return;
      const restored = applyOverlayFocusSnapshot(snapshot, board.pins, here);
      if (restored) {
        focusDismissed.current = false;
        setLiveSelected(restored.liveSelected);
        setFocusCards(restored.focusCards);
        setSelected(restored.selected);
      }
      focusReady.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [state.enabled, board, route, liveSelected.length, focusCards.length, selected.length]);

  /**
   * Turning capture off is a clean break.
   *
   * The overlay stays mounted while capture is off — it just renders nothing —
   * so a live selection left in state used to sit there through the toggle and
   * a hash navigation, then reappear the moment capture came back on, stranded
   * on whatever page and element it now happened to match. Clearing on the way
   * out means turning capture back on always starts empty: a stashed pin waits
   * on the shelf and returns with its pin icon; an unstashed one was already
   * discarded. The stored snapshot goes too, so a later reload starts empty.
   *
   * HMR reloads never come through here — a live edit keeps capture on — so the
   * selection a designer is mid-edit on still survives, restored from the
   * snapshot that only an explicit toggle-off clears.
   */
  const captureWasOn = useRef(state.enabled);
  useEffect(() => {
    const turnedOff = captureWasOn.current && !state.enabled;
    captureWasOn.current = state.enabled;
    if (!turnedOff) return;
    focusDismissed.current = true;
    pendingFocusRelationship.current = null;
    setSelected([]);
    setLiveSelected([]);
    setFocusCards([]);
    void chrome.storage.local.remove(overlayFocusKey(location.origin)).catch(() => {});
  }, [state.enabled]);

  /**
   * The shelf mirrors what is on screen: pin ids in the focus context are
   * published for the panel, whose upright pin icons fill for exactly these.
   * The same write keeps the focus snapshot for the next document.
   */
  useEffect(() => {
    // Until Chrome has said which tab this is there is nowhere to file the
    // answer. The id arrives once, early, and re-runs this.
    if (tabId === null) return;
    const presenceKey = onScreenPinsKey(tabId);
    if (!state.enabled) {
      void chrome.storage.local.set({ [presenceKey]: [] });
      return;
    }
    if (!focusReady.current) return;
    const here = overlayFocusLocation();
    const snapshot: OverlayFocusSnapshot = {
      origin: here.origin,
      route: here.route,
      liveSelected,
      focusCards,
      selected,
    };
    const onScreenPins = [...liveSelected, ...focusCards];
    if (!shouldPersistOverlayFocus(snapshot, focusDismissed.current)) {
      void chrome.storage.local.set({ [presenceKey]: onScreenPins });
      return;
    }
    void chrome.storage.local.set({
      [presenceKey]: onScreenPins,
      [overlayFocusKey(here.origin)]: snapshot,
    });
  }, [state.enabled, liveSelected, focusCards, selected, tabId]);

  /* ------------------------------------------------------------ live dialog */

  const liveSelectedPins = useMemo(
    () =>
      liveSelected
        .map((pinId) => board?.pins.find((pin) => pin.id === pinId))
        .filter((pin): pin is Pin => pin !== undefined),
    [liveSelected, board],
  );

  /** The relationship this selection is the on-screen target of, if any. */
  const targetContext = useMemo(() => {
    if (!board || liveSelected.length === 0) return null;
    // Every live-selected pin must be a target and the source must be on
    // screen — a bar between three targets saying "target of X" has to be
    // true of all three, not the first that happens to match.
    const relationship = board.relationships.find(
      (rel) =>
        focusCards.includes(rel.sourcePinId) &&
        liveSelected.every((pinId) => rel.targetPinIds.includes(pinId)),
    );
    if (!relationship) return null;
    const source = board.pins.find((pin) => pin.id === relationship.sourcePinId);
    if (!source) return null;
    return { relationshipId: relationship.id, sourceName: pinLabel(source, board.pins) };
  }, [board, liveSelected, focusCards]);

  const ownedShapes = useMemo(
    () =>
      visibleShapes.filter(
        (shape) => shape.ownerPinId !== null && liveSelected.includes(shape.ownerPinId),
      ),
    [visibleShapes, liveSelected],
  );

  /** A live send took its illustrations with it, so they leave the page. */
  const flushLiveDrawings = useCallback(
    (pinIds: string[]) => {
      const remaining = visibleShapesRef.current.filter(
        (shape) => !shape.ownerPinId || !pinIds.includes(shape.ownerPinId),
      );
      if (remaining.length !== visibleShapesRef.current.length) saveShapes(remaining);
      api.refresh();
    },
    [saveShapes, api],
  );

  /** "Add to board": staged like any annotation, sent later with the board. */
  const addLiveNote = useCallback(
    async (text: string) => {
      for (const pin of liveSelectedPins) {
        const annotation = pin.annotation ? `${pin.annotation}\n${text}` : text;
        try {
          await send("pin/update", { pinId: pin.id, patch: { annotation } });
        } catch (err) {
          if (guard(err)) return;
          throw err;
        }
      }
      api.refresh();
    },
    [liveSelectedPins, api, guard],
  );

  /**
   * Shift-click gathered the set; this turns it into one relationship. The
   * first selected is the reference, and it steps back into a capture card —
   * wired to the live targets that keep the dialog.
   */
  const relateLiveSelection = useCallback(async () => {
    const [source, ...targets] = liveSelected;
    if (!source || targets.length === 0) return;
    const related = await createRelationship(source, targets);
    if (related === null) return;
    suppressFocusRelationshipId.current = related.id;
    setFocusCards([source]);
    setLiveSelected(targets);
    // The reference steps back into its capture, seated on its own component.
    const sourcePin = board?.pins.find((candidate) => candidate.id === source);
    if (sourcePin) seatCardAtElement(sourcePin);
  }, [liveSelected, createRelationship, board, seatCardAtElement]);

  if (!state.enabled && !highlight) return null;

  if (!state.enabled)
    return (
      <div className="pin-overlay">
        <HighlightOutline highlight={highlight!} />
      </div>
    );

  if (stale) {
    return (
      <div className="pin-overlay">
        <div className="pin-stale" role="alert">
          <span className="pin-stale__dot" />
          <span>Pinnables was reloaded. Refresh this page to keep pinning. Your board is safe.</span>
          <button className="pin-btn pin-btn--primary" onClick={() => location.reload()}>
            Refresh
          </button>
        </div>
      </div>
    );
  }

  const pins: Pin[] = board?.pins ?? [];
  const drawing = mode === "draw";

  // A lone selection docks its composer under the card. Two or more and it
  // detaches — see the floating block below.
  const primaryPinId = selected.length === 1 ? selected[0] : null;
  /*
   * Cards render only for the focus context. Everything captured lives on the
   * shelf; the screen holds the one thing being worked on — a live selection,
   * a summoned receipt, or a relationship cluster.
   */
  const visible = drawing ? [] : pins.filter((p) => focusCards.includes(p.id));

  /*
   * A wire endpoint is wherever the pin currently shows: its floating capture
   * card, or its live element when that element is the selection. This is what
   * lets a summoned relationship draw lines to components already on the page
   * instead of demanding a card for each.
   */
  const endpointRect = (pinId: string): DOMRect | null =>
    cardRects[pinId] ?? liveRects[pinId]?.rect ?? null;

  const wires: Array<{ id: string; d: string; from: Point; to: Point }> = [];
  if (board && !drawing) {
    for (const rel of board.relationships) {
      const a = endpointRect(rel.sourcePinId);
      if (!a) continue;
      for (const targetId of rel.targetPinIds) {
        const b = endpointRect(targetId);
        if (!b) continue;
        const [ea, eb] = bestEdges(a, b);
        const from = edgePoint(a, ea);
        const to = edgePoint(b, eb);
        wires.push({ id: `${rel.id}-${targetId}`, d: wirePath(from, to), from, to });
      }
    }
  }

  /**
   * Where a floating composer sits: centred under the union of every selected
   * card, clamped into the viewport. Following the group rather than any one
   * card is the point — the prompt applies to all of them.
   */
  const groupBox = (() => {
    if (selected.length < 2) return null;
    const rects = selected.map((id) => cardRects[id]).filter(Boolean) as DOMRect[];
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return placeGroupComposer(
      { left, right, bottom },
      { width: window.innerWidth, height: window.innerHeight },
    );
  })();
  const canRelateSelection =
    selected.length > 1 &&
    selected.every((pinId) => pins.find((pin) => pin.id === pinId)?.kind === "element");

  const draft =
    connecting && cardRects[connecting.fromPinId]
      ? {
          from: edgePoint(cardRects[connecting.fromPinId], connecting.fromEdge),
          to: connecting.cursor,
        }
      : null;

  /** The wire being dragged from a live element toward its target-to-be. */
  const liveDraft = (() => {
    if (!liveConnect) return null;
    const from = liveRects[liveConnect.fromPinId]?.rect;
    if (!from) return null;
    const edge = defaultEdgeFor(from, { width: window.innerWidth, height: window.innerHeight });
    return { from: edgePoint(from, edge), to: liveConnect.cursor };
  })();

  /*
   * One call seats the box and the rail together. Two solvers agreeing by
   * luck is what put them on top of each other; the module owns the ladder,
   * the rings, the reserved seats and the promise that what it places does
   * not overlap.
   *
   * Named `chromePlacement` rather than `chrome`: this function already uses
   * the global `chrome` extension API (storage, runtime) throughout — a
   * local `const chrome` here would shadow it for the whole component.
   */
  const chromePlacement: ChromePlacement | null = (() => {
    if (drawing || liveSelectedPins.length === 0) return null;
    const entries = liveSelected
      .map((pinId, index) => ({ rect: liveRects[pinId]?.rect, full: index === 0 }))
      .filter((entry): entry is { rect: DOMRect; full: boolean } => entry.rect !== undefined);
    if (entries.length === 0) return null;
    const rects = entries.map((entry) => entry.rect);
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    /*
     * A top-of-viewport selection hangs its label below itself, where the
     * box wants to go — so the box yields that height. Preserved verbatim
     * from the placement this replaces.
     */
    const flipped = entries.filter((entry) => entry.rect.top < 60 && entry.rect.bottom >= bottom - 1);
    const labelBelow = flipped.length === 0 ? 0 : Math.max(...flipped.map((entry) => (entry.full ? 42 : 26)));
    const labelAbove = flipped.length === 0 ? 48 : 0;
    const primary = liveSelectedPins[0];
    const element = { x: left, y: top, width: right - left, height: bottom - top };
    return placeSelectionChrome({
      element,
      labelAbove,
      labelBelow,
      loneLeft: rects.length === 1 ? rects[0].left : null,
      box: boxSize ?? { width: 380, height: 96 },
      rail: railSize,
      manualBox: boxDragPos
        ? { x: boxDragPos.x - element.x, y: boxDragPos.y - element.y }
        : (primary.boxPos ?? null),
      manualRail: primary.railPos ?? null,
      preferred: preferredSeats,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
  })();

  const boxSeat = chromePlacement?.box.seat ?? null;
  const railSeat = chromePlacement?.rail?.seat ?? null;
  /**
   * The scoot actually in effect right now: a live rail drag overrides the
   * module's resting value while it's in flight. Computed once so the
   * dialog's margin and the box rect fed to capture rails always agree —
   * negative included, since an above-orientation drag can lift the box up.
   */
  const effectiveScoot = liveScoot !== 0 ? liveScoot : (chromePlacement?.scoot ?? 0);
  useEffect(() => {
    setPreferredSeats((prev) =>
      prev.box === boxSeat && prev.rail === railSeat ? prev : { box: boxSeat, rail: railSeat },
    );
  }, [boxSeat, railSeat]);

  /*
   * The box drags by its body — no grip, the same discovery pin cards and
   * the floating label already rely on. What a drag stores is an offset
   * from the element, so the arrangement travels with the component.
   * pointercancel abandons: an interrupted drag must never half-move the
   * thing you type into.
   */
  const beginBoxDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const primary = liveSelectedPins[0];
      if (!primary || !chromePlacement) return;
      /*
       * Pointerdown's default action starts a text selection, which is right
       * for the box's inert surface but not for a drag handle. Safe to swallow
       * unconditionally here: SelectionDialog has already filtered the target
       * to exclude every interactive child (textarea, button, a, .pin-key,
       * .pin-kbd), so this can never eat the focus click on the input, a
       * version key press, or Resend — only the selection-drag on plain text.
       */
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY };
      const origin = { x: chromePlacement.box.x, y: chromePlacement.box.y };
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - start.x) < 5 && Math.abs(ev.clientY - start.y) < 5) return;
        moved = true;
        setBoxDragPos({ x: origin.x + (ev.clientX - start.x), y: origin.y + (ev.clientY - start.y) });
      };
      const done = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const up = (ev: PointerEvent) => {
        done();
        const rect = liveRects[primary.id]?.rect;
        setBoxDragPos(null);
        if (!moved || !rect) return;
        const at = { x: origin.x + (ev.clientX - start.x), y: origin.y + (ev.clientY - start.y) };
        void send("pin/update", {
          pinId: primary.id,
          patch: { boxPos: { x: at.x - rect.left, y: at.y - rect.top } },
        }).catch(() => {});
      };
      const cancel = () => {
        done();
        setBoxDragPos(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [chromePlacement, liveSelectedPins, liveRects],
  );

  return (
    <>
      {/*
        * The ink sits outside `.pin-overlay` on purpose. That element is fixed to
        * the viewport, and anything absolutely positioned inside it would be
        * fixed too — marks have to live in document space so they scroll away
        * with the content they were drawn on.
        *
        * They are always on. Draw mode adds a surface to draw *into*; what you
        * already drew belongs to the page whether or not you are drawing.
        */}
      {!drawing && <InkLayer placed={placed} />}
      {drawing && (
        <DrawLayer
          key={route}
          shapes={visibleShapes}
          tool={drawTool}
          color={drawColor}
          onChange={(next) => void saveShapes(next)}
          onDone={() => {
            drawingSave.current?.flushScreenshot();
            setMode("pin");
          }}
          onTool={setDrawTool}
        />
      )}

      <div className="pin-overlay">

      {(captureError || operationError) && (
        <div className="pin-capture-error" role="alert">
          <div className="pin-capture-error__copy">
            <strong>{captureError ? "Capture failed" : operationError?.title}</strong>
            <span>{captureError ?? operationError?.detail}</span>
          </div>
          <button
            className="pin-capture-error__dismiss"
            type="button"
            onClick={() => {
              setCaptureError(null);
              setOperationError(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Relationship geometry stays neutral. Red is reserved for destructive
          intent, errors, and authored red marks. */}
      {!drawing && (wires.length > 0 || draft || liveDraft) && (
        <svg className="pin-wires" aria-hidden>
          {wires.map((wire) => (
            <g key={wire.id}>
              <path className="pin-wire" d={wire.d} />
              <circle cx={wire.from.x} cy={wire.from.y} r="3.5" fill="var(--pin-ink)" />
              <circle cx={wire.to.x} cy={wire.to.y} r="3.5" fill="var(--pin-ink)" />
            </g>
          ))}
          {draft && (
            <>
              <path className="pin-wire pin-wire--draft" d={wirePath(draft.from, draft.to)} />
              <circle cx={draft.from.x} cy={draft.from.y} r="3.5" fill="var(--pin-ink)" />
            </>
          )}
          {liveDraft && (
            <>
              <path className="pin-wire pin-wire--draft" d={wirePath(liveDraft.from, liveDraft.to)} />
              <circle cx={liveDraft.from.x} cy={liveDraft.from.y} r="3.5" fill="var(--pin-ink)" />
            </>
          )}
        </svg>
      )}

      {highlight && !drawing && <HighlightOutline highlight={highlight} />}
      {/* The card-anchor drag's drop candidate, lit like the picker's hover. */}
      {connecting?.target && <HighlightOutline highlight={connecting.target} />}

      {/*
        * The selection lives on the page. The outline wears the element's own
        * radius like the picker does, the label names it, and the single anchor
        * is where a relationship wire starts — same affordance the cards have,
        * attached to the real thing.
        */}
      {!drawing &&
        liveSelected.map((pinId, index) => {
          const live = liveRects[pinId];
          if (!live) return null;
          const pin = pins.find((candidate) => candidate.id === pinId);
          const edge = defaultEdgeFor(live.rect, {
            width: window.innerWidth,
            height: window.innerHeight,
          });
          /*
           * Every selection wears the full identity bar — name, source,
           * close — so a multi-select reads as equals, not a headline act
           * with anonymous backups. Each close button releases only its own
           * pin; the rest of the selection stands.
           */
          const full = true;
          void index;
          return (
            <div
              key={pinId}
              className="pin-live-outline"
              data-label={live.rect.top < 60 ? "below" : "above"}
              style={{
                left: live.rect.left,
                top: live.rect.top,
                width: live.rect.width,
                height: live.rect.height,
                borderRadius: live.radius,
              }}
            >
              <div className="pin-live-label" data-full={full}>
                <span className="pin-live-label__name">{live.label}</span>
                {full && (
                  <span className="pin-live-label__src" title={pin?.sourceFile ?? pin?.route}>
                    {pin?.sourceFile ?? pin?.route ?? ""}
                  </span>
                )}
                {full && (
                  <button
                    className="pin-icon-btn pin-live-label__close"
                    data-no-drag
                    onClick={() =>
                      setLiveSelected((previous) => {
                        const next = previous.filter((id) => id !== pinId);
                        if (next.length === 0) focusDismissed.current = true;
                        return next;
                      })
                    }
                    title="Deselect this one. The rest stay selected"
                    aria-label={`Deselect ${live.label}`}
                  >
                    <CloseIcon size={13} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="pin-anchor"
                data-edge={edge}
                title={`Start relationship from ${live.label}. Drag onto another component`}
                aria-label={`Start relationship from ${live.label}`}
                onPointerDown={(event) => beginLiveConnect(pinId, event)}
              />
            </div>
          );
        })}

      {/* The pin as the cursor: its thumbnail rides the pointer, and the
          component underneath highlights as the candidate target. */}
      {liveConnect && (
        <>
          {liveConnect.target && <HighlightOutline highlight={liveConnect.target} />}
          <div
            className="pin-connect-ghost"
            style={{ left: liveConnect.cursor.x + 14, top: liveConnect.cursor.y + 14 }}
            aria-hidden
          >
            {liveConnect.thumb ? (
              <img src={liveConnect.thumb} alt="" />
            ) : (
              <span>{liveRects[liveConnect.fromPinId]?.label ?? "pin"}</span>
            )}
          </div>
        </>
      )}

      {visible.map((pin) => (
        <PinObject
          key={pin.id}
          pin={pin}
          board={board!}
          position={positions[pin.id] ?? { x: 24, y: 96 }}
          pulse={justPinned === pin.id}
          selected={selected.includes(pin.id)}
          primary={primaryPinId === pin.id}
          selectionCount={selected.length}
          connecting={connecting !== null}
          connectionRole={connecting?.fromPinId === pin.id ? "source" : undefined}
          awayRoute={
            !onThisPage(pin)
              ? {
                  where: sourceLabel(pin),
                  /*
                   * A capture from a site you do not own can never update live —
                   * there is no dev server behind it and no file to edit. The
                   * chip still travels there, because seeing the original is
                   * worth the trip, but it must not promise an edit.
                   */
                  live: isLocalUrl(pin.url),
                  onOpen: () => {
                    /*
                     * Prefer reopening the relationship that put this card on
                     * screen — on its own page the pin becomes the live
                     * target. A card with no relationship falls back to the
                     * plain reveal, which navigates and selects it.
                     */
                    const relationship = board?.relationships.find(
                      (rel) =>
                        (rel.targetPinIds.includes(pin.id) &&
                          focusCards.includes(rel.sourcePinId)) ||
                        (rel.sourcePinId === pin.id &&
                          rel.targetPinIds.some(
                            (targetId) =>
                              focusCards.includes(targetId) || liveSelected.includes(targetId),
                          )),
                    );
                    if (relationship) {
                      void send("relationship/open", {
                        relationshipId: relationship.id,
                        atPinId: pin.id,
                      }).catch(() => {});
                    } else {
                      void send("pin/revealSource", { pinId: pin.id }).catch(() => {});
                    }
                  },
                }
              : undefined
          }
          onSelect={(additive) => selectPin(pin.id, additive)}
          onMove={(next) => moveTo(pin.id, next)}
          onMoveEnd={(next) => persistPosition(pin.id, next)}
          onDismiss={() => dismissPin(pin.id)}
          onCommit={commitNote}
          onRelate={relateSelected}
          onAnchorDown={onAnchorDown}
          onAnchorKeyboardActivate={onAnchorKeyboardActivate}
          onAnchorEnter={(pinId, edge) => (hoverAnchor.current = { pinId, edge })}
          onAnchorLeave={() => (hoverAnchor.current = null)}
        />
      ))}

      {groupBox && (
        <div
          className="pin-note pin-note--floating"
          style={{ left: groupBox.x, top: groupBox.y, width: groupBox.width }}
        >
          <Composer
            count={selected.length}
            onCommit={commitNote}
            onRelate={canRelateSelection ? relateSelected : undefined}
            agentPinIds={selected}
            autoFocus
          />
        </div>
      )}

      {chromePlacement && board && liveSelectedPins.length > 0 && (
        <SelectionDialog
          pins={liveSelectedPins}
          board={board}
          position={{ x: chromePlacement.box.x, y: chromePlacement.box.y, width: chromePlacement.box.width }}
          scoot={effectiveScoot}
          onRootEl={onDialogRootEl}
          onBodyPointerDown={beginBoxDrag}
          versionBusy={versionBusy}
          onVersionBusy={setVersionBusy}
          projectHead={projectHead}
          versionsOk={versionsOk}
          targetOf={targetContext?.sourceName ?? null}
          relationshipId={targetContext?.relationshipId ?? null}
          drawingSummary={ownedShapes.length > 0 ? describeDrawings(ownedShapes) : null}
          onLiveSent={flushLiveDrawings}
          onAddToBoard={addLiveNote}
          onRelate={liveSelectedPins.length > 1 ? () => void relateLiveSelection() : null}
          onDismiss={() => {
            focusDismissed.current = true;
            setLiveSelected([]);
          }}
        />
      )}

      {/*
        * The rail and the set-down captures. One annotation box, one rail:
        * they attach to the live selection and leave with it — Escape or a
        * deselect clears every piece of this chrome at once, and only a
        * summon brings it back.
        */}
      {board && liveSelectedPins.length > 0 && !drawing && (
        <VersionLayer
          board={board}
          pin={liveSelectedPins[0]}
          liveRect={liveRects[liveSelectedPins[0].id]?.rect ?? null}
          visible={true}
          versionsOk={versionsOk}
          projectHead={projectHead}
          busy={versionBusy}
          onBusy={setVersionBusy}
          mainRail={chromePlacement?.rail ?? null}
          boxRect={
            chromePlacement && boxSize
              ? {
                  x: chromePlacement.box.x,
                  // Must describe where the box actually renders (same
                  // effective scoot as the dialog above), or capture rails
                  // seat against a phantom rect instead of the real one.
                  y: chromePlacement.box.y + effectiveScoot,
                  width: chromePlacement.box.width,
                  height: boxSize.height,
                }
              : null
          }
          onRailSize={setRailSize}
          onScoot={setLiveScoot}
        />
      )}

      {/* One bar, always. Draw mode changes what is in it. */}
      <Toolbar
        mode={mode}
        onMode={setMode}
        pinCount={pins.length}
        onExit={() => void exitCapture()}
        drawTool={drawTool}
        onDrawTool={setDrawTool}
        drawColor={drawColor}
        onDrawColor={setDrawColor}
      />
      </div>
    </>
  );
}
