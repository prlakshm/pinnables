import { useCallback, useEffect, useRef, useState } from "react";
import { hasModifier, submitHintLabel } from "../lib/platform";
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
  | { kind: "working"; messageId: string }
  | { kind: "done" }
  | { kind: "failed"; detail: string }
  | { kind: "staged-offline" }
  | { kind: "staged" };

const STATUS_POLL_MS = 2_500;

/**
 * One prompt, however many pins — and one line.
 *
 * Shared by every pill on the page: docked under a capture card, floating
 * beneath a multi-selection. Whatever it is attached to, the chords mean the
 * same thing everywhere — Enter to the agent, ⌘Enter stashed to the board —
 * because two bars that look identical and behave differently would be worse
 * than either behavior alone.
 */
export function Composer({ count, onCommit, onRelate, autoFocus, agentPinIds }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [chordHeld, setChordHeld] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pollTimer = useRef<number | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  useEffect(
    () => () => {
      alive.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
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

  // A stash receipt confirms and leaves; the offline fallback lingers longer
  // because it carries the extra fact that no agent heard the message.
  useEffect(() => {
    if (phase.kind !== "staged" && phase.kind !== "staged-offline") return;
    const timer = window.setTimeout(
      () => setPhase({ kind: "idle" }),
      phase.kind === "staged" ? 2_500 : 5_000,
    );
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
    const tick = async () => {
      if (!alive.current) return;
      try {
        const status = await send("agent/status", { messageId });
        if (!alive.current) return;
        if (status.state === "working") {
          pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
          return;
        }
        setPhase(
          status.state === "done"
            ? { kind: "done" }
            : { kind: "failed", detail: status.detail ?? "The agent run did not finish." },
        );
        // Resolve the message's board-side tag whichever bar was watching.
        void send("agent/recordOutcome", { messageId, state: status.state }).catch(() => {});
      } catch {
        if (alive.current) {
          setPhase({ kind: "failed", detail: "Lost contact with the local service." });
        }
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
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
      setPhase({ kind: "working", messageId });
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
  const busy = saving || phase.kind === "sending" || phase.kind === "working";

  const statusLine = (() => {
    switch (phase.kind) {
      case "working":
        return <>Agent is working<WorkingDots /></>;
      case "done":
        return "Agent finished. Check the page.";
      case "failed":
        return `Couldn’t complete: ${phase.detail}`;
      case "staged-offline":
        return "No agent connected. Stashed on the board instead.";
      case "staged":
        return "Stashed on the board.";
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
          placeholder={multi ? `Describe the change for all ${count}` : "Describe the change"}
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
        <div className="pin-note__rel" data-state={phase.kind} role="status" aria-live="polite">
          {statusLine}
        </div>
      )}
    </>
  );
}
