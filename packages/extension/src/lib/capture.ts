import { STYLE_ALLOWLIST } from "@pinnables/shared";
import type { CapturedElement } from "./messages";

export const OVERLAY_HOST_ID = "pinnables-overlay-host";

/**
 * CSS initial values, per property. A captured style set that repeats the
 * defaults for thirty properties buries the handful that actually differ, so
 * anything still sitting at its initial value is dropped.
 */
const INITIAL: Record<string, string> = {
  "margin-top": "0px",
  "margin-right": "0px",
  "margin-bottom": "0px",
  "margin-left": "0px",
  "padding-top": "0px",
  "padding-right": "0px",
  "padding-bottom": "0px",
  "padding-left": "0px",
  gap: "normal",
  "border-radius": "0px",
  "border-width": "0px",
  "border-style": "none",
  "box-shadow": "none",
  "background-color": "rgba(0, 0, 0, 0)",
  "letter-spacing": "normal",
  "text-align": "start",
  position: "static",
  "grid-template-columns": "none",
  "flex-direction": "row",
  "justify-content": "normal",
  "align-items": "normal",
};

export function readComputedStyles(el: Element): Record<string, string> {
  const computed = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const property of STYLE_ALLOWLIST) {
    const value = computed.getPropertyValue(property).trim();
    if (!value) continue;
    if (INITIAL[property] === value) continue;
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

/**
 * Password fields are redacted from the pixels, not just the DOM — a screenshot
 * shows whatever is on screen. Opaque covers go up, the shot is taken, the
 * covers come down. Returns the undo.
 */
export function maskSensitive(): () => void {
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

  return () => covers.forEach((c) => c.remove());
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export function measureElement(el: Element): CapturedElement {
  const rect = el.getBoundingClientRect();
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    devicePixelRatio: window.devicePixelRatio || 1,
    url: location.href,
    route: location.pathname + location.search,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    selector: buildSelector(el),
    domPath: buildDomPath(el),
    outerHtml: truncate(el.outerHTML, 600),
    classList: Array.from(el.classList),
    elementText: truncate(el.textContent ?? "", 120),
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
