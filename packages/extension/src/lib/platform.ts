/**
 * Shortcut labels resolve per platform — ⌘↵ on macOS, Ctrl↵ everywhere else.
 * navigator.userAgentData is not available in every context the overlay runs
 * in, so fall back to the platform string.
 */
const isMac = /mac/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "",
);

export const modKeyLabel = isMac ? "⌘" : "Ctrl";
export const submitHintLabel = `${modKeyLabel}↵`;

/** True when the event carries the platform's primary modifier. */
export function hasModifier(event: KeyboardEvent | MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
