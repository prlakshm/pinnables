import type { DrawShape } from "./schema.js";

/**
 * Shape geometry, once.
 *
 * These emit SVG path data, which the side panel renders as <path> and the
 * service worker strokes via `new Path2D(d)` on a canvas. One implementation
 * means a drawing can never look different in the panel than it does in the
 * PNG the agent receives.
 *
 * All input points are normalised 0–1 against the frozen frame; `width` and
 * `height` are whatever size that frame is being drawn at.
 */

/**
 * The pens. The one place in the product where colour is content rather than
 * chrome — a mark you made, not a control you are using, which is why blue lives
 * here and nowhere else. Values are the shared primitives; `check-tokens` holds
 * this list to them so the two palettes cannot fork.
 */
export const DRAW_COLORS = ["#292C33", "#ED1C24", "#9BD3F9", "#1E3FD8"] as const;
export const DEFAULT_DRAW_COLOR: string = DRAW_COLORS[0];

/** Stroke width scales with the frame so a mark reads the same at any size. */
export function strokeWidthFor(width: number): number {
  return Math.max(2, Math.round(width / 260));
}

export function pathFor(shape: DrawShape, width: number, height: number): string {
  const pts = shape.points.map((p) => ({ x: p.x * width, y: p.y * height }));
  const [a, b] = pts;

  switch (shape.kind) {
    case "rect": {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const r = Math.min(6, w / 2, h / 2);
      return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
    }

    case "ellipse": {
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      if (rx < 0.5 || ry < 0.5) return "";
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
    }

    case "arrow": {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 4) return "";
      const head = Math.min(18, len * 0.32);
      const spread = 0.42;
      const h1x = b.x - head * Math.cos(angle - spread);
      const h1y = b.y - head * Math.sin(angle - spread);
      const h2x = b.x - head * Math.cos(angle + spread);
      const h2y = b.y - head * Math.sin(angle + spread);
      return `M${a.x} ${a.y}L${b.x} ${b.y}M${h1x} ${h1y}L${b.x} ${b.y}L${h2x} ${h2y}`;
    }

    case "freehand": {
      if (pts.length < 2) return "";
      // Quadratic smoothing through midpoints — a raw polyline of pointer
      // samples reads as jagged at any real drawing speed.
      let d = `M${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        d += `Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
      }
      const last = pts[pts.length - 1];
      d += `L${last.x} ${last.y}`;
      return d;
    }
  }
}

/** Bounding box of every shape, normalised, or null when there are none. */
export function drawingsBounds(
  shapes: readonly DrawShape[],
): { x: number; y: number; width: number; height: number } | null {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const p of shape.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Human-readable summary for the agent brief — pixels mean nothing to it. */
export function describeDrawings(shapes: readonly DrawShape[]): string {
  if (shapes.length === 0) return "";
  const counts = new Map<string, number>();
  for (const shape of shapes) counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
  // Anchored marks name what they were drawn on, which is worth telling the
  // agent: "over .stat-card" is a much stronger hint than "somewhere on screen".
  const anchors = [...new Set(shapes.map((s) => s.anchor?.selector).filter(Boolean))];
  const over = anchors.length > 0 ? ` over ${anchors.slice(0, 3).join(", ")}` : "";
  return `${parts.join(", ")} drawn on the page${over}`;
}
