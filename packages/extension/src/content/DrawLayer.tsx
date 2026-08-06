import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DRAW_COLOR,
  DRAW_COLORS,
  pathFor,
  strokeWidthFor,
  type DrawShape,
} from "@pinnables/shared";
import { ExtensionReloadedError, send } from "../lib/messages";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { CheckIcon, CloseIcon } from "../ui/icons";

type ShapeKind = DrawShape["kind"];

const SHAPES: Array<{ kind: ShapeKind; label: string }> = [
  { kind: "ellipse", label: "Circle a section" },
  { kind: "rect", label: "Box a region" },
  { kind: "arrow", label: "Point at something" },
  { kind: "freehand", label: "Free mark" },
];

/**
 * Drawing happens over a frozen frame of the viewport, not the live page.
 *
 * That single decision is what makes marks durable: a coordinate-anchored
 * overlay on a live page drifts the moment anything reflows, and can't mark an
 * animated element at all. Freeze first and there is nothing left to
 * re-anchor — the frame is the record.
 */
export function DrawLayer({ onDone, onStale }: { onDone: () => void; onStale: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [kind, setKind] = useState<ShapeKind>("ellipse");
  const [color, setColor] = useState<string>(DEFAULT_DRAW_COLOR);
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [drafting, setDrafting] = useState<DrawShape | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const drawingId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void send("capture/freeze", {})
      .then((res) => {
        if (!cancelled) setFrame(res.frame);
      })
      .catch(() => onDone());
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  const toNormalized = useCallback((event: React.PointerEvent) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const point = toNormalized(event);
      drawingId.current += 1;
      setDrafting({
        id: `shape-${drawingId.current}`,
        kind,
        points: [point, point],
        color,
      });
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [kind, color, toNormalized],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      setDrafting((current) => {
        if (!current) return current;
        const point = toNormalized(event);
        return current.kind === "freehand"
          ? { ...current, points: [...current.points, point] }
          : { ...current, points: [current.points[0], point] };
      });
    },
    [toNormalized],
  );

  const onPointerUp = useCallback(() => {
    setDrafting((current) => {
      if (!current) return null;
      const [a, b] = current.points;
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      // A click with no drag is not a shape.
      if (current.points.length < 3 && moved < 0.008) return null;
      setShapes((prev) => [...prev, current]);
      return null;
    });
  }, []);

  const undo = useCallback(() => setShapes((prev) => prev.slice(0, -1)), []);

  const cancel = useCallback(() => {
    void send("capture/discardFreeze", {});
    onDone();
  }, [onDone]);

  const commit = useCallback(async () => {
    if (shapes.length === 0) return;
    setSaving(true);
    try {
      await send("capture/region", {
        shapes,
        url: location.href,
        route: location.pathname + location.search,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        label: label.trim() || "marked region",
      });
      onDone();
    } catch (err) {
      if (err instanceof ExtensionReloadedError) onStale();
      else console.error("[pinnables] region capture failed", err);
      setSaving(false);
    }
  }, [shapes, label, onDone, onStale]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key.toLowerCase() === "z" && hasModifier(event)) {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key === "Enter" && hasModifier(event)) {
        event.preventDefault();
        void commit();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancel, undo, commit]);

  if (!frame) return null;

  const rect = surface.current?.getBoundingClientRect();
  const w = rect?.width ?? window.innerWidth;
  const h = rect?.height ?? window.innerHeight;
  const visible = drafting ? [...shapes, drafting] : shapes;

  return (
    <div className="pin-draw">
      <div
        className="pin-draw__surface"
        ref={surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <img className="pin-draw__frame" src={frame} alt="" draggable={false} />
        <svg className="pin-draw__ink" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {visible.map((shape) => {
            const d = pathFor(shape, w, h);
            return d ? (
              <path
                key={shape.id}
                d={d}
                fill="none"
                stroke={shape.color}
                strokeWidth={strokeWidthFor(w)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null;
          })}
        </svg>
      </div>

      <div className="pin-draw__bar">
        {SHAPES.map((shape) => (
          <button
            key={shape.kind}
            className="pin-icon-btn"
            data-active={kind === shape.kind}
            onClick={() => setKind(shape.kind)}
            title={shape.label}
            aria-label={shape.label}
            aria-pressed={kind === shape.kind}
          >
            <ShapeGlyph kind={shape.kind} />
          </button>
        ))}

        <span className="pin-toolbar__divider" />

        {DRAW_COLORS.map((swatch) => (
          <button
            key={swatch}
            className="pin-draw__swatch"
            data-active={color === swatch}
            style={{ background: swatch }}
            onClick={() => setColor(swatch)}
            title={`Draw in ${swatch}`}
            aria-label={`Draw in ${swatch}`}
          />
        ))}

        <span className="pin-toolbar__divider" />

        <input
          className="pin-field"
          style={{ width: 180 }}
          placeholder="Name this region…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />

        <button className="pin-btn" onClick={undo} disabled={shapes.length === 0}>
          Undo
        </button>
        <button
          className="pin-btn pin-btn--primary"
          onClick={() => void commit()}
          disabled={shapes.length === 0 || saving}
        >
          <CheckIcon size={14} />
          {saving ? "Pinning…" : "Pin region"}
          <span className="pin-kbd" style={{ borderColor: "rgba(255,255,255,.4)", color: "#fff" }}>
            {submitHintLabel}
          </span>
        </button>
        <button className="pin-icon-btn" onClick={cancel} title="Cancel · Esc" aria-label="Cancel">
          <CloseIcon size={17} />
        </button>
      </div>
    </div>
  );
}

function ShapeGlyph({ kind }: { kind: ShapeKind }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "ellipse":
      return (
        <svg {...props}>
          <ellipse cx="10" cy="10" rx="7.2" ry="5.6" />
        </svg>
      );
    case "rect":
      return (
        <svg {...props}>
          <rect x="3.2" y="5" width="13.6" height="10" rx="2" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...props}>
          <path d="M4 16L16 4M16 4h-6.5M16 4v6.5" />
        </svg>
      );
    case "freehand":
      return (
        <svg {...props}>
          <path d="M3.5 13.5c3-6 5-6 6.5-2.5s3.5 3.5 6.5-3" />
        </svg>
      );
  }
}
