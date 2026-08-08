import { useCallback, useEffect, useRef, useState } from "react";
import { DRAW_COLORS } from "@pinnables/shared";
import { CloseIcon, CursorIcon, EraserIcon, GripIcon, PencilIcon, PinIcon } from "../ui/icons";

export type DrawTool = "draw" | "erase";

export type ToolMode = "browse" | "pin" | "draw";

interface ToolbarProps {
  mode: ToolMode;
  onMode: (mode: ToolMode) => void;
  pinCount: number;
  onOpenBoard: () => void;
  onExit: () => void;
  /** Draw mode swaps the bar's contents; these drive that half of it. */
  drawTool: DrawTool;
  onDrawTool: (tool: DrawTool) => void;
  drawColor: string;
  onDrawColor: (color: string) => void;
}

const POSITION_KEY = "toolbarPosition";

/**
 * Top-centre by default, and draggable from the grip. Pinning tends to start at
 * the top of a page, and a bar below the fold is a bar you forget is armed —
 * the tradeoff is that it can sit over a header, which is what dragging is for.
 */
export function Toolbar({
  mode,
  onMode,
  pinCount,
  onOpenBoard,
  onExit,
  drawTool,
  onDrawTool,
  drawColor,
  onDrawColor,
}: ToolbarProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void chrome.storage.local.get(POSITION_KEY).then((bag) => {
      const stored = bag[POSITION_KEY] as { x: number; y: number } | undefined;
      if (stored) setPosition(stored);
    });
  }, []);

  const onGripDown = useCallback((event: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    (event.target as Element).setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const onGripMove = useCallback((event: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    const width = ref.current?.offsetWidth ?? 0;
    const height = ref.current?.offsetHeight ?? 0;
    setPosition({
      x: Math.min(Math.max(8, event.clientX - drag.dx), window.innerWidth - width - 8),
      y: Math.min(Math.max(8, event.clientY - drag.dy), window.innerHeight - height - 8),
    });
  }, []);

  const onGripUp = useCallback(() => {
    dragging.current = null;
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
        onPointerUp={onGripUp}
        aria-label="Drag toolbar"
      >
        <GripIcon size={17} />
      </span>

      {/*
        * Draw mode changes what this bar holds rather than putting a second bar
        * on top of it. Two pills at the same place is two borders and two
        * shadows pretending to be one control.
        */}
      {mode === "draw" ? (
        <>
          <button
            className="pin-icon-btn"
            data-active={drawTool === "draw"}
            onClick={() => onDrawTool("draw")}
            title="Draw · B"
            aria-label="Draw"
            aria-pressed={drawTool === "draw"}
          >
            <PencilIcon />
          </button>
          <button
            className="pin-icon-btn"
            data-active={drawTool === "erase"}
            onClick={() => onDrawTool("erase")}
            title="Erase a whole stroke · E"
            aria-label="Erase"
            aria-pressed={drawTool === "erase"}
          >
            <EraserIcon />
          </button>

          <span className="pin-toolbar__divider" />

          {DRAW_COLORS.map((swatch) => (
            <button
              key={swatch}
              className="pin-draw__swatch"
              data-active={drawColor === swatch}
              style={{ background: swatch }}
              onClick={() => {
                onDrawColor(swatch);
                onDrawTool("draw");
              }}
              title={`Draw in ${swatch}`}
              aria-label={`Draw in ${swatch}`}
            />
          ))}

          <span className="pin-toolbar__divider" />

          <button
            className="pin-icon-btn"
            onClick={() => onMode("pin")}
            title="Done drawing · Esc"
            aria-label="Done drawing"
          >
            <CloseIcon size={17} />
          </button>
        </>
      ) : (
        <>
          {tools.map((tool) => (
            <button
              key={tool.id}
              className="pin-icon-btn"
              data-active={mode === tool.id}
              onClick={() => onMode(tool.id)}
              title={tool.label}
              aria-label={tool.label}
              aria-pressed={mode === tool.id}
            >
              {tool.icon}
            </button>
          ))}

          <span className="pin-toolbar__divider" />

          <button className="pin-toolbar__board" onClick={onOpenBoard} title="Open the annotation board">
            Board
            <span className={pinCount > 99 ? "pin-badge pin-badge--wide" : "pin-badge"}>{pinCount}</span>
          </button>

          <span className="pin-toolbar__divider" />

          <button
            className="pin-icon-btn"
            onClick={onExit}
            title="Exit capture mode · Esc"
            aria-label="Exit capture mode"
          >
            <CloseIcon size={17} />
          </button>
        </>
      )}
    </div>
  );
}
