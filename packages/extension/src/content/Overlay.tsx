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
  expandProperties,
  type Board,
  type DrawShape,
  type Pin,
} from "@pinnables/shared";
import {
  OVERLAY_HOST_ID,
  maskSensitive,
  measureElement,
  refindElement,
  routeForLocation,
} from "../lib/capture";
import { ExtensionReloadedError, send, type Contract } from "../lib/messages";
import type { OverlayApi } from "./mount";
import { Toolbar, type DrawTool, type ToolMode } from "./Toolbar";
import { PinObject } from "./PinObject";
import { Composer } from "./Composer";
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
import { detectScheme, watchScheme, type AnchorEdge, type Scheme } from "../ui/theme";

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

/** Claim one reveal message by object identity; a fresh request may target the same pin. */
export function claimRevealRequest<T extends object>(
  handled: { current: T | null },
  request: T,
): boolean {
  if (handled.current === request) return false;
  handled.current = request;
  return true;
}

/** Relationship styles shared by the live DOM target and its floating pin. */
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
  const bow = Math.max(28, Math.min(120, (dx + dy) / 3));
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
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
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
  /** Current border-boxes of pinned elements on this route, after live previews. */
  const [liveSizes, setLiveSizes] = useState<Record<string, { width: number; height: number }>>({});
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
  const hovered = useRef<Element | null>(null);
  const pressStartedInOurs = useRef(false);
  const captureStartedOnPress = useRef(false);
  const hoverAnchor = useRef<{ pinId: string; edge: AnchorEdge } | null>(null);
  const handledReveal = useRef<typeof state.reveal>(null);
  const revealCleanup = useRef<(() => void) | null>(null);
  const stateBoardId = useRef<string | null>(null);
  const positionBoardId = useRef<string | null>(null);

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
    const boardChanged = stateBoardId.current !== (board?.id ?? null);
    stateBoardId.current = board?.id ?? null;

    setSelected((previous) => retainExistingPinIds(boardChanged ? [] : previous, pins));
    setDismissed((previous) => {
      const retained = retainExistingPinIds(boardChanged ? [] : [...previous], pins);
      return retained.length === previous.size ? previous : new Set(retained);
    });
    setConnecting((current) =>
      !boardChanged && current && validIds.has(current.fromPinId) ? current : null,
    );
    if (hoverAnchor.current && !validIds.has(hoverAnchor.current.pinId)) hoverAnchor.current = null;
  }, [positionScope]);

  /**
   * Keep each floating pin the same size as its live page element.
   *
   * This observes the result of layout instead of trying to replay layout math.
   * It therefore covers all of the cases that can decide a box — relationship
   * width and height, padding under either box-sizing mode, flex/grid parents,
   * responsive rules, and page-side resizes. Pins on other routes fall back to
   * their captured size until that route is visible again.
   */
  useEffect(() => {
    if (!board) {
      setLiveSizes({});
      return;
    }

    const ids = new Map<Element, string>();
    const initial: Record<string, { width: number; height: number }> = {};
    for (const pin of board.pins) {
      if (pin.kind !== "element" || pin.route !== route) continue;
      const found = refindElement(pin);
      if (!found) continue;
      ids.set(found.element, pin.id);
      const rect = found.element.getBoundingClientRect();
      initial[pin.id] = { width: rect.width, height: rect.height };
    }
    setLiveSizes(initial);

    const observer = new ResizeObserver((entries) => {
      setLiveSizes((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const entry of entries) {
          const pinId = ids.get(entry.target);
          if (!pinId) continue;
          const rect = entry.target.getBoundingClientRect();
          const size = { width: rect.width, height: rect.height };
          const before = next[pinId];
          if (before?.width === size.width && before.height === size.height) continue;
          next[pinId] = size;
          changed = true;
        }
        return changed ? next : previous;
      });
    });
    for (const element of ids.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [board?.pins, route, domRevision]);

  /** Live position, per frame. State only — dragging must not touch storage. */
  const moveTo = useCallback((pinId: string, position: FloatPosition) => {
    setPositions((prev) => ({ ...prev, [pinId]: position }));
  }, []);

  /** Where it came to rest. The one write. */
  const persistPosition = useCallback((pinId: string, position: FloatPosition) => {
    setPositions((prev) => ({ ...prev, [pinId]: position }));
    void chrome.storage.local.set({ [posKey(pinId)]: position });
  }, []);

  /* ------------------------------------------------------------------ ink */

  const regionPin = board?.pins.find((p) => p.kind === "region" && p.route === route) ?? null;
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
      setWorkingShapes({ route, shapes: next });
      drawingSave.current?.update(next);
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
      if (!target || target.route !== route) continue;
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
    setDismissed((previous) => new Set(previous).add(pinId));
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

  /** Every overlay relationship gesture shares one visible success/failure path. */
  const createRelationship = useCallback(
    async (sourcePinId: string, targetPinIds: string[]) => {
      try {
        await send("relationship/create", { sourcePinId, targetPinIds });
        setOperationError((current) =>
          current?.title === "Relationship wasn’t created" ? null : current,
        );
        api.refresh();
      } catch (err) {
        reportRelationshipFailure(err);
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
  }, [positions, board, selected.length, dismissed, liveSizes]);

  const onAnchorDown = useCallback((pinId: string, edge: AnchorEdge, event: React.PointerEvent) => {
    setConnecting({ fromPinId: pinId, fromEdge: edge, cursor: { x: event.clientX, y: event.clientY } });
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!connecting) return;

    const onMove = (event: PointerEvent) => {
      setConnecting((c) => (c ? { ...c, cursor: { x: event.clientX, y: event.clientY } } : c));
    };

    const onUp = () => {
      const target = hoverAnchor.current;
      const from = connecting.fromPinId;
      setConnecting(null);
      if (!target || target.pinId === from) return;
      void createRelationship(from, [target.pinId]);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [connecting, createRelationship]);

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

    if (!state.enabled || mode !== "pin" || capturing || stale || connecting) {
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
  }, [state.enabled, mode, capturing, stale, connecting]);

  const capture = useCallback(
    async (element: Element) => {
      if (!isCapturablePageElement(element)) return;
      setCapturing(true);
      setCaptureError(null);
      setHighlight(null);
      let unmask: (() => void) | null = null;
      const host = document.getElementById(OVERLAY_HOST_ID);
      const hadVisibility = host?.style.visibility ?? "";
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
        if (host) host.style.visibility = "hidden";
        // One frame so the redaction covers are painted before the shot.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const { pin } = await send("capture/element", { element: measured });
        const fit = Math.min(1, 260 / Math.max(1, measured.rect.height));
        const floatingSize = {
          width: Math.max(300, Math.min(420, Math.round(measured.rect.width * fit))),
          height: Math.round(measured.rect.height * fit) + 64,
        };
        persistPosition(
          pin.id,
          placeFloatingPinBeside(measured.rect, floatingSize, measured.viewport),
        );
        setDismissed((previous) => {
          if (!previous.has(pin.id)) return previous;
          const next = new Set(previous);
          next.delete(pin.id);
          return next;
        });
        setJustPinned(pin.id);
        // Newly captured is newly selected — the composer opens ready to type.
        setSelected([pin.id]);
        window.setTimeout(() => setJustPinned((id) => (id === pin.id ? null : id)), 900);
      } catch (err) {
        if (!guard(err)) {
          const detail = err instanceof Error && err.message.trim() ? err.message : "Try again.";
          setCaptureError(`Couldn’t capture this item. ${detail}`);
          console.error("[pinnables] capture failed", err);
        }
      } finally {
        if (host) host.style.visibility = hadVisibility;
        unmask?.();
        setCapturing(false);
      }
    },
    [persistPosition, guard],
  );

  useEffect(() => {
    if (!state.enabled || mode !== "pin" || stale || connecting) return;

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
      if (!capturing) void capture(target);
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
      if (!capturing) void capture(target);
    };

    document.addEventListener("pointerdown", onPickerPointerDown, true);
    document.addEventListener("mousedown", onPickerMouseDown, true);
    document.addEventListener("click", onPickerClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPickerPointerDown, true);
      document.removeEventListener("mousedown", onPickerMouseDown, true);
      document.removeEventListener("click", onPickerClick, true);
    };
  }, [state.enabled, mode, capture, capturing, stale, connecting]);

  /* -------------------------------------------------------- deselect on out */

  useEffect(() => {
    if (!state.enabled || !selected) return;

    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // Composed path, because a click inside the shadow root reports the host
      // as its target from the page's perspective.
      const insideSelectionOwner = event
        .composedPath()
        .some((n) => n instanceof Element && isPinSelectionOwner(n.classList));
      if (insideSelectionOwner || !target) return;
      setSelected([]);
    };

    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [state.enabled, selected.length]);

  /* -------------------------------------------------------------- esc layer */

  useEffect(() => {
    if (!state.enabled) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Draw mode owns Escape while it is up — it has a frozen frame to discard.
      if (mode === "draw") return;

      const target = event.target as Element | null;
      const typingInOurs =
        target instanceof Element &&
        (target.closest(`#${OVERLAY_HOST_ID}`) !== null ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA");
      if (typingInOurs) return;

      // Layered: drop the connection, then the selection, then the mode, and
      // only then exit. Escape belongs to the page until we have something of
      // our own to dismiss.
      if (connecting) {
        event.preventDefault();
        setConnecting(null);
        return;
      }
      if (selected.length > 0) {
        event.preventDefault();
        setSelected([]);
        return;
      }
      if (mode !== "browse") {
        event.preventDefault();
        setMode("browse");
        return;
      }
      event.preventDefault();
      void send("capture/setMode", { enabled: false }).catch(guard);
    };

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state.enabled, mode, selected.length, connecting, guard]);

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
    // "Go to pin" is an explicit request to see it. A local hide is a view
    // preference, not a deletion, so reveal must undo it before selecting.
    setDismissed((previous) => {
      if (!previous.has(state.reveal!.pinId)) return previous;
      const next = new Set(previous);
      next.delete(state.reveal!.pinId);
      return next;
    });

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
     * The highlight flashed for two seconds and left nothing behind, so
     * arriving from the shelf meant finding the pin and then still having to
     * click it before anything could be done with it. Pressing "Go to pin" is
     * already a statement about which pin you mean — the selection is what
     * makes that survive the scroll.
     */
    setSelected([request.pinId]);
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
          <span>Pinnables was reloaded. Refresh this page to keep pinning — your board is safe.</span>
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
  const visible = drawing ? [] : pins.filter((p) => !dismissed.has(p.id));

  // Existing relationships, resolved to on-screen endpoints.
  const wires: Array<{ id: string; d: string; from: Point; to: Point }> = [];
  if (board && !drawing) {
    for (const rel of board.relationships) {
      const a = cardRects[rel.sourcePinId];
      if (!a) continue;
      for (const targetId of rel.targetPinIds) {
        const b = cardRects[targetId];
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
      {!drawing && (wires.length > 0 || draft) && (
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
        </svg>
      )}

      {highlight && !drawing && <HighlightOutline highlight={highlight} />}

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
          onSelect={(additive) => selectPin(pin.id, additive)}
          onMove={(next) => moveTo(pin.id, next)}
          onMoveEnd={(next) => persistPosition(pin.id, next)}
          preview={previews.get(pin.id)}
          renderedSize={liveSizes[pin.id]}
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
            autoFocus
          />
        </div>
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
