export interface CssCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BitmapCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the visible crop belongs inside the element's full border box. */
export interface VisibleElementFrame extends CssCropRect {}

/**
 * Intersect an element with the CSS viewport without losing its local offset.
 *
 * The bitmap itself contains only this intersection. Persisting the offset is
 * what lets the floating pin keep the component's full, truthful geometry
 * instead of stretching a partial screenshot over pixels that were never
 * photographed.
 */
export function visibleElementFrame(
  rect: CssCropRect,
  viewport: { width: number; height: number },
): VisibleElementFrame | null {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: left - rect.x,
    y: top - rect.y,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Intersect a CSS-pixel element rect with a screenshot bitmap.
 *
 * `captureVisibleTab` contains only the viewport. A partially offscreen element
 * previously clamped its start to zero but kept its full width, which pulled
 * neighbouring page pixels into the pin. Clamping both edges preserves exactly
 * the visible intersection and always leaves a drawable one-pixel rectangle.
 */
export function bitmapCropRect(
  rect: CssCropRect,
  devicePixelRatio: number,
  bitmapWidth: number,
  bitmapHeight: number,
): BitmapCropRect {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const width = Math.max(1, Math.floor(bitmapWidth));
  const height = Math.max(1, Math.floor(bitmapHeight));
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(maximum, Math.max(minimum, value));

  const x = clamp(Math.round(rect.x * scale), 0, width - 1);
  const y = clamp(Math.round(rect.y * scale), 0, height - 1);
  const right = clamp(Math.round((rect.x + rect.width) * scale), x + 1, width);
  const bottom = clamp(Math.round((rect.y + rect.height) * scale), y + 1, height);

  return { x, y, width: right - x, height: bottom - y };
}
