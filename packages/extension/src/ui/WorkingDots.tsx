/**
 * The processing ellipsis, animated.
 *
 * Three dots that lift in turn, so a wait reads as work happening rather than
 * a screen that has stopped. It replaces the typed "…" everywhere something is
 * genuinely in flight — and only there, so motion keeps meaning "the machine
 * is busy" rather than becoming decoration.
 *
 * Decorative to assistive tech: the sentence beside it ("Agent is working",
 * "Waiting") already carries the state, and three animated dots read as noise
 * in a screen reader.
 */
export function WorkingDots() {
  return (
    <span className="pin-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
