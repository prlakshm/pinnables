import { STYLE_ALLOWLIST, STYLE_INITIAL_VALUES } from "@pinnables/shared";
import type { CapturedElement } from "./messages";

import { OVERLAY_HOST_ID } from "./overlay-host";

export { OVERLAY_HOST_ID };

/**
 * CSS initial values, per property. A captured style set that repeats the
 * defaults for thirty properties buries the handful that actually differ, so
 * anything still sitting at its initial value is dropped.
 */
export function readComputedStyles(el: Element): Record<string, string> {
  const computed = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const property of STYLE_ALLOWLIST) {
    const value = computed.getPropertyValue(property).trim();
    if (!value) continue;
    if (STYLE_INITIAL_VALUES[property] === value) continue;
    out[property] = value;
  }
  return out;
}

/** A selector that is specific enough to re-find the element but not brittle. */
export function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;

  while (node && node !== document.body && depth < 4) {
    let part = node.tagName.toLowerCase();
    const classes = Array.from(node.classList)
      .filter((c) => !/^(ng-|css-|sc-|jsx-)/.test(c) && !/\d{4,}/.test(c))
      .slice(0, 2);
    if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join("");

    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }

    parts.unshift(part);
    if (node.id) break;
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(" > ");
}

/** A coarser, more stable fallback than the selector. */
export function buildDomPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += `#${node.id}`;
    else if (node.classList.length) part += `.${node.classList[0]}`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

type FiberNode = {
  return: FiberNode | null;
  elementType?: { name?: string; displayName?: string } | string | null;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
};

function findFiber(el: Element): FiberNode | null {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  return key ? ((el as unknown as Record<string, FiberNode>)[key] ?? null) : null;
}

/**
 * Source mapping. The build-time plugin stamping data-pin-source is the primary
 * path and the only one that is reliable; fiber introspection reads dev-only
 * internals that have already changed across React versions (_debugSource was
 * removed in React 19), so it is a best-effort fallback.
 */
export function findSourceFile(el: Element): string | null {
  const stamped = el.closest("[data-pin-source]")?.getAttribute("data-pin-source");
  if (stamped) return stamped;

  let fiber = findFiber(el);
  let hops = 0;
  while (fiber && hops < 12) {
    const src = fiber._debugSource;
    if (src?.fileName) {
      const file = src.fileName.replace(/^.*\/(src\/)/, "$1");
      return src.lineNumber ? `${file}:${src.lineNumber}` : file;
    }
    fiber = fiber.return;
    hops += 1;
  }
  return null;
}

export function findComponentName(el: Element): string | null {
  const stamped = el.closest("[data-pin-component]")?.getAttribute("data-pin-component");
  if (stamped) return stamped;

  let fiber = findFiber(el);
  let hops = 0;
  while (fiber && hops < 12) {
    const type = fiber.elementType;
    if (type && typeof type !== "string") {
      const name = type.displayName ?? type.name;
      if (name && /^[A-Z]/.test(name)) return name;
    }
    fiber = fiber.return;
    hops += 1;
  }
  return null;
}

const HEADING = "h1, h2, h3, h4, h5, h6, [role='heading']";
/**
 * Landmarks that wrap a whole region of the page rather than one piece of
 * content. These are named before any heading found inside them: a heading in
 * the site header belongs to some menu within it, not to the header — vercel.com
 * has a mega-menu whose first heading is "Agent Stack", which is a true fact
 * about a dropdown and a wrong name for the masthead.
 *
 * `figure`, `form`, `dialog` and `table` are deliberately not here. A heading
 * inside those is genuinely theirs.
 */
const REGIONS = new Set(["header", "footer", "nav", "main", "aside"]);
const LANDMARKS: Record<string, string> = {
  nav: "nav",
  header: "header",
  footer: "footer",
  main: "main",
  aside: "aside",
  form: "form",
  figure: "figure",
  dialog: "dialog",
  table: "table",
};

/**
 * Words a person typed into a class name, as opposed to a framework's output.
 *
 * Only compound classes qualify — `logo-strip`, `site-footer`, `hero_banner`.
 * A bare `grid` or `banner` is as likely to be a utility class as a name, and
 * on a Tailwind page every element would answer to one.
 */
const CLASS_VOCABULARY = new Set([
  "banner", "hero", "masthead", "header", "footer", "nav", "navbar", "sidebar",
  "logo", "logos", "marquee", "toolbar", "modal", "dialog", "drawer", "carousel",
  "gallery", "testimonial", "pricing", "cta", "callout", "breadcrumb", "pagination",
  "avatar", "thumbnail", "badge", "tooltip", "accordion", "tabs", "stepper",
]);

function humanize(token: string): string {
  return token.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function classHint(el: Element): string {
  for (const name of Array.from(el.classList)) {
    if (!/[-_]/.test(name)) continue;
    if (/^(ng-|css-|sc-|jsx-)/.test(name) || /\d{4,}/.test(name)) continue;
    // Tailwind's variants (`@lg:flex`, `hover:bg-x`) are never authored names.
    if (name.includes(":") || name.includes("[")) continue;
    const words = name.toLowerCase().split(/[-_]+/);
    if (words.some((word) => CLASS_VOCABULARY.has(word))) return humanize(name);
  }
  return "";
}

/**
 * What the element is made of, when it is made of named pictures.
 *
 * This is the rung that names a logo strip. Marketing pages label their logos
 * for screen readers and nothing else — no text, no heading, no landmark — so
 * the only words in a row of eight customer marks are the eight names on the
 * marks themselves. Naming it after the first one would be a lie about the
 * other seven, so it says how many it stood among.
 */
function graphicNames(el: Element): string {
  const seen: string[] = [];
  el.querySelectorAll("img, svg, [role='img']").forEach((graphic) => {
    const name =
      graphic.getAttribute("aria-label") ??
      graphic.getAttribute("alt") ??
      (graphic.tagName === "svg" ? (graphic.querySelector("title")?.textContent ?? null) : null);
    const trimmed = name?.replace(/\s+/g, " ").trim();
    // Deduplicated: a marquee repeats its row to scroll seamlessly, and the
    // second copy is the same logo, not a second customer.
    if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
  });

  if (seen.length === 0) return "";
  if (seen.length === 1) return seen[0];
  const pair = `${seen[0]}, ${seen[1]}`;
  const rest = seen.length - 2;
  return rest > 0 ? `${pair} + ${rest}` : pair;
}

/** The name the page's author wrote for assistive tech, if they wrote one. */
function authoredName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const named = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (named.trim()) return named;
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return title;

  if (el.tagName === "IMG") {
    const alt = el.getAttribute("alt");
    if (alt?.trim()) return alt;
  }
  const svgTitle = el.tagName === "svg" ? el.querySelector("title")?.textContent : null;
  if (svgTitle?.trim()) return svgTitle;

  return "";
}

/**
 * What to call an element the build knows nothing about.
 *
 * On your own app the dev plugin stamps a component name and none of this runs.
 * Off it — a competitor's page, a design you are borrowing from — there is no
 * name anywhere, and the ladder below is a descent through progressively weaker
 * evidence, each rung still something a person could point at on screen:
 *
 *   1. the name its author wrote for screen readers, which is the closest thing
 *      to a component name that exists on a site you do not own
 *   2. its region, when it is one of the five that wrap a whole page area
 *   3. its heading, which names a section by what the section says — better than
 *      the flattened text, where the heading arrives fused to the body copy
 *   4. its own text
 *   5. the names of the pictures inside it, for components made of icons
 *   6. its remaining landmark or role
 *   7. a class somebody wrote by hand, when the class says something
 *   8. the picker's own words, exactly as the hover chip said them a moment ago
 *
 * Five is where the interesting case lives. Vercel's customer strip is a plain
 * div of utility classes with no label, no heading, no text and no landmark —
 * every rung above it comes back empty — and yet the words are right there, on
 * the logos: `svg aria-label="OpenAI"`, seven times over. "Blackbox, Charles
 * Schwab + 5" is a name; "div" is a shrug.
 *
 * Eight still exists because seven can miss, and "div · 1276×108" is at least
 * true and already the language on screen.
 */
export function describeElement(el: Element): string {
  const authored = authoredName(el);
  if (authored) return truncate(authored, 28);

  const tag = el.tagName.toLowerCase();
  if (REGIONS.has(tag)) return tag;

  const heading = el.matches(HEADING) ? el : el.querySelector(HEADING);
  const headingText = heading?.textContent?.trim();
  if (headingText) return truncate(headingText, 28);

  const text = (el.textContent ?? "").trim();
  if (text) return truncate(text, 28);

  const graphics = graphicNames(el);
  if (graphics) return truncate(graphics, 28);

  const role = el.getAttribute("role");
  const landmark = LANDMARKS[tag] ?? (role ? role.toLowerCase() : null);
  if (landmark) return landmark;

  const hint = classHint(el);
  if (hint) return truncate(hint, 28);

  const rect = el.getBoundingClientRect();
  return `${el.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

/**
 * Password fields are redacted from the pixels, not just the DOM — a screenshot
 * shows whatever is on screen. Opaque covers go up, the shot is taken, the
 * covers come down. Returns the undo.
 */
export function maskSensitive(): () => void {
  /*
   * A text selection is part of the screenshot.
   *
   * Clicking around to choose an element leaves highlighted words behind, and
   * `captureVisibleTab` photographs the page as it is — so the pin arrives with
   * a blue band across it and the agent is handed a picture of the component
   * plus whatever was selected a moment earlier. The selection is state of the
   * session, never of the component.
   *
   * Ranges are put back rather than dropped: the user did not ask to lose their
   * selection, they asked for a picture without it.
   */
  const selection = window.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i).cloneRange());
    selection.removeAllRanges();
  }

  const targets = document.querySelectorAll<HTMLElement>(
    'input[type="password"], [data-pin-redact]',
  );
  const covers: HTMLElement[] = [];

  for (const target of targets) {
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const cover = document.createElement("div");
    cover.setAttribute("data-pinnables-cover", "");
    Object.assign(cover.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: "#292c33",
      borderRadius: getComputedStyle(target).borderRadius,
      zIndex: "2147482999",
      pointerEvents: "none",
    });
    document.body.appendChild(cover);
    covers.push(cover);
  }

  return () => {
    covers.forEach((c) => c.remove());
    if (selection && ranges.length > 0) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  };
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * The stable route identity for both history- and hash-routed applications.
 *
 * A normal fragment such as `#pricing` is an in-page anchor, not a new screen.
 * Hash routers, however, put the entire route after `#` (`#/settings` or
 * `#!/settings`). In that case the hash path is the route; ignoring it merges
 * every screen in the app into `/` and makes pins and drawings bleed between
 * pages.
 */
export function routeForLocation(
  value: Pick<Location, "pathname" | "search" | "hash"> = window.location,
): string {
  if (value.hash.startsWith("#!/")) return value.hash.slice(2);
  if (value.hash.startsWith("#/")) return value.hash.slice(1);
  return value.pathname + value.search;
}

export function measureElement(el: Element): CapturedElement {
  const rect = el.getBoundingClientRect();
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    devicePixelRatio: window.devicePixelRatio || 1,
    url: location.href,
    route: routeForLocation(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    selector: buildSelector(el),
    domPath: buildDomPath(el),
    outerHtml: truncate(el.outerHTML, 600),
    classList: Array.from(el.classList),
    elementText: truncate(el.textContent ?? "", 120),
    elementLabel: describeElement(el),
    componentName: findComponentName(el),
    sourceFile: findSourceFile(el),
    computedStyles: readComputedStyles(el),
  };
}

/**
 * Re-find a pinned element after navigation or a hot reload. Layered, in
 * descending confidence — below the text-match rung we would rather report
 * "not found" and show the screenshot than highlight the wrong node.
 */
export function refindElement(pin: {
  selector: string;
  domPath: string;
  elementText: string;
}): { element: Element; confidence: number } | null {
  const trySelector = (sel: string): Element | null => {
    try {
      const matches = document.querySelectorAll(sel);
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  };

  const bySelector = trySelector(pin.selector);
  if (bySelector) return { element: bySelector, confidence: 1 };

  const byPath = trySelector(pin.domPath);
  if (byPath) return { element: byPath, confidence: 0.8 };

  if (pin.elementText.length > 8) {
    const needle = pin.elementText.replace(/…$/, "");
    const candidates = Array.from(document.body.querySelectorAll("*")).filter(
      (el) => el.children.length < 12 && (el.textContent ?? "").includes(needle),
    );
    // The deepest match is the tightest wrapper around the text.
    const deepest = candidates[candidates.length - 1];
    if (deepest) return { element: deepest, confidence: 0.55 };
  }

  return null;
}

/**
 * Which element a mark should hang off.
 *
 * The frozen-frame model made marks durable by making the world under them
 * dead. Anchoring keeps them durable while the world stays alive: store a mark
 * as fractions of an element's box and it moves and resizes with that element
 * through any reflow, because it is measured in the same units the layout is.
 *
 * The walk goes up from whatever is under the mark's centre until it finds a box
 * that contains the whole mark, so a circle drawn *around* a card anchors to the
 * card's container rather than to the card it encloses. `body` is the last
 * resort — a mark on it scales with the page, which is where we started.
 */
export function anchorForBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { element: Element; rect: DOMRect } {
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const start = document.elementFromPoint(centre.x - scrollX, centre.y - scrollY);
  let node: Element | null =
    start && !start.closest(`#${OVERLAY_HOST_ID}`) ? start : document.body;

  // A mark thinner than a hairline in one axis still needs a real box to sit in.
  const pad = 1;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    const contains =
      rect.left + scrollX <= box.x + pad &&
      rect.top + scrollY <= box.y + pad &&
      rect.right + scrollX >= box.x + box.width - pad &&
      rect.bottom + scrollY >= box.y + box.height - pad;
    if (contains && rect.width > 0 && rect.height > 0) return { element: node, rect };
    node = node.parentElement;
  }
  return { element: document.body, rect: document.body.getBoundingClientRect() };
}

/** The anchor's box in document coordinates, which is the space marks are stored in. */
export function documentRect(element: Element): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
}
