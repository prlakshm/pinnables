import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pathFor, type DrawShape } from "@pinnables/shared";
import { documentRect, refindElement } from "../lib/capture";

/**
 * The marks, drawn over the live page.
 *
 * This is the layer that is always on — draw mode adds a surface to draw *into*,
 * but what you already drew is rendered here whether or not you are drawing.
 * That is what makes marks feel like they belong to the page rather than to a
 * tool: they scroll out of view with the content, they are gone when you
 * navigate away, and they are waiting when you come back.
 *
 * Positioned in document space, not the viewport. Scrolling then costs nothing —
 * the layer scrolls with the page like any other absolutely positioned element,
 * so there is no scroll listener and no per-frame work. Only a reflow moves the
 * anchors, and only then do we re-measure.
 */

export interface PlacedShape {
  shape: DrawShape;
  /** The anchor's current box, in document coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  /** False when the anchor could not be re-found and we fell back to its old box. */
  found: boolean;
}

/** Resolve every mark against the page as it stands right now. */
export function placeShapes(shapes: DrawShape[]): PlacedShape[] {
  return shapes.map((shape) => {
    if (!shape.anchor) {
      // Frame-relative: a legacy mark with nothing on the page to hang off.
      return {
        shape,
        rect: { x: 0, y: 0, width: document.documentElement.scrollWidth, height: window.innerHeight },
        found: false,
      };
    }
    const hit = refindElement({
      selector: shape.anchor.selector,
      domPath: shape.anchor.domPath,
      elementText: "",
    });
    if (!hit) return { shape, rect: shape.anchor.rect, found: false };
    return { shape, rect: documentRect(hit.element), found: true };
  });
}

/** Marks scaled to fit the page as it is now, ready to paint. */
export function usePlacedShapes(shapes: DrawShape[]): PlacedShape[] {
  const [placed, setPlaced] = useState<PlacedShape[]>(() => placeShapes(shapes));

  const measure = useCallback(() => setPlaced(placeShapes(shapes)), [shapes]);

  useLayoutEffect(() => {
    measure();
    /*
     * Resize is the obvious trigger; a ResizeObserver on <body> is the one that
     * matters. A page that loads an image, opens an accordion, or streams a list
     * moves everything below it, and a mark that did not move with it is
     * pointing at the wrong thing — silently, which is the worst way to be
     * wrong.
     */
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return placed;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a placed mark actually sits on the page, in document coordinates. */
export function shapeBox(shape: DrawShape, rect: Box): Box | null {
  if (shape.points.length === 0) return null;
  const xs = shape.points.map((p) => rect.x + p.x * rect.width);
  const ys = shape.points.map((p) => rect.y + p.y * rect.height);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
  };
}

interface InkLayerProps {
  placed: PlacedShape[];
  /** Set while the eraser is up, so a mark can be clicked away. */
  onErase?: (shapeId: string) => void;
}

export function InkLayer({ placed, onErase }: InkLayerProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  useEffect(() => {
    const measure = () =>
      setSize({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);

  if (placed.length === 0) return null;

  return (
    <svg
      ref={ref}
      className="pin-ink"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      data-erasing={onErase ? "true" : "false"}
      aria-hidden
    >
      {placed.map(({ shape, rect }) => {
        const d = pathFor(shape, rect.width, rect.height);
        if (!d) return null;
        return (
          <g key={shape.id} transform={`translate(${rect.x} ${rect.y})`}>
            <path
              className="pin-ink__stroke"
              d={d}
              stroke={shape.color}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/*
              A 2.5px stroke is a hard thing to click. The fat invisible copy
              underneath is the hit target — one click anywhere near the line
              takes the whole line, which is what "erase" means here: strokes are
              atomic, not pixels you rub away.
            */}
            {onErase && (
              <path
                className="pin-ink__hit"
                d={d}
                stroke="transparent"
                strokeWidth={16}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  onErase(shape.id);
                }}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
