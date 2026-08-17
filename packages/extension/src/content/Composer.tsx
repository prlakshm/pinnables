import { useCallback, useEffect, useRef, useState } from "react";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { isLostLiveSendError, recordableLiveSendState } from "../lib/live-send";
import { send } from "../lib/messages";
import { ArrowUpRightIcon, LinkIcon } from "../ui/icons";
import { WorkingDots } from "../ui/WorkingDots";

interface ComposerProps {
  /** How many pins this prompt will be written to. Drives the placeholder. */
  count: number;
  /** Stash the text on the board (the pin's annotation). */
  onCommit: (text: string) => Promise<void>;
  onRelate?: () => void;
  autoFocus?: boolean;
  /** Override the placeholder — surfaces with their own copy pass it. */
  placeholder?: string;
  /**
   * When set, this bar speaks both destinations like the live selection bar:
   * Enter/arrow sends the message to the agent for these pins, ⌘Enter
   * stashes it on the board. Absent, the bar is stash-only (old behavior).
   */
  agentPinIds?: string[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  /** Accepted by the service, but the agent is not confirmed running yet. */
  | { kind: "starting"; messageId: string }
  | { kind: "working"; messageId: string }
  | { kind: "done" }
  | { kind: "failed"; detail: string }
  | { kind: "staged-offline" }
  | { kind: "staged" };

const STATUS_POLL_MS = 2_500;
/** Still "starting" after this long means the run never truly began. */
const STARTING_TIMEOUT_MS = 5 * 60_000;
/** "Working" with no outcome after this long is treated as stuck. */
const WORKING_TIMEOUT_MS = 10 * 60_000;

/**
 * One prompt, however many pins — and one line.
 *
 * Shared by every pill on the page: docked under a capture card, floating
 * beneath a multi-selection. Whatever it is attached to, the chords mean the
 * same thing everywhere — Enter to the agent, ⌘Enter stashed to the board —
 * because two bars that look identical and behave differently would be worse
 * than either behavior alone.
 */
export function Composer({ count, onCommit, onRelate, autoFocus, agentPinIds, placeholder }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [chordHeld, setChordHeld] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pollTimers = useRef<Map<string, number>>(new Map());
  const watchingId = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  useEffect(
    () => () => {
      alive.current = false;
      for (const handle of pollTimers.current.values()) window.clearTimeout(handle);
      pollTimers.current.clear();
    },
    [],
  );

  const agentEnabled = (agentPinIds?.length ?? 0) > 0;

  useEffect(() => {
    if (!agentEnabled) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setChordHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setChordHeld(false);
    };
    const clear = () => setChordHeld(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", clear);
    };
  }, [agentEnabled]);

  // A stash receipt confirms and leaves. The offline fallback stays: it
  // reports a problem the user has to go fix, and a notice that clears
  // itself reads as a problem that did.
  useEffect(() => {
    if (phase.kind !== "staged") return;
    const timer = window.setTimeout(() => setPhase({ kind: "idle" }), 2_500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const stash = useCallback(
    async (offlineFallback: boolean) => {
      const next = draft.trim();
      if (!next || saving) return;
      setSaving(true);
      try {
        await onCommit(next);
        setDraft("");
        if (agentEnabled) setPhase({ kind: offlineFallback ? "staged-offline" : "staged" });
      } finally {
        setSaving(false);
      }
    },
    [draft, saving, onCommit, agentEnabled],
  );

  const poll = useCallback((messageId: string) => {
    const startedAt = Date.now();
    const schedule = () => {
      const prev = pollTimers.current.get(messageId);
      if (prev !== undefined) window.clearTimeout(prev);
      pollTimers.current.set(
        messageId,
        window.setTimeout(() => void tick(), STATUS_POLL_MS),
      );
    };
    const stop = () => {
      const prev = pollTimers.current.get(messageId);
      if (prev !== undefined) window.clearTimeout(prev);
      pollTimers.current.delete(messageId);
    };
    const tick = async () => {
      if (!alive.current) return;
      const watched = watchingId.current === messageId;
      try {
        const status = await send("agent/status", { messageId });
        if (!alive.current) return;
        // Stuck runs get called, not waited out — same rule as the live bar.
        const elapsed = Date.now() - startedAt;
        if (
          (status.state === "starting" && elapsed > STARTING_TIMEOUT_MS) ||
          (status.state === "working" && elapsed > WORKING_TIMEOUT_MS)
        ) {
          const detail =
            status.state === "starting"
              ? "The agent didn’t start within 5 minutes. Resend to retry."
              : "No result after 10 minutes. The run looks stuck, so resend to retry.";
          if (watched) setPhase({ kind: "failed", detail });
          void send("agent/recordOutcome", { messageId, state: "failed" }).catch(() => {});
          stop();
          return;
        }
        // Queued behind the current agent run (Cursor, Claude, or Codex).
        if (status.state === "queued") {
          schedule();
          return;
        }
        const recorded = recordableLiveSendState(status.state);
        if (status.state === "starting" || status.state === "working") {
          if (watched) {
            setPhase(
              status.state === "working"
                ? { kind: "working", messageId }
                : { kind: "starting", messageId },
            );
          }
          if (recorded)
            void send("agent/recordOutcome", { messageId, state: recorded }).catch(() => {});
          schedule();
          return;
        }
        if (watched) {
          setPhase(
            status.state === "done"
              ? { kind: "done" }
              : { kind: "failed", detail: status.detail ?? "The agent run did not finish." },
          );
        }
        // Resolve the message's board-side tag whichever bar was watching.
        void send("agent/recordOutcome", { messageId, state: status.state }).catch(() => {});
        stop();
      } catch (err) {
        if (isLostLiveSendError(err)) {
          void send("agent/recordOutcome", { messageId, state: "failed" }).catch(() => {});
          if (alive.current && watched) {
            setPhase({ kind: "failed", detail: "The previous run was lost. Resend to retry." });
          }
          stop();
          return;
        }
        if (alive.current && watched) {
          setPhase({ kind: "failed", detail: "Lost contact with the local service." });
        }
        stop();
      }
    };
    schedule();
  }, []);

  const sendToAgent = useCallback(async () => {
    const message = draft.trim();
    if (!message || phase.kind === "sending" || !agentPinIds?.length) return;
    setPhase({ kind: "sending" });
    try {
      const state = await send("state/get", {});
      if (!alive.current) return;
      if (!state.serviceOnline) {
        await stash(true);
        return;
      }
      const { messageId } = await send("agent/send", { text: message, pinIds: agentPinIds });
      if (!alive.current) return;
      setDraft("");
      watchingId.current = messageId;
      setPhase({ kind: "starting", messageId });
      poll(messageId);
    } catch (err) {
      if (!alive.current) return;
      setPhase({
        kind: "failed",
        detail: err instanceof Error && err.message.trim() ? err.message : "Try again.",
      });
    }
  }, [draft, phase.kind, agentPinIds, stash, poll]);

  const commit = useCallback(async () => {
    if (agentEnabled) await sendToAgent();
    else await stash(false);
  }, [agentEnabled, sendToAgent, stash]);

  const multi = count > 1;
  const busy =
    saving ||
    phase.kind === "sending" ||
    phase.kind === "starting" ||
    phase.kind === "working";

  // Alarms only — everything that goes right is silent here.
  const statusLine = (() => {
    switch (phase.kind) {
      case "failed":
        return `Couldn’t complete: ${phase.detail}`;
      case "staged-offline":
        return "No agent connected. Stashed on the board instead.";
      default:
        return null;
    }
  })();

  return (
    <>
      <div className="pin-note__body">
        <textarea
          ref={input}
          className="pin-note__input"
          rows={1}
          value={draft}
          placeholder={placeholder ?? (multi ? `Describe a change for all ${count}` : "Describe a change")}
          aria-label={multi ? `Annotation for all ${count} selected pins` : "Pin annotation"}
          onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // Enter alone would insert a newline into a box that is one line by
            // construction, so both forms submit and neither can break the row.
            e.preventDefault();
            if (hasModifier(e.nativeEvent)) void (agentEnabled ? stash(false) : commit());
            else if (!e.shiftKey) void commit();
          }}
        />

        {/* Relating N pins in one gesture rather than dragging N wires: the first
            selected is the reference, the rest are targets. */}
        {multi && onRelate && (
          <button
            className="pin-icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={onRelate}
            title={`Match the other ${count - 1} to the first selected`}
            aria-label="Relate the selected pins"
          >
            <LinkIcon size={14} />
          </button>
        )}

        <span
          className="pin-kbd"
          data-on={agentEnabled ? chordHeld : undefined}
          title={
            agentEnabled
              ? `Enter sends to the agent · ${submitHintLabel} stashes on the board`
              : `Save annotation · ${submitHintLabel}`
          }
        >
          {agentEnabled ? `${submitHintLabel} stash` : submitHintLabel}
        </span>

        <button
          className="pin-note__send"
          onClick={() => void commit()}
          disabled={!draft.trim() || busy}
          aria-busy={busy}
          title={
            agentEnabled
              ? `Send to agent · Enter (${submitHintLabel} stashes on the board)`
              : `Save annotation · ${submitHintLabel}`
          }
          aria-label={agentEnabled ? "Send to agent" : "Save annotation"}
        >
          <ArrowUpRightIcon size={14} />
        </button>
      </div>

      {statusLine && (
        <div
          className="pin-note__rel pin-note__alert"
          data-state={phase.kind}
          role="alert"
          aria-live="assertive"
        >
          {statusLine}
        </div>
      )}
    </>
  );
}
