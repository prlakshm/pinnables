import { useCallback, useEffect, useRef, useState } from "react";
import { type DrawShape } from "@pinnables/shared";
import { anchorForBox, buildDomPath, buildSelector, documentRect } from "../lib/capture";
import { InkLayer, usePlacedShapes } from "./InkLayer";
import type { DrawTool } from "./Toolbar";

export interface DrawingBuffer {
  read(): DrawShape[];
  /** Accept an authoritative refresh until this local session makes an edit. */
  sync(shapes: DrawShape[]): DrawShape[];
  /** Replace the local truth immediately, before React or the worker replies. */
  commit(shapes: DrawShape[]): DrawShape[];
}

/**
 * A draw session cannot use its last rendered `shapes` prop as an accumulator.
 * Two pointer-up events can land before the first background round trip and
 * both would append to the same old list, silently dropping the first stroke.
 */
export function createDrawingBuffer(initial: DrawShape[]): DrawingBuffer {
  let current = [...initial];
  let dirty = false;
  return {
    read: () => current,
    sync(shapes) {
      if (!dirty) current = [...shapes];
      return current;
    },
    commit(shapes) {
      dirty = true;
      current = [...shapes];
      return current;
    },
  };
}

/** Page typing wins over single-letter drawing shortcuts. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;
  if (typeof closest !== "function") return false;
  return Boolean(
    closest.call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ),
  );
}

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
  tool,
  color,
  onChange,
  onDone,
  onTool,
}: {
  shapes: DrawShape[];
  tool: DrawTool;
  color: string;
  onChange: (shapes: DrawShape[]) => void;
  onDone: () => void;
  onTool: (tool: DrawTool) => void;
}) {
  /** Points in document coordinates, only while the pointer is down. */
  const [draft, setDraft] = useState<Array<{ x: number; y: number }> | null>(null);
  const draftRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const buffer = useRef<DrawingBuffer | null>(null);
  if (!buffer.current) buffer.current = createDrawingBuffer(shapes);
  const [workingShapes, setWorkingShapes] = useState(() => buffer.current!.read());
  const drawingId = useRef(0);
  const placed = usePlacedShapes(workingShapes);

  /* Board data can arrive after the layer mounts. Once the user edits, local
     state stays ahead until this draw session ends instead of accepting an
     intermediate worker response that contains only some rapid strokes. */
  useEffect(() => {
    const synced = buffer.current!.sync(shapes);
    setWorkingShapes((current) => (current === synced ? current : synced));
  }, [shapes]);

  const commit = useCallback(
    (next: DrawShape[]) => {
      const committed = buffer.current!.commit(next);
      setWorkingShapes(committed);
      onChange(committed);
    },
    [onChange],
  );

  const pointAt = (event: React.PointerEvent) => ({
    x: event.clientX + window.scrollX,
    y: event.clientY + window.scrollY,
  });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 || tool !== "draw") return;
      const next = [pointAt(event), pointAt(event)];
      draftRef.current = next;
      setDraft(next);
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [tool],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!draftRef.current) return;
    const next = [...draftRef.current, pointAt(event)];
    draftRef.current = next;
    setDraft(next);
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

      const points = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (!points || points.length < 2) return;
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const box = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      };
      // A tap is not a stroke.
      if (box.width < 4 && box.height < 4) return;

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
        // Ownership is stamped by the overlay's save path, which knows the
        // current selection; a raw stroke starts page-level.
        ownerPinId: null,
      };
      commit([...buffer.current!.read(), shape]);
    },
    [color, commit],
  );

  const erase = useCallback(
    (shapeId: string) => commit(buffer.current!.read().filter((shape) => shape.id !== shapeId)),
    [commit],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDone();
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "e" && key !== "b") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "e") onTool(tool === "erase" ? "draw" : "erase");
      if (key === "b") onTool("draw");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDone, onTool, tool]);

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
        style={{
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }}
      />

      <InkLayer placed={placed} onErase={tool === "erase" ? erase : undefined} />

      {draftPath && (
        <svg
          className="pin-ink"
          data-draft="true"
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

    </>
  );
}
