import { useCallback, useEffect, useRef, useState } from "react";
import { pinLabel, type Board, type Pin } from "@pinnables/shared";
import { send } from "../lib/messages";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { ArrowUpRightIcon, LinkIcon } from "../ui/icons";
import { WorkingDots } from "../ui/WorkingDots";

/**
 * The annotation bar, attached to the live component — v1's pill, kept.
 *
 * One input, one arrow. The arrow (and Enter) sends to the agent now, because
 * the selection is a conversation about the thing on screen; ⌘Enter stages the
 * note on the board instead, and when no agent is connected the send falls
 * back to the board and says so — the message is never lost, and the bar
 * never pretends an agent heard it.
 */

/** Every phase is verifiable — nothing here is displayed on faith. */
type SendPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "working"; messageId: string }
  | { kind: "done" }
  | { kind: "failed"; detail: string }
  /** Service offline: the text was staged on the board instead. */
  | { kind: "staged-offline" }
  | { kind: "staged" };

const STATUS_POLL_MS = 2_500;

/**
 * The chord hint teaches once per capture session — on the first annotation
 * you type, for as long as you are typing it. After that the permanent
 * "⌘↵ stash" chip carries the reminder; a lesson that replays on every
 * message stops being a lesson and starts being furniture.
 */
let chordHintConsumed = false;

/** A new capture session gets one fresh lesson. Called when capture arms. */
export function resetChordHint(): void {
  chordHintConsumed = false;
}

export interface SelectionDialogProps {
  /** Live-selected pins, in selection order — the first is the reference. */
  pins: Pin[];
  board: Board;
  position: { x: number; y: number; width: number };
  /** Set when this selection is the target of an on-screen relationship. */
  targetOf: string | null;
  /** The relationship the message is about, when there is exactly one. */
  relationshipId: string | null;
  /** Marks drawn during this selection, described for the agent. */
  drawingSummary: string | null;
  /** Called after a live send is accepted — flushes owned drawings. */
  onLiveSent: (pinIds: string[]) => void;
  /** Stage the text on the board instead of sending it now. */
  onAddToBoard: (text: string) => Promise<void>;
  /** Relate the whole selection to its first pin; null when not applicable. */
  onRelate: (() => void) | null;
  onDismiss: () => void;
}

export function SelectionDialog({
  pins,
  board,
  position,
  targetOf,
  relationshipId,
  drawingSummary,
  onLiveSent,
  onAddToBoard,
  onRelate,
  onDismiss,
}: SelectionDialogProps) {
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<SendPhase>({ kind: "idle" });
  /** Whether the board chord's modifier is held right now — the hint flips. */
  const [chordHeld, setChordHeld] = useState(false);
  /** True only while the session's one teaching moment is on screen. */
  const [hintActive, setHintActive] = useState(false);
  /** Runs that just finished — their "Completed" tag shows briefly, then the
      entry leaves the log for good. */
  const [completedFlash, setCompletedFlash] = useState<Set<string>>(new Set());
  const pollTimer = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const primary = pins[0];

  /*
   * The modifier is watched globally, not on the input: holding ⌘ is a
   * question ("what would this do?") the bar should answer even before the
   * chord completes. Window blur clears it — Chrome never reports the keyup
   * that happens while another window has focus.
   */
  useEffect(() => {
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
  }, []);

  /*
   * "Added to the board" is a receipt, not a state — it confirms and leaves.
   * The offline fallback lingers longer because it carries a second fact the
   * user did not ask for: that no agent heard them.
   */
  useEffect(() => {
    if (phase.kind !== "staged" && phase.kind !== "staged-offline") return;
    const timer = window.setTimeout(
      () => setPhase({ kind: "idle" }),
      phase.kind === "staged" ? 2_500 : 5_000,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    input.current?.focus();
  }, [primary?.id]);

  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    },
    [],
  );

  /*
   * A new selection is a new conversation. The key also guards the poll: a
   * status tick that raced a selection change must not stamp its verdict onto
   * a bar that is now about a different component.
   */
  const selectionKey = pins.map((pin) => pin.id).join(" ");
  const selectionKeyRef = useRef(selectionKey);
  useEffect(() => {
    selectionKeyRef.current = selectionKey;
    setPhase({ kind: "idle" });
    setDraft("");
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
  }, [selectionKey]);

  const poll = useCallback((messageId: string, key: string) => {
    const tick = async () => {
      if (selectionKeyRef.current !== key) return;
      try {
        const status = await send("agent/status", { messageId });
        if (selectionKeyRef.current !== key) return;
        if (status.state === "working") {
          pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
          return;
        }
        setPhase(
          status.state === "done"
            ? { kind: "done" }
            : { kind: "failed", detail: status.detail ?? "The agent run did not finish." },
        );
        // The outcome belongs to the board, not to this bar — recording it is
        // what resolves the history tag even after this dialog is gone.
        void send("agent/recordOutcome", { messageId, state: status.state }).catch(() => {});
        if (status.state === "done") {
          // "Completed" gets its moment before the entry leaves the log.
          setCompletedFlash((previous) => new Set(previous).add(messageId));
          window.setTimeout(() => {
            setCompletedFlash((previous) => {
              const next = new Set(previous);
              next.delete(messageId);
              return next;
            });
          }, 4_000);
        }
      } catch {
        if (selectionKeyRef.current !== key) return;
        setPhase({ kind: "failed", detail: "Lost contact with the local service." });
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
  }, []);

  const stage = useCallback(
    async (message: string, offlineFallback: boolean) => {
      await onAddToBoard(message);
      setDraft("");
      setPhase({ kind: offlineFallback ? "staged-offline" : "staged" });
    },
    [onAddToBoard],
  );

  /** One delivery path for fresh sends and resends alike. */
  const deliver = useCallback(
    async (message: string, resendOf?: string): Promise<"sent" | "offline" | "failed"> => {
      const key = selectionKeyRef.current;
      setPhase({ kind: "sending" });
      try {
        const state = await send("state/get", {});
        if (selectionKeyRef.current !== key) return "failed";
        if (!state.serviceOnline) return "offline";
        const { messageId } = await send("agent/send", {
          text: message,
          pinIds: pins.map((pin) => pin.id),
          relationshipId: relationshipId ?? undefined,
          drawingSummary: drawingSummary ?? undefined,
          resendOf,
        });
        if (selectionKeyRef.current !== key) return "sent";
        setPhase({ kind: "working", messageId });
        onLiveSent(pins.map((pin) => pin.id));
        poll(messageId, key);
        return "sent";
      } catch (err) {
        if (selectionKeyRef.current === key) {
          setPhase({
            kind: "failed",
            detail: err instanceof Error && err.message.trim() ? err.message : "Try again.",
          });
        }
        return "failed";
      }
    },
    [pins, relationshipId, drawingSummary, onLiveSent, poll],
  );

  const sendNow = useCallback(async () => {
    const message = draft.trim();
    if (!message || phase.kind === "sending") return;
    const result = await deliver(message);
    // No agent to hear it — the board keeps the message instead, visibly.
    if (result === "offline") await stage(message, true);
    else if (result === "sent") setDraft("");
  }, [draft, phase.kind, deliver, stage]);

  /** Retry a failed or orphaned message; the new run supersedes the old entry. */
  const resendEntry = useCallback(
    async (text: string, messageId: string | null) => {
      if (phase.kind === "sending") return;
      const result = await deliver(text, messageId ?? undefined);
      if (result === "offline") {
        setPhase({
          kind: "failed",
          detail: "No agent connected. Start the local service, then resend.",
        });
      }
    },
    [phase.kind, deliver],
  );

  /*
   * Reconcile "Waiting…" entries whose runs this bar was not watching. The
   * service answers for runs it knows; a run it has forgotten (a restart, a
   * crash) is over by definition — recorded failed, which is what makes the
   * entry's tag become Resend instead of waiting forever.
   */
  useEffect(() => {
    if (!primary) return;
    const pending = primary.liveSends.filter(
      (sent) => sent.state === "working" && sent.messageId !== null,
    );
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const sent of pending) {
        try {
          const status = await send("agent/status", { messageId: sent.messageId! });
          if (cancelled) return;
          if (status.state !== "working") {
            void send("agent/recordOutcome", {
              messageId: sent.messageId!,
              state: status.state,
            }).catch(() => {});
          }
        } catch {
          if (cancelled) return;
          void send("agent/recordOutcome", {
            messageId: sent.messageId!,
            state: "failed",
          }).catch(() => {});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primary?.id]);

  const stageNow = useCallback(async () => {
    const message = draft.trim();
    if (!message) return;
    await stage(message, false);
  }, [draft, stage]);

  if (!primary) return null;

  const name = pinLabel(primary, board.pins);
  const multi = pins.length > 1;
  const busy = phase.kind === "sending" || phase.kind === "working";
  /** Staged board notes, one history line each. */
  const boardNotes = primary.annotation
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const statusLine = (() => {
    switch (phase.kind) {
      case "working":
        return <>Agent is working<WorkingDots /></>;
      case "done":
        return "Agent finished. Check the page.";
      case "failed":
        return `Couldn’t complete: ${(phase as { detail: string }).detail}`;
      case "staged-offline":
        return "No agent connected. Added to the board instead.";
      case "staged":
        return "Added to the board.";
      default:
        return null;
    }
  })();

  return (
    <div
      className="pin-note pin-note--floating pin-live-note"
      style={{ left: position.x, top: position.y, width: position.width }}
      data-no-drag
    >
      <div className="pin-note__body">
        <textarea
          ref={input}
          className="pin-note__input"
          rows={1}
          value={draft}
          placeholder={multi ? `Describe the change for all ${pins.length}` : "Describe the change"}
          aria-label={multi ? `Message for all ${pins.length} selected components` : `Message for ${name}`}
          onChange={(event) => {
            const next = event.target.value.replace(/\n/g, " ");
            // First keystroke of the session's first annotation opens the one
            // teaching moment; it stays for this draft and never comes back.
            if (next.trim() && !draft.trim() && !chordHintConsumed) {
              chordHintConsumed = true;
              setHintActive(true);
            }
            if (!next.trim()) setHintActive(false);
            setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // The bar autofocuses, so without this Escape could never reach
              // the page-level layer that clears the selection.
              event.preventDefault();
              event.stopPropagation();
              onDismiss();
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            // Enter sends to the agent; the modifier stages on the board.
            if (hasModifier(event.nativeEvent)) void stageNow();
            else void sendNow();
          }}
        />

        {multi && onRelate && (
          <button
            className="pin-icon-btn"
            style={{ width: 26, height: 26 }}
            onClick={onRelate}
            title={`Match the other ${pins.length - 1} to ${name}`}
            aria-label="Relate the selected components"
          >
            <LinkIcon size={14} />
          </button>
        )}

        {/* The chip fills while the modifier is held — the chord answering
            "what would this do" before it is completed. The arrow stays
            itself: its meaning never changes, only the chord's does. */}
        <span
          className="pin-kbd"
          data-on={chordHeld}
          title={`Enter sends to the agent · ${submitHintLabel} stashes on the board`}
        >
          {submitHintLabel} stash
        </span>

        <button
          className="pin-note__send"
          onClick={() => void sendNow()}
          disabled={!draft.trim() || busy}
          aria-busy={busy}
          title={`Send to agent · Enter (${submitHintLabel} adds to the board)`}
          aria-label="Send to agent"
        >
          <ArrowUpRightIcon size={14} />
        </button>
      </div>

      {/*
        * The session's one teaching moment: the two destinations, shown while
        * the first annotation is being written. Emphasis names what Enter
        * does right now and flips while the modifier is held. Afterwards the
        * "⌘↵ stash" chip is the standing reminder.
        */}
      {hintActive && draft.trim() && (
        <div className="pin-note__hint" aria-hidden>
          <span data-on={!chordHeld}>
            <strong>↵</strong> send to agent
          </span>
          <span data-on={chordHeld}>
            <strong>{submitHintLabel}</strong> stash to board
          </span>
        </div>
      )}

      {/*
        * The conversation so far, under the input — where a chat keeps its
        * history while you type the next line. Staged notes first, delivered
        * messages after, each marked for what it is.
        */}
      {pins.length === 1 && (boardNotes.length > 0 || primary.liveSends.length > 0) && (
        <div className="pin-note__history">
          {boardNotes.map((note, index) => (
            <div key={`note-${index}`} className="pin-note__history-item">
              {note}
            </div>
          ))}
          {primary.liveSends
            .filter(
              (sent) =>
                sent.state !== "done" ||
                (sent.messageId !== null && completedFlash.has(sent.messageId)),
            )
            .map((sent, index) => (
              <div
                key={`sent-${index}`}
                className="pin-note__history-item"
                title={`Delivered ${sent.at}`}
              >
                <span className="pin-note__history-text">{sent.text}</span>
                {sent.state === "failed" ? (
                  <button
                    type="button"
                    className="pin-note__tag pin-note__tag--action"
                    onClick={() => void resendEntry(sent.text, sent.messageId)}
                    title="This run didn’t finish. Send it to the agent again"
                  >
                    Resend
                  </button>
                ) : (
                  <span className="pin-note__tag">
                    {sent.state === "working" ? <>Waiting<WorkingDots /></> : "Completed"}
                  </span>
                )}
              </div>
            ))}
        </div>
      )}

      {targetOf && (
        <div className="pin-note__rel">
          <LinkIcon size={13} />
          target of {targetOf}
        </div>
      )}
      {statusLine && (
        <div className="pin-note__rel" data-state={phase.kind} role="status" aria-live="polite">
          {statusLine}
        </div>
      )}
    </div>
  );
}
