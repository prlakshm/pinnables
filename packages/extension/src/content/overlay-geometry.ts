export interface ViewportSize {
  width: number;
  height: number;
}

export interface OverlayPosition {
  x: number;
  y: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayRect extends OverlayPosition, OverlaySize {}

/** Bounds relative to a floating object's own x/y origin. */
export interface OverlayFootprint {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CapturedFrame extends OverlayRect {}

export interface PlacedCapturedFrame extends OverlayRect {
  partial: boolean;
}

export interface GroupComposerPlacement extends OverlayPosition {
  width: number;
}

/** Map a visible screenshot crop back into the displayed full element box. */
export function placeCapturedFrame(
  captured: OverlaySize,
  displayed: OverlaySize,
  frame?: CapturedFrame,
): PlacedCapturedFrame {
  const valid = captured.width > 0 && captured.height > 0;
  const source = frame ?? { x: 0, y: 0, width: captured.width, height: captured.height };
  const scaleX = valid ? displayed.width / captured.width : 1;
  const scaleY = valid ? displayed.height / captured.height : 1;
  const px = (value: number) => Math.round(value * 1_000) / 1_000;
  const partial =
    source.x > 0 ||
    source.y > 0 ||
    source.width < captured.width ||
    source.height < captured.height;
  return {
    x: px(source.x * scaleX),
    y: px(source.y * scaleY),
    width: px(source.width * scaleX),
    height: px(source.height * scaleY),
    partial,
  };
}

const VIEWPORT_GUTTER = 4;
const BESIDE_GAP = 12;

function clampAxis(value: number, minimum: number, maximum: number): number {
  // An object larger than the viewport cannot satisfy both edges. Pin its
  // leading edge to the gutter so its controls remain reachable.
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Keep an object's complete visual footprint inside the current viewport. */
export function clampFloatingPosition(
  position: OverlayPosition,
  footprint: OverlayFootprint,
  viewport: ViewportSize,
  gutter = VIEWPORT_GUTTER,
): OverlayPosition {
  return {
    x: clampAxis(
      position.x,
      gutter - footprint.left,
      viewport.width - gutter - footprint.right,
    ),
    y: clampAxis(
      position.y,
      gutter - footprint.top,
      viewport.height - gutter - footprint.bottom,
    ),
  };
}

/** Place a new floating pin beside its source, preferring the source's right. */
export function placeFloatingPinBeside(
  source: OverlayRect,
  floating: OverlaySize,
  viewport: ViewportSize,
): OverlayPosition {
  const right = source.x + source.width + BESIDE_GAP;
  const left = source.x - floating.width - BESIDE_GAP;
  const x =
    right + floating.width <= viewport.width - VIEWPORT_GUTTER
      ? right
      : left >= VIEWPORT_GUTTER
        ? left
        : right;

  return clampFloatingPosition(
    { x, y: source.y },
    { left: 0, top: 0, right: floating.width, bottom: floating.height },
    viewport,
  );
}

/**
 * The annotation bar is one width, everywhere: 380px.
 *
 * It was briefly sized from the selection, so a bar under a small card came out
 * small. That reads tidier in a screenshot and worse in use — the box is where
 * you write a sentence, and how wide the component happens to be says nothing
 * about how much room that sentence needs. A single width also means the bar
 * never resizes as the selection moves between components, so it stays a fixed
 * place on screen to type into.
 *
 * 380 comfortably clears the placeholder ("Describe a change or stash for
 * later", 216.2px at 13px SF Pro, plus 126px of padding, ⌘↵ chip and send
 * button — 342 total), with headroom for stacks whose metrics run wider than
 * SF Pro. It narrows only when the viewport genuinely cannot fit it.
 */
export const COMPOSER_WIDTH = 380;

export function placeGroupComposer(
  group: { left: number; right: number; bottom: number },
  viewport: ViewportSize,
): GroupComposerPlacement {
  const gutter = 12;
  const width = Math.max(0, Math.min(COMPOSER_WIDTH, viewport.width - gutter * 2));
  const centered = (group.left + group.right) / 2 - width / 2;
  return {
    x: clampAxis(centered, gutter, viewport.width - gutter - width),
    y: clampAxis(group.bottom + 12, gutter, viewport.height - 120),
    width,
  };
}

/** A small-enough element can be made fully visible before a screenshot crop. */
export function shouldRevealForCapture(rect: OverlayRect, viewport: ViewportSize): boolean {
  const fits = rect.width <= viewport.width && rect.height <= viewport.height;
  const clipped =
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > viewport.width ||
    rect.y + rect.height > viewport.height;
  return fits && clipped;
}

/** The smallest document-space box containing every supplied box. */
export function unionBoxes(boxes: readonly OverlayRect[]): OverlayRect | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
