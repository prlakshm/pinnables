/**
 * Theming for an overlay that has to sit on top of somebody else's product.
 *
 * Two problems, one system.
 *
 * The first is that a single accent cannot work everywhere — a fixed blue looks
 * deliberate on a white dashboard and looks like a bug on a blue one. Cursor
 * solves this with a *set* of mutually distinguishable hues assigned per item
 * rather than one accent. A rotating set never has to match the page; it only
 * has to be distinguishable from its siblings, which is a far easier bar.
 *
 * The second is light versus dark. `prefers-color-scheme` is the wrong signal —
 * it reports the OS, not the page, and a dark-themed app on a light OS is
 * exactly where the chrome would break. The scheme is derived from the host
 * page's own background luminance instead.
 */

export type Scheme = "light" | "dark";

/**
 * Six hues, rose first.
 *
 * The *system* is Design Mode's and worth keeping: a rotating set assigned per
 * selection rather than one accent, so the chrome never has to match a page it
 * has never seen — it only has to stay distinguishable from its siblings.
 *
 * The *values* are ours. Using Cursor's literal palette in a product positioned
 * against Cursor would read as a reskin rather than an argument, and the
 * ordering gave it away as much as the colours did. So these are derived to the
 * same constraints — 42 degrees minimum separation, mid-lightness so one value
 * serves both schemes, muted enough not to fight the product underneath — in a
 * softer register, and rose leads instead of blue.
 */
export const SELECTION_HUES = ["rose", "plum", "fern", "apricot", "sky", "stone"] as const;
export type SelectionHue = (typeof SELECTION_HUES)[number];

/**
 * Sampled pixel-by-pixel out of a Design Mode screenshot — see
 * `scripts/sample-outline-colors.mjs`. These are the actual stroke values, not
 * estimates: eight hues, each mid-lightness and moderately saturated.
 *
 * That pitch is the whole trick. Saturated enough to separate from each other
 * and from the page, muted enough not to fight the product underneath, and
 * mid-lightness so the same value works on a white app and a dark one without
 * a second palette.
 */
const HUES: Record<SelectionHue, string> = {
  rose: "#e0708c",
  plum: "#a865c0",
  fern: "#5aa876",
  apricot: "#eda265",
  sky: "#6aa6d4",
  /*
   * Sixth, and the only one that does not compete on hue. No opening is left on
   * the wheel wider than 42° except the one yellow would fill, and yellow
   * cannot hold contrast on white without darkening into an olive. This
   * separates on chroma instead — near-neutral, so it cannot crowd anything
   * added later — and is deepened to 3.9:1, because the softer greys it came
   * from sat at 2.6:1 and vanished against a white header. Last in the
   * rotation: it reads quieter than the other five, and six simultaneous
   * selections are rare.
   */
  stone: "#8a8079",
};

/** Cursor's verified neutrals. Warm, not the cool zinc shadcn defaults to. */
export const NEUTRALS = {
  light: { bg: "#f7f7f4", fg: "#26251e" },
  dark: { bg: "#1c1b16", fg: "#f7f7f4" },
} as const;

export const BRAND_ACCENT = "#f44e00";

/**
 * One value per hue does stroke and text; only the fill alpha changes with the
 * scheme. The sampled values sit at mid-lightness by design, so they hold
 * contrast against white and near-black alike — a second dark palette would
 * solve a problem these values already avoid. Dark carries a little more fill
 * because a 10% wash disappears on a dark ground.
 */
export interface HueTokens {
  line: string;
  text: string;
  soft: string;
}

export function hueTokens(hue: SelectionHue, scheme: Scheme): HueTokens {
  const value = HUES[hue];
  return {
    line: value,
    text: value,
    soft: withAlpha(value, scheme === "dark" ? 0.18 : 0.1),
  };
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Hues are handed out in creation order, cycling — the first pin is blue, the
 * ninth is blue again. A hash of the id would be stable against deletion but
 * would scatter the colours, and the sequence is the recognisable part: the
 * first thing you pin is always blue.
 */
export function hueForIndex(index: number): SelectionHue {
  return SELECTION_HUES[((index % SELECTION_HUES.length) + SELECTION_HUES.length) % SELECTION_HUES.length];
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
