import { useCallback, useEffect, useRef, useState } from "react";
import { DRAW_COLORS } from "@pinnables/shared";
import { CloseIcon, CursorIcon, EraserIcon, GripIcon, PencilIcon, PinIcon } from "../ui/icons";

export type DrawTool = "draw" | "erase";

export type ToolMode = "browse" | "pin" | "draw";

interface ToolbarProps {
  mode: ToolMode;
  onMode: (mode: ToolMode) => void;
  pinCount: number;
  onExit: () => void;
  /** Draw mode swaps the bar's contents; these drive that half of it. */
  drawTool: DrawTool;
  onDrawTool: (tool: DrawTool) => void;
  drawColor: string;
  onDrawColor: (color: string) => void;
}

const POSITION_KEY = "toolbarPosition";
const VIEWPORT_GUTTER = 8;

interface ToolbarPosition {
  x: number;
  y: number;
}

interface ToolbarSize {
  width: number;
  height: number;
}

function clampAxis(value: number, size: number, viewportSize: number): number {
  const maximum = Math.max(VIEWPORT_GUTTER, viewportSize - size - VIEWPORT_GUTTER);
  return Math.min(maximum, Math.max(VIEWPORT_GUTTER, value));
}

export function clampToolbarPosition(
  position: ToolbarPosition,
  toolbar: ToolbarSize,
  viewport: ToolbarSize,
): ToolbarPosition {
  return {
    x: clampAxis(position.x, toolbar.width, viewport.width),
    y: clampAxis(position.y, toolbar.height, viewport.height),
  };
}

/**
 * Top-centre by default, and draggable from the grip. Pinning tends to start at
 * the top of a page, and a bar below the fold is a bar you forget is armed —
 * the tradeoff is that it can sit over a header, which is what dragging is for.
 */
export function Toolbar({
  mode,
  onMode,
  pinCount,
  onExit,
  drawTool,
  onDrawTool,
  drawColor,
  onDrawColor,
}: ToolbarProps) {
  const [position, setPosition] = useState<ToolbarPosition | null>(null);
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const clampPosition = useCallback((candidate: ToolbarPosition): ToolbarPosition => {
    const node = ref.current;
    if (!node) return candidate;
    return clampToolbarPosition(
      candidate,
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
  }, []);

  useEffect(() => {
    void chrome.storage.local.get(POSITION_KEY).then((bag) => {
      const stored = bag[POSITION_KEY] as ToolbarPosition | undefined;
      if (stored) setPosition(clampPosition(stored));
    });
  }, [clampPosition]);

  useEffect(() => {
    const keepReachable = () => {
      setPosition((current) => {
        if (!current) return current;
        const next = clampPosition(current);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    window.addEventListener("resize", keepReachable);
    return () => window.removeEventListener("resize", keepReachable);
  }, [clampPosition]);

  const onGripDown = useCallback((event: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const onGripMove = useCallback((event: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    setPosition(clampPosition({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }));
  }, [clampPosition]);

  const endDrag = useCallback((event: React.PointerEvent) => {
    dragging.current = null;
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    setPosition((current) => {
      if (current) void chrome.storage.local.set({ [POSITION_KEY]: current });
      return current;
    });
  }, []);

  const placement = position ? { left: position.x, top: position.y, transform: "none" } : undefined;

  const tools: Array<{ id: ToolMode; label: string; icon: React.ReactNode }> = [
    { id: "browse", label: "Browse the page", icon: <CursorIcon /> },
    { id: "pin", label: "Pin an element", icon: <PinIcon /> },
    { id: "draw", label: "Draw on a pin", icon: <PencilIcon /> },
  ];

  return (
    <div className="pin-toolbar" ref={ref} style={placement}>
      <span
        className="pin-toolbar__grip"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label="Drag toolbar"
      >
        <GripIcon size={17} />
      </span>

      {/*
        * One bar, everything on it. Draw used to swap the bar's contents, which
        * meant the tools you were not holding vanished — and a mode you cannot
        * see the exit from is a mode people get stuck in. Pencil and eraser sit
        * with the other tools; picking a pen colour is itself a way to start
        * drawing.
        */}
      {tools.map((tool) => (
        <button
          key={tool.id}
          className="pin-icon-btn"
          data-active={mode === tool.id && (tool.id !== "draw" || drawTool === "draw")}
          onClick={() => {
            onMode(tool.id);
            if (tool.id === "draw") onDrawTool("draw");
          }}
          title={tool.label}
          aria-label={tool.label}
          aria-pressed={mode === tool.id && (tool.id !== "draw" || drawTool === "draw")}
        >
          {tool.icon}
        </button>
      ))}

      <button
        className="pin-icon-btn"
        data-active={mode === "draw" && drawTool === "erase"}
        onClick={() => {
          onMode("draw");
          onDrawTool("erase");
        }}
        title="Erase a whole stroke · E"
        aria-label="Erase"
        aria-pressed={mode === "draw" && drawTool === "erase"}
      >
        <EraserIcon />
      </button>

      <span className="pin-toolbar__divider" />

      {/*
        * A stack, not a row. The one you are using sits in front and the rest
        * peek out behind it; hovering fans them out to pick from, and choosing
        * one brings it to the front and closes the stack again.
        *
        * Four permanent circles is a lot of colour to leave sitting in a bar
        * that is otherwise entirely greyscale — and colour is the loudest thing
        * on it, so it was pulling attention to the least important control.
        */}
      <span className="pin-pens" role="group" aria-label="Pen colour">
        {[drawColor, ...DRAW_COLORS.filter((c) => c !== drawColor)].map((swatch, i) => (
          <button
            key={swatch}
            className="pin-pen"
            data-active={drawColor === swatch}
            style={{ background: swatch, "--i": i } as React.CSSProperties}
            onClick={() => {
              onDrawColor(swatch);
              onMode("draw");
              onDrawTool("draw");
            }}
            title={`Draw in ${swatch}`}
            aria-label={`Draw in ${swatch}`}
            aria-pressed={drawColor === swatch}
          />
        ))}
      </span>

      <span className="pin-toolbar__divider" />

      {/* A readout, not a control. Opening the panel from here needed a user
          gesture the worker could not always be handed, so the affordance was
          promising something it could not reliably do — and the extension icon
          opens the panel anyway. */}
      <span className="pin-toolbar__board" title={`${pinCount} pinned`}>
        Board
        <span className={pinCount > 99 ? "pin-badge pin-badge--wide" : "pin-badge"}>{pinCount}</span>
      </span>

      <span className="pin-toolbar__divider" />

      <button
        className="pin-icon-btn"
        onClick={onExit}
        title="Exit capture mode · Esc"
        aria-label="Exit capture mode"
      >
        <CloseIcon size={17} />
      </button>
    </div>
  );
}
