/**
 * Where the overlay writes down what is on screen, and who gets to read it.
 *
 * Both of these used to be one global key each, written by whichever content
 * script ran last. With a single page open that is indistinguishable from
 * correct. With two it is a race: standing on your app, the shelf reported the
 * pins seated on a vercel.com tab as being in front of you, and standing on
 * vercel.com it reported none at all — the pin was still seated there, the
 * record of it had simply been overwritten by the other tab.
 *
 * The two are scoped differently because they answer different questions.
 */

/**
 * Focus is a fact about a page, so it is keyed by origin.
 *
 * Not by route: an HMR reload lands at `/` and only reaches `/catalogue` once
 * the SPA's router runs, so a key carrying the route would look up the wrong
 * page and find nothing at the one moment this exists to survive. The route
 * lives inside the snapshot instead, where `overlayFocusRestoreDecision` can
 * wait for the app to catch up.
 */
export function overlayFocusKey(origin: string): string {
  return `overlayFocus:${origin}`;
}

/**
 * What is on screen is a fact about a tab, so it is keyed by tab id.
 *
 * The shelf's filled pin means "this is in front of you right now", and two
 * tabs cannot both be in front of you.
 */
export function onScreenPinsKey(tabId: number): string {
  return `onScreenPins:${tabId}`;
}

export function isOnScreenPinsKey(key: string): boolean {
  return key.startsWith("onScreenPins:");
}

/** Written by every build before these were scoped. Cleared, never read. */
export const LEGACY_PRESENCE_KEYS = ["onScreenPins", "overlayFocus"];
