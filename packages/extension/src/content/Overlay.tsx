import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { OVERLAY_HOST_ID, maskSensitive, measureElement, refindElement } from "../lib/capture";
import { send } from "../lib/messages";
import type { OverlayApi } from "./mount";
import { Toolbar, type ToolMode } from "./Toolbar";
import { PinObject } from "./PinObject";
import { DrawLayer } from "./DrawLayer";

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

const posKey = (pinId: string) => `pos:${pinId}`;

export function OverlayRoot({ api }: { api: OverlayApi }) {
  const state = useSyncExternalStore(api.subscribe, api.snapshot);
  const [mode, setMode] = useState<ToolMode>("pin");
  const [board, setBoard] = useState<Board | null>(null);
  const [highlight, setHighlight] = useState<HighlightBox | null>(null);
  const [positions, setPositions] = useState<Record<string, FloatPosition>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [justPinned, setJustPinned] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const hovered = useRef<Element | null>(null);

  /* ------------------------------------------------------------- board sync */

  useEffect(() => {
    let cancelled = false;
    void send("board/get", {})
      .then(({ board: next }) => {
        if (!cancelled) setBoard(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.revision]);

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

  /* ----------------------------------------------------------------- picker */

  const isOurs = (node: EventTarget | null): boolean =>
    node instanceof Element && (node.id === OVERLAY_HOST_ID || node.closest(`#${OVERLAY_HOST_ID}`) !== null);

  useEffect(() => {
    if (!state.enabled || mode !== "pin" || capturing) {
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
  }, [state.enabled, mode, capturing]);

  const capture = useCallback(async (element: Element) => {
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
      window.setTimeout(() => setJustPinned((id) => (id === pin.id ? null : id)), 900);
    } catch (err) {
      console.error("[pinnables] capture failed", err);
    } finally {
      unmask();
      setCapturing(false);
    }
  }, [persistPosition]);

  useEffect(() => {
    if (!state.enabled || mode !== "pin") return;

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
  }, [state.enabled, mode, capture]);

  /* -------------------------------------------------------------- esc layer */

  useEffect(() => {
    if (!state.enabled) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Draw mode owns Escape while it is up — it has a frozen frame to discard.
      if (mode === "draw") return;

      // Layered, never a bare global handler — Escape belongs to the page
      // underneath us until we have something of our own to dismiss.
      const target = event.target as Element | null;
      const typingInOurs =
        target instanceof Element &&
        (target.closest(`#${OVERLAY_HOST_ID}`) !== null ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA");
      if (typingInOurs) return;

      if (mode !== "browse") {
        event.preventDefault();
        setMode("browse");
        return;
      }
      event.preventDefault();
      void send("capture/setMode", { enabled: false });
    };

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state.enabled, mode]);

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

  const pins: Pin[] = board?.pins ?? [];
  const drawing = mode === "draw";
  // Floating pins would sit on top of the frozen frame and get drawn around,
  // so they stand down while a region is being marked.
  const visible = drawing ? [] : pins.filter((p) => !dismissed.has(p.id));

  return (
    <div className="pin-overlay">
      {drawing && <DrawLayer onDone={() => setMode("pin")} />}

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
          onMove={(next) => persistPosition(pin.id, next)}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(pin.id))}
          onChanged={api.refresh}
        />
      ))}

      {/* Draw mode brings its own bar — two floating toolbars is one too many. */}
      {!drawing && (
        <Toolbar
          mode={mode}
          onMode={setMode}
          pinCount={pins.length}
          onOpenBoard={() => void send("capture/setMode", { enabled: true })}
          onExit={() => void send("capture/setMode", { enabled: false })}
        />
      )}
    </div>
  );
}
