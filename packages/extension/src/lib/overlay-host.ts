/**
 * The id of the overlay's shadow host, alone in its own module.
 *
 * Both tiers need it — tier 1 to clear a dead script's leftovers on arrival,
 * `mountOverlay` to clear them again on the way in — but tier 1 is meant to be
 * a listener and nothing else, and importing it from `capture.ts` dragged 4KB
 * of capture machinery onto every page for the sake of one string.
 */
export const OVERLAY_HOST_ID = "pinnables-overlay-host";
