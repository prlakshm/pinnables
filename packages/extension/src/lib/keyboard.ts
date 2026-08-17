/**
 * Keyboard helpers shared by the overlay, the rail, and the annotation box.
 *
 * Two facts this file exists to keep true:
 *  1. Events from our shadow-root composer are retargeted to the host by the
 *     time a `document` / `window` listener sees them. `event.target.closest`
 *     then misses the textarea, and a shortcut steals the keystroke.
 *  2. On a Mac, Option+1 types "¡". Chrome often reports that keydown with
 *     `altKey === false`, so a handler that only checks `e.altKey` never
 *     jumps — and the glyph lands in the annotation box instead.
 */

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

/** macOS Option+DigitN glyphs (US layout). Used when `altKey` is missing. */
export const OPTION_DIGIT_GLYPHS: Record<string, number> = {
  "\u00A1": 1, // ¡
  "\u2122": 2, // ™
  "\u00A3": 3, // £
  "\u00A2": 4, // ¢
  "\u221E": 5, // ∞
  "\u00A7": 6, // §
  "\u00B6": 7, // ¶
  "\u2022": 8, // •
  "\u00AA": 9, // ª
};

export function deepActiveElement(): Element | null {
  if (typeof document === "undefined") return null;
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

function elementIsEditable(node: EventTarget | null): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as Element;
  if (typeof el.matches === "function" && el.matches(EDITABLE_SELECTOR)) return true;
  if (typeof el.closest === "function" && el.closest(EDITABLE_SELECTOR)) return true;
  return false;
}

/** Page typing wins over single-letter drawing / tool shortcuts. */
export function isEditableKeyboardTarget(
  target: EventTarget | null,
  event?: Event,
): boolean {
  if (event && typeof event.composedPath === "function") {
    for (const node of event.composedPath()) {
      if (elementIsEditable(node)) return true;
    }
  }
  if (elementIsEditable(target)) return true;
  return elementIsEditable(deepActiveElement());
}

/**
 * ⌥+digit: the physical key (`e.code`) is the numeral. On a Mac Option+1
 * types "¡", so `e.key === "1"` would never restore.
 */
export function versionShortcutDigit(e: { code: string; key: string }): number | null {
  const fromCode = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^Numpad([1-9])$/.exec(e.code)?.[1];
  if (fromCode) return Number(fromCode);
  const fromGlyph = OPTION_DIGIT_GLYPHS[e.key];
  if (fromGlyph) return fromGlyph;
  if (e.code === "" && /^[1-9]$/.test(e.key)) return Number(e.key);
  return null;
}

/** True when this keydown is the Option/Alt + numeral chord, including Mac glyphs. */
export function versionJumpDigit(e: {
  code: string;
  key: string;
  altKey: boolean;
}): number | null {
  const want = versionShortcutDigit(e);
  if (want === null) return null;
  if (e.altKey) return want;
  if (OPTION_DIGIT_GLYPHS[e.key] === want) return want;
  return null;
}

export function stepVersionNo(
  current: number | null,
  nos: readonly number[],
  direction: 1 | -1,
): number | null {
  if (nos.length === 0) return null;
  const ordered = [...nos].sort((a, b) => a - b);
  if (current == null) return direction === 1 ? ordered[0]! : ordered[ordered.length - 1]!;
  const at = ordered.indexOf(current);
  if (at < 0) return ordered[0]!;
  return ordered[(at + direction + ordered.length) % ordered.length]!;
}

/**
 * Spec (toggle-redesign): arrows step versions unless a caret has somewhere
 * to move — a page field, or our annotation draft once it has words.
 */
export function arrowsShouldStepVersions(event?: Event): boolean {
  const el = deepActiveElement();
  const tag = el && "tagName" in el ? String((el as { tagName?: string }).tagName) : "";
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const field = el as { classList?: { contains: (c: string) => boolean }; value?: string };
    if (field.classList?.contains("pin-note__input")) return (field.value ?? "").trim() === "";
  }
  if (elementIsEditable(el)) return false;
  if (event && isEditableKeyboardTarget(el, event)) return false;
  return true;
}
