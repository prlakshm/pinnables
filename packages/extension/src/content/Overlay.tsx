import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { OVERLAY_HOST_ID, maskSensitive, measureElement, refindElement } from "../lib/capture";
import { ExtensionReloadedError, send } from "../lib/messages";
import type { OverlayApi } from "./mount";
import { Toolbar, type ToolMode } from "./Toolbar";
import { PinObject, type AnchorEdge } from "./PinObject";
import { DrawLayer } from "./DrawLayer";
import { detectScheme, hueForPin, hueTokens, watchScheme, type Scheme } from "../ui/theme";

interface HighlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
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
  const [board, setBoard] = useState<Board | null>(null);
  const [highlight, setHighlight] = useState<HighlightBox | null>(null);
  const [positions, setPositions] = useState<Record<string, FloatPosition>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [justPinned, setJustPinned] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [cardRects, setCardRects] = useState<Record<string, DOMRect>>({});
  const [scheme, setScheme] = useState<Scheme>(() => detectScheme());
  const hovered = useRef<Element | null>(null);
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

  const persistPosition = useCallback((pinId: string, position: FloatPosition) => {
    setPositions((prev) => ({ ...prev, [pinId]: position }));
    void chrome.storage.local.set({ [posKey(pinId)]: position });
  }, []);

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
  }, [positions, board, selected, dismissed]);

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
        setSelected(pin.id);
        window.setTimeout(() => setJustPinned((id) => (id === pin.id ? null : id)), 900);
      } catch (err) {
        if (!guard(err)) console.error("[pinnables] capture failed", err);
      } finally {
        unmask();
        setCapturing(false);
      }
    },
    [persistPosition, guard],
  );

  useEffect(() => {
    if (!state.enabled || mode !== "pin" || stale || connecting) return;

    const onClick = (event: MouseEvent) => {
      if (isOurs(event.target)) return;
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
      setSelected(null);
    };

    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [state.enabled, selected]);

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
      if (selected) {
        event.preventDefault();
        setSelected(null);
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
  }, [state.enabled, mode, selected, connecting, guard]);

  /* --------------------------------------------------------- reveal a pin */

  useEffect(() => {
    if (!state.reveal) return;
    const found = refindElement(state.reveal);
    if (!found) {
      setHighlight(null);
      return;
    }
    found.element.scrollIntoView({ behavior: "smooth", block: "center" });
    const rect = found.element.getBoundingClientRect();
    setHighlight({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      label: found.confidence === 1 ? "exact match" : `${Math.round(found.confidence * 100)}% match`,
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
  const visible = drawing ? [] : pins.filter((p) => !dismissed.has(p.id));

  // Existing relationships, resolved to on-screen endpoints. A wire takes its
  // source pin's hue, so it is obvious which card a connection leaves from.
  const wires: Array<{ id: string; d: string; from: Point; to: Point; color: string }> = [];
  if (board && !drawing) {
    for (const rel of board.relationships) {
      const a = cardRects[rel.sourcePinId];
      if (!a) continue;
      const color = hueTokens(hueForPin(rel.sourcePinId), scheme).line;
      for (const targetId of rel.targetPinIds) {
        const b = cardRects[targetId];
        if (!b) continue;
        const [ea, eb] = bestEdges(a, b);
        const from = edgePoint(a, ea);
        const to = edgePoint(b, eb);
        wires.push({ id: `${rel.id}-${targetId}`, d: wirePath(from, to), from, to, color });
      }
    }
  }

  const draft =
    connecting && cardRects[connecting.fromPinId]
      ? {
          from: edgePoint(cardRects[connecting.fromPinId], connecting.fromEdge),
          to: connecting.cursor,
          color: hueTokens(hueForPin(connecting.fromPinId), scheme).line,
        }
      : null;

  return (
    <div className="pin-overlay">
      {drawing && <DrawLayer onDone={() => setMode("pin")} onStale={() => setStale(true)} />}

      {!drawing && (wires.length > 0 || draft) && (
        <svg className="pin-wires" aria-hidden>
          {wires.map((wire) => (
            <g key={wire.id}>
              <path className="pin-wire" d={wire.d} stroke={wire.color} />
              <circle cx={wire.from.x} cy={wire.from.y} r="3.5" fill={wire.color} />
              <circle cx={wire.to.x} cy={wire.to.y} r="3.5" fill={wire.color} />
            </g>
          ))}
          {draft && (
            <>
              <path
                className="pin-wire pin-wire--draft"
                d={wirePath(draft.from, draft.to)}
                stroke={draft.color}
              />
              <circle cx={draft.from.x} cy={draft.from.y} r="3.5" fill={draft.color} />
            </>
          )}
        </svg>
      )}

      {highlight && !drawing && (
        <div
          className="pin-highlight"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
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
          selected={selected === pin.id}
          connecting={connecting !== null}
          hue={hueTokens(hueForPin(pin.id), scheme)}
          onSelect={() => setSelected(pin.id)}
          onMove={(next) => persistPosition(pin.id, next)}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(pin.id))}
          onChanged={api.refresh}
          onAnchorDown={onAnchorDown}
          onAnchorEnter={(pinId, edge) => (hoverAnchor.current = { pinId, edge })}
          onAnchorLeave={() => (hoverAnchor.current = null)}
        />
      ))}

      {/* Draw mode brings its own bar — two floating toolbars is one too many. */}
      {!drawing && (
        <Toolbar
          mode={mode}
          onMode={setMode}
          pinCount={pins.length}
          onOpenBoard={() => void send("capture/setMode", { enabled: true }).catch(guard)}
          onExit={() => void send("capture/setMode", { enabled: false }).catch(guard)}
        />
      )}
    </div>
  );
}
