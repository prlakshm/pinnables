/** States a live send can occupy on the board and in the service. */
export type LiveSendState = "queued" | "starting" | "working" | "done" | "failed";

/** Board writes skip `queued` — that value is set only when the send is accepted. */
export type RecordableLiveSendState = Exclude<LiveSendState, "queued">;

/**
 * The history tag is a fact on the pin, not on whichever bar is open.
 * `queued` stays until the service says the run has left the queue;
 * everything after that is recordable so the tag can move Queued → Sending
 * → Working → Done even if the person has selected something else.
 */
export function recordableLiveSendState(
  state: LiveSendState,
): RecordableLiveSendState | null {
  return state === "queued" ? null : state;
}

export function liveSendNeedsPoll(state: LiveSendState): boolean {
  return state === "queued" || state === "starting" || state === "working";
}
