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
  /** Active tool fill, badge fill. */
  skyBlue: "#76cafd",
  /** Active tool glyph, badge text, primary action. */
  cobalt: "#0953dd",
  /** Brand mark, edge anchors, delete. Never chrome. */
  red: "#f41616",
  /** The lighter red off the flat mark. Anchor halo, destructive hover fill. */
  redSoft: "#f4564b",
  charcoal: "#2b2e34",
  offWhite: "#fbf9f7",
  /**
   * Estimated from the toolbar reference rather than sampled — that image was
   * pasted, not saved. Carries the selection outline and the pinned-card
   * hairline, so it has to be visible without reading as a colour.
   */
  grey: "#8a8d93",
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
