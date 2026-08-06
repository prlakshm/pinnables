/**
 * Theming for an overlay that has to sit on top of somebody else's product.
 *
 * Two problems, one system.
 *
 * The first is that a single accent cannot work everywhere — a fixed blue looks
 * deliberate on a white dashboard and looks like a bug on a blue one. Cursor
 * solves this with a *set* of mutually distinguishable hues assigned per item
 * rather than one accent, and every hue is a pair: a saturated value for
 * strokes and a light tint of the same hue for fills. A rotating set never has
 * to match the page, it only has to be distinguishable from its siblings.
 *
 * The second is light versus dark. `prefers-color-scheme` is the wrong signal —
 * it reports the OS, not the page, and a dark-themed app on a light OS is
 * exactly where the chrome would break. The scheme is derived from the host
 * page's own background luminance instead.
 */

export type Scheme = "light" | "dark";

export const SELECTION_HUES = ["teal", "rose", "green", "indigo", "clay"] as const;
export type SelectionHue = (typeof SELECTION_HUES)[number];

interface HuePair {
  /** Saturated. Chosen to read on a light background. */
  strong: string;
  /** Light tint of the same hue. Chosen to read on a dark background. */
  tint: string;
}

/**
 * Read out of cursor.com's own DOM — the CursorBench chart, which pairs a
 * saturated series colour with a light tint of the same hue. First-party
 * values, not estimated off a screenshot.
 */
const HUES: Record<SelectionHue, HuePair> = {
  teal: { strong: "#0e7490", tint: "#93c0cd" },
  rose: { strong: "#9f1239", tint: "#d494a6" },
  green: { strong: "#166534", tint: "#96baa4" },
  indigo: { strong: "#4f46e5", tint: "#b0acf3" },
  clay: { strong: "#c66a4a", tint: "#e5bcae" },
};

/** Cursor's verified neutrals. Warm, not the cool zinc shadcn defaults to. */
export const NEUTRALS = {
  light: { bg: "#f7f7f4", fg: "#26251e" },
  dark: { bg: "#1c1b16", fg: "#f7f7f4" },
} as const;

export const BRAND_ACCENT = "#f44e00";

/**
 * Three roles per hue, because one value cannot do all three jobs.
 *
 * `line` is the muted tint — Design Mode's outlines are the muted tier, not the
 * saturated one, and an outline is a large enough surface to stay legible soft.
 * `text` is saturated on light, because 12px chip text in the tint has nowhere
 * near enough contrast on white. `soft` is the tint at low alpha for fills.
 *
 * On dark the tint is already the light end of the pair, so it serves both line
 * and text; the saturated value would disappear into the background.
 */
export interface HueTokens {
  line: string;
  text: string;
  soft: string;
}

export function hueTokens(hue: SelectionHue, scheme: Scheme): HueTokens {
  const { strong, tint } = HUES[hue];
  return scheme === "dark"
    ? { line: tint, text: tint, soft: withAlpha(tint, 0.16) }
    : { line: tint, text: strong, soft: withAlpha(tint, 0.22) };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * A pin keeps the same hue for its whole life, derived from its id — indexing
 * into the board would reshuffle every colour whenever a pin is deleted.
 */
export function hueForPin(pinId: string): SelectionHue {
  let hash = 0;
  for (let i = 0; i < pinId.length; i += 1) hash = (hash * 31 + pinId.charCodeAt(i)) >>> 0;
  return SELECTION_HUES[hash % SELECTION_HUES.length];
}

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
 * Walk up from the body for the first background that actually paints. Pages
 * routinely leave `body` transparent and colour `html`, or the reverse, so the
 * first opaque one wins and light is the fallback.
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
