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
  computeStyleDiff,
  DEFAULT_DRAW_COLOR,
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
import { InkLayer, placeShapes, shapeBox, usePlacedShapes, type Box } from "./InkLayer";
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
  const hoverAnchor = useRef<{ pinId: string; edge: AnchorEdge } | null>(null);

  /**
   * The scheme comes from the host page's background, not the OS — and it is
   * re-checked when the page mutates its own theme, since apps flip a class on
   * <html> rather than reloading.
   */
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

  useEffect(() => {
    if (!board) return;
    const keys = board.pins.map((p) => posKey(p.id));
    void chrome.storage.local.get(keys).then((bag) => {
      const next: Record<string, FloatPosition> = {};
      for (const pin of board.pins) {
        const stored = bag[posKey(pin.id)] as FloatPosition | undefined;
        if (stored) next[pin.id] = stored;
      }
      setPositions((prev) => ({ ...next, ...prev }));
    });
  }, [board?.pins.length]);

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
  }, [board?.pins, route]);

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
  const placed = usePlacedShapes(shapes);

  /**
   * Marks save as they are drawn — there is no commit step, because a route's
   * marks *are* its region pin rather than a draft of one.
   *
   * The screenshot is the agent's copy of what was drawn and can only be taken
   * of what is on screen, so it is skipped when the marks are scrolled out of
   * view. The worker keeps the previous one in that case: stale beats wrong.
   */
  const saveShapes = useCallback(
    async (next: DrawShape[]) => {
      let shotRect: Contract["drawing/save"]["req"]["shotRect"] = null;
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
      try {
        await send("drawing/save", {
          shapes: next,
          url: location.href,
          route,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          shotRect,
        });
        api.refresh();
      } catch (err) {
        if (!guard(err)) console.error("[pinnables] could not save marks", err);
      }
    },
    [route, api, guard],
  );

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
  const previews = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    if (!board) return map;
    for (const rel of board.relationships) {
      const source = board.pins.find((p) => p.id === rel.sourcePinId);
      if (!source) continue;
      const wanted = expandProperties(rel.properties);
      if (wanted.length === 0) continue;
      for (const targetId of rel.targetPinIds) {
        const target = board.pins.find((p) => p.id === targetId);
        if (!target) continue;
        const styles = map.get(targetId) ?? {};
        /*
         * The same guard the diff runs, applied where the value is written.
         *
         * The panel only ever stores properties that survived `computeStyleDiff`,
         * so this looked redundant — but `expandProperties` also accepts group
         * names, and a board authored anywhere else carries them: the checked-in
         * fixture stores `["radius", "spacing", "shadow"]`. Expanding a group
         * yields every longhand under it, guarded or not, and `border-color`
         * from a borderless source paints the black border this was supposed to
         * have fixed.
         *
         * Upstream filtering is not a guarantee when the input has two shapes.
         */
        const applicable = applicabilityGuard(source, target);
        // Longhands, not the collapsed row — `padding` is not a thing the
        // element's style object can be set to from four captured values.
        for (const property of wanted) {
          if (!applicable(property).applicable) continue;
          const value = source.computedStyles[property];
          if (value === undefined) continue;
          if (target.computedStyles[property] === value) continue;
          styles[property] = value;
        }
        if (Object.keys(styles).length > 0) map.set(targetId, styles);
      }
    }
    return map;
  }, [board]);

  useEffect(() => {
    if (!board) return;
    const touched: Array<{ element: HTMLElement; property: string; had: string }> = [];

    for (const [targetId, styles] of previews) {
      const target = board.pins.find((p) => p.id === targetId);
      if (!target || target.route !== route) continue;
      const found = refindElement(target);
      if (!found) continue;
      const element = found.element as HTMLElement;

      const set = (property: string, value: string) => {
        touched.push({ element, property, had: element.style.getPropertyValue(property) });
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
      for (const { element, property, had } of touched) {
        if (had) element.style.setProperty(property, had);
        else element.style.removeProperty(property);
      }
    };
  }, [board, route, previews]);

  /* ---------------------------------------------------------- multi-select */

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

  /**
   * Relate the whole selection in one gesture instead of dragging N wires: the
   * first pin selected becomes the reference, every later one a target — which
   * is exactly the one-source-many-targets shape the schema already holds.
   */
  const relateSelected = useCallback(async () => {
    const [source, ...targets] = selected;
    if (!source || targets.length === 0) return;
    try {
      await send("relationship/create", { sourcePinId: source, targetPinIds: targets });
      api.refresh();
    } catch (err) {
      if (!guard(err)) console.error("[pinnables] could not relate pins", err);
    }
  }, [selected, api, guard]);

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
      void send("relationship/create", { sourcePinId: from, targetPinIds: [target.pinId] })
        .then(api.refresh)
        .catch((err) => {
          if (!guard(err)) console.error("[pinnables] could not connect pins", err);
        });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [connecting, api, guard]);

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
    if (!state.enabled || mode !== "pin" || capturing || stale || connecting) {
      setHighlight(null);
      hovered.current = null;
      return;
    }

    const onMove = (event: MouseEvent) => {
      if (isOurs(event.target)) {
        setHighlight(null);
        hovered.current = null;
        return;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === document.documentElement || el === document.body) return;
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
    return () => document.removeEventListener("mousemove", onMove, true);
  }, [state.enabled, mode, capturing, stale, connecting]);

  const capture = useCallback(
    async (element: Element) => {
      setCapturing(true);
      setHighlight(null);
      const measured = measureElement(element);
      const unmask = maskSensitive();
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
      const host = document.getElementById(OVERLAY_HOST_ID);
      const hadVisibility = host?.style.visibility ?? "";
      if (host) host.style.visibility = "hidden";
      try {
        // One frame so the redaction covers are painted before the shot.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const { pin } = await send("capture/element", { element: measured });
        persistPosition(pin.id, {
          x: Math.min(window.innerWidth - 360, Math.max(12, measured.rect.x)),
          y: Math.min(window.innerHeight - 220, Math.max(12, measured.rect.y)),
        });
        setJustPinned(pin.id);
        // Newly captured is newly selected — the composer opens ready to type.
        setSelected([pin.id]);
        window.setTimeout(() => setJustPinned((id) => (id === pin.id ? null : id)), 900);
      } catch (err) {
        if (!guard(err)) console.error("[pinnables] capture failed", err);
      } finally {
        if (host) host.style.visibility = hadVisibility;
        unmask();
        setCapturing(false);
      }
    },
    [persistPosition, guard],
  );

  useEffect(() => {
    if (!state.enabled || mode !== "pin" || stale || connecting) return;

    const onClick = (event: MouseEvent) => {
      if (isOurs(event.target) || pressStartedInOurs.current) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      void capture(el);
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [state.enabled, mode, capture, stale, connecting]);

  /* -------------------------------------------------------- deselect on out */

  useEffect(() => {
    if (!state.enabled || !selected) return;

    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // Composed path, because a click inside the shadow root reports the host
      // as its target from the page's perspective.
      const insidePin = event
        .composedPath()
        .some((n) => n instanceof Element && n.classList?.contains("pin-object"));
      if (insidePin || !target) return;
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
    if (!state.reveal) return;
    const found = refindElement(state.reveal);
    if (!found) {
      setHighlight(null);
      return;
    }
    found.element.scrollIntoView({ behavior: "smooth", block: "center" });
    /*
     * Selected, not just pointed at.
     *
     * The highlight flashed for two seconds and left nothing behind, so
     * arriving from the shelf meant finding the pin and then still having to
     * click it before anything could be done with it. Pressing "Go to pin" is
     * already a statement about which pin you mean — the selection is what
     * makes that survive the scroll.
     */
    setSelected([state.reveal.pinId]);
    const rect = found.element.getBoundingClientRect();
    setHighlight({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      label: found.confidence === 1 ? "exact match" : `${Math.round(found.confidence * 100)}% match`,
      radius: getComputedStyle(found.element).borderRadius,
    });
    const timer = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [state.reveal]);

  if (!state.enabled) return null;

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
    return {
      x: Math.min(Math.max(12, (left + right) / 2 - 190), window.innerWidth - 392),
      y: Math.min(bottom + 12, window.innerHeight - 120),
    };
  })();

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
          shapes={shapes}
          tool={drawTool}
          color={drawColor}
          onChange={(next) => void saveShapes(next)}
          onDone={() => setMode("pin")}
          onTool={setDrawTool}
        />
      )}

      <div className="pin-overlay">

      {/* Hairline and neutral, with a red dot at each end — the logo's tittle,
          reused so a connection reads as the product's own gesture. */}
      {!drawing && (wires.length > 0 || draft) && (
        <svg className="pin-wires" aria-hidden>
          {wires.map((wire) => (
            <g key={wire.id}>
              <path className="pin-wire" d={wire.d} />
              <circle cx={wire.from.x} cy={wire.from.y} r="3.5" fill="var(--pin-red)" />
              <circle cx={wire.to.x} cy={wire.to.y} r="3.5" fill="var(--pin-red)" />
            </g>
          ))}
          {draft && (
            <>
              <path className="pin-wire pin-wire--draft" d={wirePath(draft.from, draft.to)} />
              <circle cx={draft.from.x} cy={draft.from.y} r="3.5" fill="var(--pin-red)" />
            </>
          )}
        </svg>
      )}

      {highlight && !drawing && (
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
          onSelect={(additive) => selectPin(pin.id, additive)}
          onMove={(next) => moveTo(pin.id, next)}
          onMoveEnd={(next) => persistPosition(pin.id, next)}
          preview={previews.get(pin.id)}
          renderedSize={liveSizes[pin.id]}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(pin.id))}
          onCommit={commitNote}
          onRelate={relateSelected}
          onAnchorDown={onAnchorDown}
          onAnchorEnter={(pinId, edge) => (hoverAnchor.current = { pinId, edge })}
          onAnchorLeave={() => (hoverAnchor.current = null)}
        />
      ))}

      {groupBox && (
        <div className="pin-note pin-note--floating" style={{ left: groupBox.x, top: groupBox.y }}>
          <Composer
            count={selected.length}
            onCommit={commitNote}
            onRelate={relateSelected}
            autoFocus
          />
        </div>
      )}

      {/* One bar, always. Draw mode changes what is in it. */}
      <Toolbar
        mode={mode}
        onMode={setMode}
        pinCount={pins.length}
        onExit={() => void send("capture/setMode", { enabled: false }).catch(guard)}
        drawTool={drawTool}
        onDrawTool={setDrawTool}
        drawColor={drawColor}
        onDrawColor={setDrawColor}
      />
      </div>
    </>
  );
}
