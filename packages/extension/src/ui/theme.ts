/**
 * Palette and scheme detection.
 *
 * Values are sampled from the brand palette artboard in Paper, not eyeballed.
 * The rotating per-selection hue set that used to live here is retired — see
 * `brand/palettes/warm-rose.md` for the values and the reasoning, kept because
 * the system may be worth returning to. Selection is now one grey and one blue,
 * which is a simpler promise: the overlay never competes with the page, and
 * colour carries state rather than identity.
 */

export type Scheme = "light" | "dark";

export const PALETTE = {
  /**
   * The named tokens out of the Paper file, not values read off a screenshot.
   * Sampling a rendered artboard was giving me colours that were close and
   * wrong — `#76cafd` for sky, `#0953dd` for cobalt — because a JPEG of a
   * design is not the design.
   */
  paper: "#f6f5f3",
  surface: "#ffffff",
  line: "#e4e2de",
  ink: "#292c33",
  /** Also the grey the toolbar icons are drawn in — measured at #636264–#6e6c6d
   *  in the reference render, which is this token under JPEG. */
  inkMuted: "#6b6f78",
  cobalt: "#1e3fd8",
  sky: "#9bd3f9",
  skyTint: "#e4f1fd",
  red: "#ed1c24",

  /**
   * Sampled rather than tokenised, each for a reason.
   *
   * `skyFill` is the disc behind the active tool and the badge fill, measured
   * off the nav reference — a step deeper than `skyTint`, which is what makes
   * the active tool read as switched on rather than merely tinted.
   *
   * `redSoft` is the lit shoulder of the flat mark, the one red that can sit
   * behind the true red without either disappearing.
   */
  skyFill: "#d1e1f8",
  redSoft: "#f4564b",
} as const;

const DARK = "(prefers-color-scheme: dark)";

/**
 * The scheme comes from the browser, not from the page underneath.
 *
 * This used to read the host page's own background luminance, on the theory
 * that chrome should sit comfortably on whatever it floats over. That was
 * backwards. Chrome that dresses like the page reads as *part of* the page —
 * exactly wrong for a tool whose entire job is being visibly separate from the
 * design you are judging. DevTools is dark over light pages all day and nobody
 * finds it confusing, because it is obviously furniture.
 *
 * It also meant the toolbar and the side panel could disagree with each other:
 * a dark shelf beside a light toolbar, one product looking like two. They are
 * both Pinnables, so they take the same signal.
 */
export function detectScheme(): Scheme {
  return window.matchMedia(DARK).matches ? "dark" : "light";
}

/** Re-run when the browser or OS flips. */
export function watchScheme(onChange: (scheme: Scheme) => void): () => void {
  const query = window.matchMedia(DARK);
  const handle = (event: MediaQueryListEvent) => onChange(event.matches ? "dark" : "light");
  query.addEventListener("change", handle);
  return () => query.removeEventListener("change", handle);
}

export type AnchorEdge = "left" | "right" | "top" | "bottom";
export const ANCHOR_EDGES: AnchorEdge[] = ["left", "right", "top", "bottom"];

/**
 * Which edge shows an anchor by default, given where the card sits on screen.
 *
 * A card near the right edge of the viewport has nothing to its right worth
 * connecting to, so its anchor belongs on the left; one near the top gets its
 * anchor on the bottom. Whichever side has the most room to run a wire into
 * wins, and horizontal beats vertical on a tie because pins usually end up side
 * by side rather than stacked.
 */
export function defaultEdgeFor(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): AnchorEdge {
  const room = {
    left: rect.left,
    right: viewport.width - rect.right,
    top: rect.top,
    bottom: viewport.height - rect.bottom,
  };
  const horizontal: AnchorEdge = room.left >= room.right ? "left" : "right";
  const vertical: AnchorEdge = room.top >= room.bottom ? "top" : "bottom";
  return Math.max(room.left, room.right) >= Math.max(room.top, room.bottom) ? horizontal : vertical;
}

/** The edge midpoint the pointer is nearest, if it is close enough to mean it. */
export function nearestEdge(
  rect: { left: number; right: number; top: number; bottom: number },
  point: { x: number; y: number },
  threshold = 56,
): AnchorEdge | null {
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const mid: Record<AnchorEdge, { x: number; y: number }> = {
    left: { x: rect.left, y: cy },
    right: { x: rect.right, y: cy },
    top: { x: cx, y: rect.top },
    bottom: { x: cx, y: rect.bottom },
  };
  let best: AnchorEdge | null = null;
  let bestDistance = threshold;
  for (const edge of ANCHOR_EDGES) {
    const d = Math.hypot(mid[edge].x - point.x, mid[edge].y - point.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = edge;
    }
  }
  return best;
}
