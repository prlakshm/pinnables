import { useCallback, useEffect, useRef, useState } from "react";
import { pinLabel, type Board, type LiveSend, type Pin } from "@pinnables/shared";
import { recordableLiveSendState } from "../lib/live-send";
import { send } from "../lib/messages";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { ArrowUpRightIcon, LinkIcon } from "../ui/icons";
import { WorkingDots } from "../ui/WorkingDots";
import { flyKeyToRail } from "./VersionRail";

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
  /** Accepted by the service, but the agent is not confirmed running yet. */
  | { kind: "starting"; messageId: string }
  | { kind: "working"; messageId: string }
  | { kind: "done" }
  | { kind: "failed"; detail: string }
  /** Service offline: the text was staged on the board instead. */
  | { kind: "staged-offline" }
  | { kind: "staged" }
  /** Saved bare — the pin kept for later, no message written anywhere. */
  | { kind: "kept" };

const STATUS_POLL_MS = 2_500;
/** Still "starting" after this long means the run never truly began. */
const STARTING_TIMEOUT_MS = 5 * 60_000;
/** "Working" with no outcome after this long is treated as stuck. */
const WORKING_TIMEOUT_MS = 10 * 60_000;

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
  /** How far to step down so the version rail can sit above — see
      composerScoot. Animated, so the move reads as making room. */
  scoot?: number;
  /** A restore in flight anywhere — chat keys go quiet while it runs. */
  versionBusy?: boolean;
  onVersionBusy?: (busy: boolean) => void;
  /**
   * The open chapter. Settled rows stamped with an earlier head have been
   * absorbed by a commit: they stay in storage but leave the box, exactly
   * as their keys stop being a way back. Null tolerates old data and
   * offline services — everything shows.
   */
  projectHead?: string | null;
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
  /** Reports the root element so the overlay can measure the box. */
  onRootEl?: (el: HTMLDivElement | null) => void;
  /** A body pointerdown that missed every interactive child — a drag. */
  onBodyPointerDown?: (event: React.PointerEvent) => void;
}

/**
 * How long "Done" holds before handing its seat to the version key.
 *
 * One beat of a continuous handoff — Working → Done → keycap → flight —
 * not a farewell flash. Long enough to read "Done", then the tag collapses
 * and the key takes off. Leave still starts at DONE_FLASH_MS - 260 so the
 * 260ms tag collapse stays in sync with ui.css.
 */
const DONE_FLASH_MS = 540;

export function SelectionDialog({
  pins,
  board,
  position,
  scoot = 0,
  versionBusy = false,
  onVersionBusy,
  projectHead = null,
  targetOf,
  relationshipId,
  drawingSummary,
  onLiveSent,
  onAddToBoard,
  onRelate,
  onDismiss,
  onRootEl,
  onBodyPointerDown,
}: SelectionDialogProps) {
  const [draft, setDraft] = useState("");
  /*
   * The message the user just sent, echoed into the history immediately —
   * before the service has accepted it and the board can show it. The line
   * moves below the input the moment Enter lands, wearing the same black
   * "Sending to agent…" tag its board entry will wear, instead of the text
   * sitting in the input while a separate status row narrates.
   */
  const [echo, setEcho] = useState<string | null>(null);
  const [phase, setPhase] = useState<SendPhase>({ kind: "idle" });
  /** Whether the board chord's modifier is held right now — the hint flips. */
  const [chordHeld, setChordHeld] = useState(false);
  /** True only while the session's one teaching moment is on screen. */
  const [hintActive, setHintActive] = useState(false);
  /** Runs that just finished — their "Done" tag holds a beat, then hands its
      seat to the version key and the row stays in the log. */
  const [completedFlash, setCompletedFlash] = useState<Set<string>>(new Set());
  /** The tag's exit: it narrows away along the axis the keycap arrives on. */
  const [flashLeaving, setFlashLeaving] = useState<Set<string>>(new Set());
  /** A row whose Done just cleared — its keycap flies to the rail. */
  const [justSettled, setJustSettled] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pollTimer = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const primary = pins[0];

  /* Stable across renders as long as onRootEl is: an inline arrow here would
     be a new function every render, and React tears down and re-attaches a
     ref whose identity changed — rebuilding the overlay's ResizeObserver on
     every keystroke. */
  const setRootEl = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      onRootEl?.(el);
    },
    [onRootEl],
  );

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
   * The offline fallback stays: it reports a problem the user has to go fix,
   * and a notice that clears itself reads as a problem that did.
   */
  useEffect(() => {
    if (phase.kind !== "staged" && phase.kind !== "kept") return;
    const timer = window.setTimeout(() => setPhase({ kind: "idle" }), 2_500);
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
    setEcho(null);
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
  }, [selectionKey]);

  const poll = useCallback((messageId: string, key: string) => {
    const startedAt = Date.now();
    const tick = async () => {
      if (selectionKeyRef.current !== key) return;
      try {
        const status = await send("agent/status", { messageId });
        if (selectionKeyRef.current !== key) return;
        /*
         * Stuck runs get called, not waited out. A run that never starts, or
         * works with no outcome long past any plausible finish, is treated as
         * failed so its tag becomes Resend instead of a permanent "Working…".
         */
        const elapsed = Date.now() - startedAt;
        if (
          (status.state === "starting" && elapsed > STARTING_TIMEOUT_MS) ||
          (status.state === "working" && elapsed > WORKING_TIMEOUT_MS)
        ) {
          const detail =
            status.state === "starting"
              ? "The agent didn’t start within 5 minutes. Resend to retry."
              : "No result after 10 minutes. The run looks stuck, so resend to retry.";
          setPhase({ kind: "failed", detail });
          void send("agent/recordOutcome", { messageId, state: "failed" }).catch(() => {});
          return;
        }
        // Queued behind an active Cursor run — keep polling; no starting timeout.
        if (status.state === "queued") {
          pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
          return;
        }
        const recorded = recordableLiveSendState(status.state);
        if (status.state === "starting" || status.state === "working") {
          // Record leaving the queue, or the agent starting, onto the board —
          // otherwise the history tag stays "Queued" for the whole run.
          setPhase(
            status.state === "working"
              ? { kind: "working", messageId }
              : { kind: "starting", messageId },
          );
          if (recorded)
            void send("agent/recordOutcome", { messageId, state: recorded }).catch(() => {});
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
          /*
           * The "Done" tag is the first beat of the handoff: it holds just
           * long enough to read, then narrows away and the keycap takes the
           * seat and flies. The row itself stays — a finished line's number
           * is the way back to its state.
           */
          setCompletedFlash((previous) => new Set(previous).add(messageId));
          window.setTimeout(() => {
            setFlashLeaving((previous) => new Set(previous).add(messageId));
          }, DONE_FLASH_MS - 260);
          window.setTimeout(() => {
            setCompletedFlash((previous) => {
              const next = new Set(previous);
              next.delete(messageId);
              return next;
            });
            setFlashLeaving((previous) => {
              const next = new Set(previous);
              next.delete(messageId);
              return next;
            });
            setJustSettled(messageId);
          }, DONE_FLASH_MS);
        }
      } catch {
        if (selectionKeyRef.current !== key) return;
        setPhase({ kind: "failed", detail: "Lost contact with the local service." });
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), STATUS_POLL_MS);
  }, []);

  const staging = useRef(false);
  const stage = useCallback(
    async (message: string, offlineFallback: boolean) => {
      // ⌘↵ held long enough auto-repeats; the second landing must not write
      // the same note twice.
      if (staging.current) return;
      staging.current = true;
      try {
      await onAddToBoard(message);
      // Stashing to the whole selection is also the group speaking.
      if (pins.length > 1) {
        void send("group/record", { pinIds: pins.map((pin) => pin.id) }).catch(() => {});
      }
      setDraft("");
      setPhase({ kind: offlineFallback ? "staged-offline" : "staged" });
      } finally {
        staging.current = false;
      }
    },
    [onAddToBoard, pins],
  );

  /** One delivery path for fresh sends and resends alike. */
  const deliver = useCallback(
    async (message: string, resendOf?: string): Promise<"sent" | "offline" | "failed"> => {
      const key = selectionKeyRef.current;
      setPhase({ kind: "sending" });
      // The input hands the line to the history at once; a resend's line is
      // already there wearing its Resend tag, so it needs no echo.
      if (!resendOf) {
        setEcho(message);
        setDraft("");
      }
      try {
        const state = await send("state/get", {});
        if (selectionKeyRef.current !== key) return "failed";
        if (!state.serviceOnline) {
          setEcho(null);
          return "offline";
        }
        const { messageId } = await send("agent/send", {
          text: message,
          pinIds: pins.map((pin) => pin.id),
          relationshipId: relationshipId ?? undefined,
          drawingSummary: drawingSummary ?? undefined,
          resendOf,
        });
        if (selectionKeyRef.current !== key) return "sent";
        setPhase({ kind: "starting", messageId });
        onLiveSent(pins.map((pin) => pin.id));
        // A multi-selection that has now spoken becomes a group the shelf can
        // reopen; a lone pin needs no such record.
        if (pins.length > 1) {
          void send("group/record", { pinIds: pins.map((pin) => pin.id) }).catch(() => {});
        }
        poll(messageId, key);
        return "sent";
      } catch (err) {
        if (selectionKeyRef.current === key) {
          setPhase({
            kind: "failed",
            detail: err instanceof Error && err.message.trim() ? err.message : "Try again.",
          });
          setEcho(null);
          // Give the text back to the input unless the user already moved on
          // to typing something new during the attempt.
          if (!resendOf) setDraft((current) => (current === "" ? message : current));
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
      (sent) =>
        (sent.state === "queued" ||
          sent.state === "starting" ||
          sent.state === "working") &&
        sent.messageId !== null,
    );
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const sent of pending) {
        try {
          const status = await send("agent/status", { messageId: sent.messageId! });
          if (cancelled) return;
          // The same staleness rule the live poll applies: a run this old
          // that still claims to be going is stuck, and its tag should offer
          // Resend rather than promise "Working…" forever.
          const age = Date.now() - Date.parse(sent.at);
          const stuck =
            (status.state === "starting" && age > STARTING_TIMEOUT_MS) ||
            (status.state === "working" && age > WORKING_TIMEOUT_MS);
          if (stuck) {
            void send("agent/recordOutcome", {
              messageId: sent.messageId!,
              state: "failed",
            }).catch(() => {});
          } else if (status.state !== sent.state) {
            const recorded = recordableLiveSendState(status.state);
            if (recorded) {
              void send("agent/recordOutcome", {
                messageId: sent.messageId!,
                state: recorded,
              }).catch(() => {});
            }
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

  // The echo stands in only until the board carries the real entry.
  useEffect(() => {
    if (echo === null) return;
    if (primary?.liveSends.some((sent) => sent.text === echo)) setEcho(null);
  }, [echo, primary?.liveSends]);

  /*
   * The empty stash: ⌘↵ with nothing typed keeps the pin without writing a
   * message. The receipt is promoted so it survives dismissal and
   * navigation; no annotation is recorded and nothing goes near the agent.
   * The placeholder teaches it in the chip's own word: stash for later.
   */
  const keepNow = useCallback(async () => {
    for (const pin of pins) {
      await send("pin/update", { pinId: pin.id, patch: {} }).catch(() => {});
    }
    setDraft("");
    setPhase({ kind: "kept" });
  }, [pins]);

  const stageNow = useCallback(async () => {
    const message = draft.trim();
    // The stash chord with nothing to stash keeps the pin itself.
    if (!message) {
      await keepNow();
      return;
    }
    await stage(message, false);
  }, [draft, stage, keepNow]);

  /*
   * The settled row's keycap flies to the rail — the same key, seen leaving
   * one place and arriving in the other. The mint has to land on the board
   * first (versionNo via the outcome broadcast); then two frames let the
   * row key lay out so the ghost can launch from a real box. No extra hold:
   * this is the next beat of the same handoff, not a pause after it.
   */
  useEffect(() => {
    if (!justSettled) return;
    const sent = primary?.liveSends.find((s) => s.messageId === justSettled);
    if (!sent || sent.versionNo === null) return;
    const no = sent.versionNo;
    const messageId = justSettled;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const rowKey = rootRef.current?.querySelector<HTMLElement>(
          `.pin-key[data-msg="${messageId}"]`,
        );
        if (rowKey) flyKeyToRail(rowKey, no);
      });
    });
    setJustSettled(null);
  }, [justSettled, primary?.liveSends]);

  /** Press a chat key: same restore the rail runs, same quiet while it runs. */
  const pressVersion = useCallback(
    (no: number) => {
      if (versionBusy || primary?.currentVersionNo === no) return;
      onVersionBusy?.(true);
      void send("version/restore", { pinId: primary.id, no })
        .catch(() => {})
        .finally(() => onVersionBusy?.(false));
    },
    [versionBusy, primary, onVersionBusy],
  );

  if (!primary) return null;

  const name = pinLabel(primary, board.pins);
  const multi = pins.length > 1;
  const busy =
    phase.kind === "sending" || phase.kind === "starting" || phase.kind === "working";
  /*
   * Staged board notes, one history line each. A multi-selection shows only
   * the lines every selected pin carries — a group stash writes to all of
   * them, and a note aimed at one pin does not belong to the group's
   * conversation. (With one pin the filter passes everything.)
   */
  const boardNotes = primary.annotation
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      pins.every((pin) => pin.annotation.split("\n").some((cand) => cand.trim() === line)),
    )
    .filter((line, index, all) => all.indexOf(line) === index);

  /*
   * Delivered messages the whole selection shares. A group send records the
   * same messageId on every pin it went to, which is exactly the test for
   * "belongs to this conversation" — one pin's private sends stay off a
   * group bar, and a lone pin shows its full log.
   *
   * Only the open chapter shows. A settled row stamped with an earlier head
   * was absorbed by a commit — its words stay in storage, but the box is a
   * working conversation, not an archive. A row still in flight shows
   * whatever its stamp says: a run is a fact until it lands.
   */
  const settled = (state: string) => state === "done" || state === "failed";
  const inChapter = (sent: { head: string | null; state: string }) =>
    !settled(sent.state) ||
    sent.head === null ||
    projectHead === null ||
    sent.head === projectHead;
  const historySends = primary.liveSends
    .filter(inChapter)
    .filter((sent) =>
      sent.messageId === null
        ? pins.length === 1
        : pins.every((pin) => pin.liveSends.some((other) => other.messageId === sent.messageId)),
    );

  const statusLine = (() => {
    switch (phase.kind) {
      /*
       * The row exists only to raise an alarm. Transit and completion are
       * told by the history line's black tag; a stashed note shows up as its
       * own history line the moment the board records it. What the history
       * cannot say is that something went wrong — so that is all this row
       * says, dressed in the board banner's alarm colours.
       */
      case "failed":
        return `Couldn’t complete: ${(phase as { detail: string }).detail}`;
      case "staged-offline":
        return "No agent connected. Added to the board instead.";
      // The one non-alarm: a bare save writes no history line, so this quiet
      // receipt is its only acknowledgement. It confirms and leaves.
      case "kept":
        return "Saved to the board.";
      default:
        return null;
    }
  })();

  return (
    <div
      ref={setRootEl}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (target.closest("textarea, button, a, .pin-key, .pin-kbd")) return;
        onBodyPointerDown?.(event);
      }}
      className="pin-note pin-note--floating pin-live-note"
      style={{ left: position.x, top: position.y, width: position.width, marginTop: scoot }}
      data-no-drag
    >
      <div className="pin-note__body">
        <textarea
          ref={input}
          className="pin-note__input"
          rows={1}
          value={draft}
          placeholder={
            multi
              ? `Describe a change for all ${pins.length}`
              : "Describe a change or stash for later"
          }
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
        * messages after, each marked for what it is. A multi-selection shows
        * the group's shared conversation.
        */}
      {(boardNotes.length > 0 || historySends.length > 0 || echo !== null) && (
        <div className="pin-note__history">
          {/* The just-sent line, at the top the instant Enter lands — newest
              first, so the line you are waiting on sits against the input.
              The board's own entry takes over as soon as the service accepts. */}
          {echo !== null && !primary.liveSends.some((sent) => sent.text === echo) && (
            <div className="pin-note__history-item">
              <span className="pin-note__history-text">{echo}</span>
              <span className="pin-note__tag">
                Sending to agent<WorkingDots />
              </span>
            </div>
          )}
          {/*
            * Newest first. Numbering is untouched by this: the keys stay in
            * the order things happened, which is why the column counts down.
            * A finished row keeps its version key — the numeral is the way
            * back — and a row whose take rotated off the rail keeps only its
            * words: it stops being a way back, not part of the record.
            */}
          {historySends
            .slice()
            .reverse()
            .map((sent, index) => {
              const flashing =
                sent.state === "done" &&
                sent.messageId !== null &&
                completedFlash.has(sent.messageId);
              const settledKey =
                sent.state === "done" && !flashing ? versionKeyOf(sent, primary) : null;
              return (
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
                  ) : sent.state === "done" ? (
                    flashing ? (
                      <span
                        className="pin-note__tag"
                        data-leaving={
                          sent.messageId !== null && flashLeaving.has(sent.messageId)
                            ? "true"
                            : "false"
                        }
                      >
                        Done
                      </span>
                    ) : settledKey !== null ? (
                      <RowKey
                        no={settledKey}
                        messageId={sent.messageId}
                        lit={primary.currentVersionNo === settledKey}
                        label={sent.text}
                        busy={versionBusy}
                        onPress={() => pressVersion(settledKey)}
                      />
                    ) : null
                  ) : (
                    <span className="pin-note__tag">
                      {/* Dots mean in motion; a bare word means settled. */}
                      {sent.state === "queued" ? (
                        "Queued"
                      ) : sent.state === "starting" ? (
                        <>Sending to agent<WorkingDots /></>
                      ) : (
                        <>Working<WorkingDots /></>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          {boardNotes.map((note, index) => (
            <div key={`note-${index}`} className="pin-note__history-item">
              <span className="pin-note__history-text">{note}</span>
              {/* A note's state is a fact too: it went to the board, and no
                  agent has it. Quiet dress — this is bookkeeping, not alarm. */}
              <span className="pin-note__tag" data-tone="quiet">
                On board
              </span>
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
        <div
          className={phase.kind === "kept" ? "pin-note__rel" : "pin-note__rel pin-note__alert"}
          data-state={phase.kind}
          role={phase.kind === "kept" ? "status" : "alert"}
          aria-live={phase.kind === "kept" ? "polite" : "assertive"}
        >
          {statusLine}
        </div>
      )}
    </div>
  );
}

/**
 * The version key a settled row wears, or null when its take rotated off.
 *
 * Matching on number alone is not enough: numerals recycle, so a row's key 5
 * could otherwise light up for a *newer* take that took the numeral over.
 * The messageId pins the key to the exact take this row produced.
 */
function versionKeyOf(sent: LiveSend, pin: Pin): number | null {
  if (sent.versionNo === null) return null;
  const owned = (pin.versions ?? []).some(
    (v) => v.no === sent.versionNo && v.messageId === sent.messageId,
  );
  return owned ? sent.versionNo : null;
}

/**
 * The same keycap the rail wears, on the row that produced it — one
 * vocabulary. A row carries its own ⌥ because unlike the rail there is no
 * shared head for the modifier to sit in.
 */
function RowKey({
  no,
  messageId,
  lit,
  label,
  busy,
  onPress,
}: {
  no: number;
  messageId: string | null;
  lit: boolean;
  label: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="pin-key"
      data-no={no}
      data-msg={messageId ?? undefined}
      data-on={lit ? "true" : "false"}
      aria-pressed={lit}
      aria-label={`Version ${no}, ${label}`}
      title={`⌥${no} · switch to this version`}
      disabled={busy}
      onClick={onPress}
    >
      <span className="pin-key__mod">⌥</span>
      <span className="pin-key__num">{no}</span>
    </button>
  );
}
