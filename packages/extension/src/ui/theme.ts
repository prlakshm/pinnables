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

/** WCAG relative luminance, for deciding which side of the fence a colour is on. */
function luminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseRgb(value: string): [number, number, number, number] | null {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/**
 * The scheme comes from the host page's own background, not from
 * prefers-color-scheme — that setting reports the OS, and a dark app on a light
 * OS is exactly where the chrome would break. Pages routinely leave `body`
 * transparent and colour `html`, or the reverse, so the first opaque one wins.
 */
export function detectScheme(): Scheme {
  for (const node of [document.body, document.documentElement].filter(Boolean)) {
    const parsed = parseRgb(getComputedStyle(node).backgroundColor);
    if (!parsed) continue;
    const [r, g, b, a] = parsed;
    if (a < 0.5) continue;
    return luminance(r, g, b) < 0.45 ? "dark" : "light";
  }
  return "light";
}

/** Re-run the check when the host page flips its own theme. */
export function watchScheme(onChange: (scheme: Scheme) => void): () => void {
  let current = detectScheme();
  const check = () => {
    const next = detectScheme();
    if (next !== current) {
      current = next;
      onChange(next);
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  if (document.body) {
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  }
  return () => observer.disconnect();
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
