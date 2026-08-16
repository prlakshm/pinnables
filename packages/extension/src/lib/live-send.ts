/** States a live send can occupy on the board and in the service. */
export type LiveSendState = "queued" | "starting" | "working" | "done" | "failed";

/** Board writes skip `queued` — that value is set only when the send is accepted. */
export type RecordableLiveSendState = Exclude<LiveSendState, "queued">;

const RANK: Record<LiveSendState, number> = {
  queued: 0,
  starting: 1,
  working: 2,
  done: 3,
  failed: 4,
};

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

/**
 * A run only moves forward. Done and failed are terminal: a later Working
 * poll (stale Cursor status, a follow-up steal) must not bounce the tag or
 * mint another take against a tree that is already wearing the result.
 */
export function advanceLiveSendState(
  from: LiveSendState,
  to: RecordableLiveSendState,
): LiveSendState {
  if (from === "done" || from === "failed") return from;
  if (from === to) return from;
  if (to === "failed") return "failed";
  return RANK[to] > RANK[from] ? to : from;
}

/** Message ids still in flight, unique, stable order — overlay polls these. */
export function pendingLiveSendIds(
  pins: ReadonlyArray<{
    liveSends: ReadonlyArray<{ messageId: string | null; state: LiveSendState }>;
  }>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    for (const sent of pin.liveSends) {
      if (!sent.messageId || seen.has(sent.messageId)) continue;
      if (!liveSendNeedsPoll(sent.state)) continue;
      seen.add(sent.messageId);
      ids.push(sent.messageId);
    }
  }
  return ids;
}
