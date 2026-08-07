import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DRAW_COLOR, DRAW_COLORS, type DrawShape } from "@pinnables/shared";
import { anchorForBox, buildDomPath, buildSelector, documentRect } from "../lib/capture";
import { CloseIcon, EraserIcon, PencilIcon } from "../ui/icons";
import { InkLayer, usePlacedShapes } from "./InkLayer";

type Tool = "draw" | "erase";

/**
 * Drawing on the live page.
 *
 * The earlier version froze the viewport to a screenshot and drew on that, which
 * made marks durable by making the page under them dead. This one keeps the page
 * alive and anchors each mark to the element it was drawn over, so it survives
 * the two things that used to break it — scrolling, and the page reflowing
 * underneath.
 *
 * Nothing here is committed. Marks belong to the route they were made on and
 * save as they are drawn, which is why there is no "pin region" button and why
 * they are still there when you navigate back.
 */
export function DrawLayer({
  shapes,
  onChange,
  onDone,
}: {
  shapes: DrawShape[];
  onChange: (shapes: DrawShape[]) => void;
  onDone: () => void;
}) {
  const [tool, setTool] = useState<Tool>("draw");
  const [color, setColor] = useState<string>(DEFAULT_DRAW_COLOR);
  /** Points in document coordinates, only while the pointer is down. */
  const [draft, setDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  const drawingId = useRef(0);
  const placed = usePlacedShapes(shapes);

  const pointAt = (event: React.PointerEvent) => ({
    x: event.clientX + window.scrollX,
    y: event.clientY + window.scrollY,
  });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 || tool !== "draw") return;
      setDraft([pointAt(event), pointAt(event)]);
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [tool],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    setDraft((current) => (current ? [...current, pointAt(event)] : current));
  }, []);

  /**
   * On release the stroke is measured, given an anchor, and rewritten as
   * fractions of that anchor's box. Everything after this point is relative —
   * which is the whole reason the mark can survive a resize.
   */
  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const target = event.currentTarget as Element;
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);

      setDraft((points) => {
        if (!points || points.length < 2) return null;
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const box = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
          height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
        };
        // A tap is not a stroke.
        if (box.width < 4 && box.height < 4) return null;

        const { element } = anchorForBox(box);
        const rect = documentRect(element);
        drawingId.current += 1;
        const shape: DrawShape = {
          id: `shape-${Date.now()}-${drawingId.current}`,
          kind: "freehand",
          color,
          points: points.map((p) => ({
            x: (p.x - rect.x) / Math.max(1, rect.width),
            y: (p.y - rect.y) / Math.max(1, rect.height),
          })),
          anchor: {
            selector: buildSelector(element),
            domPath: buildDomPath(element),
            rect,
          },
        };
        onChange([...shapes, shape]);
        return null;
      });
    },
    [color, shapes, onChange],
  );

  const erase = useCallback(
    (shapeId: string) => onChange(shapes.filter((s) => s.id !== shapeId)),
    [shapes, onChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDone();
        return;
      }
      if (event.key.toLowerCase() === "e") setTool((t) => (t === "erase" ? "draw" : "erase"));
      if (event.key.toLowerCase() === "b") setTool("draw");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  /** The stroke in progress, still in document pixels and not yet anchored. */
  const draftPath = draft
    ? `M${draft.map((p) => `${p.x} ${p.y}`).join("L")}`
    : null;

  return (
    <>
      <div
        className="pin-draw__surface"
        data-tool={tool}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ height: document.documentElement.scrollHeight }}
      />

      <InkLayer placed={placed} onErase={tool === "erase" ? erase : undefined} />

      {draftPath && (
        <svg
          className="pin-ink"
          width={document.documentElement.scrollWidth}
          height={document.documentElement.scrollHeight}
          aria-hidden
        >
          <path
            d={draftPath}
            stroke={color}
            strokeWidth={2.5}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}

      <div className="pin-draw__bar">
        <button
          className="pin-icon-btn"
          data-active={tool === "draw"}
          onClick={() => setTool("draw")}
          title="Draw · B"
          aria-label="Draw"
          aria-pressed={tool === "draw"}
        >
          <PencilIcon />
        </button>
        <button
          className="pin-icon-btn"
          data-active={tool === "erase"}
          onClick={() => setTool("erase")}
          title="Erase a whole stroke · E"
          aria-label="Erase"
          aria-pressed={tool === "erase"}
        >
          <EraserIcon />
        </button>

        <span className="pin-toolbar__divider" />

        {DRAW_COLORS.map((swatch) => (
          <button
            key={swatch}
            className="pin-draw__swatch"
            data-active={color === swatch}
            style={{ background: swatch }}
            onClick={() => {
              setColor(swatch);
              setTool("draw");
            }}
            title={`Draw in ${swatch}`}
            aria-label={`Draw in ${swatch}`}
          />
        ))}

        <span className="pin-toolbar__divider" />

        <button className="pin-icon-btn" onClick={onDone} title="Done · Esc" aria-label="Done drawing">
          <CloseIcon size={17} />
        </button>
      </div>
    </>
  );
}
