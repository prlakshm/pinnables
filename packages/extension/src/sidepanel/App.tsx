import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "@pinnables/shared";
import { send, type Broadcast, type ExtensionState, type TabArmState } from "../lib/messages";
// Flat variant: same highlight, no gradient. The header renders at 17px, where
// radial shading has nothing to resolve into but the highlight still reads.
import wordmarkUrl from "../ui/wordmark-flat.svg";
import { CheckIcon, PinIcon } from "../ui/icons";
import { WorkingDots } from "../ui/WorkingDots";
import { PinList } from "./PinList";
import { Relationships } from "./Relationships";

type Tab = "pins" | "relationships";

/**
 * Submitting is one press, and the button is the only thing that reports it.
 *
 * It used to end on a panel holding the pointer and a "Keep editing" button,
 * which made a two-step gesture out of a one-step intention — the pointer was
 * already on the clipboard by then, so that screen existed to be dismissed.
 */
type Phase = "idle" | "submitting" | "submitted";

/**
 * How long "Submitted" holds before the board clears. Long enough to register
 * as an answer to the press, short enough that nobody waits on it.
 */
const SUBMITTED_MS = 1200;

export function App() {
  const started = useRef(false);
  const reloadGeneration = useRef(0);
  const instructionWrite = useRef<Promise<void>>(Promise.resolve());
  const phaseRef = useRef<Phase>("idle");
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<ExtensionState | null>(null);
  const [tab, setTab] = useState<Tab>("pins");
  const [phase, setPhase] = useState<Phase>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureIssue, setCaptureIssue] = useState<Exclude<TabArmState, "armed" | "injected"> | null>(null);
  const [instructionDraft, setInstructionDraft] = useState("");
  const [undoClear, setUndoClear] = useState<{ boardId: string } | null>(null);
  /** The relationship card to scroll to after a creation, then forget. */
  const [focusRelationshipId, setFocusRelationshipId] = useState<string | null>(null);
  /**
   * Only ever set when the clipboard write failed. The pointer is the whole
   * interface to the agent and the panel has no board list to recover an id
   * from, so clearing the board after a failed copy would strand the work.
   */
  const [uncopied, setUncopied] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    const [{ board: next }, extState] = await Promise.all([
      send("board/get", {}),
      send("state/get", {}),
    ]);
    // A health check is part of state/get and can make an older request finish
    // after a newer board broadcast. Only the newest snapshot may reach React.
    if (generation !== reloadGeneration.current) return;
    setBoard(next);
    setState(extState);
  }, []);

  useEffect(() => {
    // React StrictMode replays mount effects in development. Without this guard
    // the second asynchronous reset can land after the user has already pressed
    // Capture and silently turn their new session off again.
    if (!started.current) {
      started.current = true;
      // A side panel can be opened from Chrome's panel menu without firing the
      // extension action. Reset here as well so every newly opened panel starts
      // from the promised, unarmed Capture state.
      void send("capture/setMode", { enabled: false }).then((next) => {
        setState(next);
        void reload();
      });
    }
    const listener = (message: Broadcast) => {
      if (message.kind === "capture-mode" && message.enabled) setCaptureIssue(null);
      /*
       * A fresh relationship is the thing the user wants to see next,
       * whichever surface created it — the tab flips and the card scrolls
       * into view once the board reload carries it.
       */
      if (message.kind === "focus-relationship") {
        setTab("relationships");
        setFocusRelationshipId(message.relationshipId);
      }
      // markReady emits capture and board broadcasts before its response comes
      // back. Reloading here can replace the submitted board (and a clipboard
      // fallback pointer) with the next draft before the user ever sees it.
      if (phaseRef.current !== "idle") {
        if (message.kind === "capture-mode") {
          setState((current) => current && { ...current, captureMode: message.enabled });
        }
        return;
      }
      if (message.kind === "board-updated" || message.kind === "capture-mode") void reload();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [reload]);

  // This field used to be uncontrolled. Creating the fresh post-submit board
  // could therefore leave the previous board's text visibly in the textarea;
  // the next blur then copied that stale instruction into the new board.
  useEffect(() => {
    setInstructionDraft(board?.globalInstruction ?? "");
  }, [board?.id, board?.globalInstruction]);

  // A fresh board starts a fresh flow. Carrying the Relationships tab across
  // board identity made the first new pin appear to vanish into an empty diff
  // screen until the user noticed and switched tabs by hand.
  useEffect(() => {
    setTab("pins");
  }, [board?.id]);

  useEffect(() => {
    if (!undoClear) return;
    const timer = setTimeout(() => setUndoClear(null), 6_000);
    return () => clearTimeout(timer);
  }, [undoClear]);

  /*
   * One click clears; the toast is the safety. Pre-confirmation punished every
   * intentional clear to guard against the rare mistaken one — undo inverts
   * that, costing nothing up front and everything only when actually needed.
   */
  const clearBoard = useCallback(async () => {
    if (!board) return;
    await send("board/clear", { boardId: board.id });
    setUndoClear({ boardId: board.id });
    setTab("pins");
    void reload();
  }, [board, reload]);

  const undoClearNow = useCallback(async () => {
    if (!undoClear) return;
    setUndoClear(null);
    try {
      await send("board/undoClear", { boardId: undoClear.boardId });
    } catch {
      // The slot was overwritten or new pins exist — nothing to restore.
    }
    void reload();
  }, [undoClear, reload]);

  const toggleCapture = useCallback(async () => {
    if (!state || captureBusy) return;
    setCaptureBusy(true);
    /*
     * Ask for screenshot access on the way in, from the click itself.
     *
     * `chrome.tabs.captureVisibleTab` takes `<all_urls>` or `activeTab` and
     * nothing narrower — a host permission for the exact origin does not satisfy
     * it. `activeTab` is granted by clicking the extension icon and lapses on
     * navigation, which makes it useless here: navigating is the whole point,
     * and the first pin after a route change would fail every time.
     *
     * The request has to ride a user gesture, which is what this handler is.
     */
    try {
      /*
       * Ask directly inside the button gesture. `request` already resolves true
       * when access is held, so a preceding async `contains` check only risks
       * spending the user gesture before the prompt can open.
       *
       * A declined request must stop here. The loader can already be resident on
       * localhost and report "armed" while `captureVisibleTab` still lacks the
       * permission to take a screenshot; claiming "Capturing" in that state
       * turns every page click into a silent failure.
      */
      if (!state.captureMode) {
        const granted = await chrome.permissions
          .request({ origins: ["<all_urls>"] })
          .catch(() => false);
        if (!granted) {
          setCaptureIssue("blocked");
          return;
        }
      }

      const next = await send("capture/setMode", { enabled: !state.captureMode });
      if (next.captureMode && (next.activeTab === "blocked" || next.activeTab === "unsupported")) {
        setCaptureIssue(next.activeTab);
        const stopped = await send("capture/setMode", { enabled: false });
        setState(stopped);
      } else {
        setCaptureIssue(null);
        setState(next);
      }
      void reload();
    } finally {
      setCaptureBusy(false);
    }
  }, [state, captureBusy, reload]);

  const setInstruction = useCallback(
    async (instruction: string) => {
      if (!board) return;
      const persist = async () => {
        const { board: next } = await send("board/setInstruction", {
          boardId: board.id,
          instruction,
        });
        setBoard(next);
      };
      const result = instructionWrite.current.then(persist, persist);
      instructionWrite.current = result.then(
        () => undefined,
        () => undefined,
      );
      await result;
    },
    [board],
  );

  const submit = useCallback(async () => {
    if (!board || phase !== "idle") return;
    phaseRef.current = "submitting";
    setPhase("submitting");
    setUncopied(null);
    setSubmitError(null);
    try {
      if (instructionDraft !== board.globalInstruction) {
        await setInstruction(instructionDraft);
      }
      const result = await send("board/markReady", { boardId: board.id });
      setBoard(result.board);
      // Cursor-native path: the service already started the agent. Clipboard
      // is only needed when we fall back to the paste-the-pointer handoff.
      if (result.transport !== "cursor") {
        try {
          await navigator.clipboard.writeText(result.pointer);
        } catch {
          setUncopied(result.pointer);
        }
      }
      phaseRef.current = "submitted";
      setPhase("submitted");
    } catch {
      // The board is untouched and still on screen, so the press can simply be
      // made again — which is the whole recovery.
      setSubmitError(
        state?.cursorOnline
          ? "Couldn’t send to Cursor. Check CURSOR_API_KEY on the local service, then try again."
          : "Couldn’t write the board. Start the local service, then try again.",
      );
      phaseRef.current = "idle";
      setPhase("idle");
    }
  }, [board, phase, instructionDraft, setInstruction, state?.cursorOnline]);

  /**
   * The board clears itself once "Submitted" has been read.
   *
   * A new board rather than a wipe: the pointer names the submitted board by
   * id, so that board has to keep existing on disk for the agent to load. What
   * the user means by "clear" is a fresh sheet to pin onto, not an erasure of
   * the thing they just sent.
   */
  useEffect(() => {
    if (phase !== "submitted") return;
    const timer = setTimeout(() => {
      void (async () => {
        // A pointer that never reached the clipboard is only recoverable from
        // this screen, so keep that board visible. Otherwise reload through
        // ensureActiveBoard: it reuses a draft already created by a broadcast,
        // or creates exactly one if submission left the ready board active.
        if (!uncopied) {
          await reload();
          phaseRef.current = "idle";
          setPhase("idle");
        }
      })();
    }, SUBMITTED_MS);
    return () => clearTimeout(timer);
  }, [phase, uncopied, reload]);

  const startNewBoard = useCallback(async () => {
    setUncopied(null);
    await reload();
    phaseRef.current = "idle";
    setPhase("idle");
  }, [reload]);

  const pinCount = board?.pins.length ?? 0;
  const relCount = board?.relationships.length ?? 0;

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const next: Tab =
      event.key === "Home"
        ? "pins"
        : event.key === "End"
          ? "relationships"
          : tab === "pins"
            ? "relationships"
            : "pins";
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`pin-tab-${next}`)?.focus());
  };

  return (
    <div className="pin-panel">
      <header className="pin-panel__header">
        <img src={wordmarkUrl} alt="Pinnables" style={{ height: 17, display: "block" }} />
        {/* Black when armed, the grey plate when not — the same pair as Ready
            for agent and the composer's send. Busy never disables it: the
            disabled style is the same gray as "off", and an armed button
            dressed as off is a lie about a live picker. `toggleCapture`
            already ignores re-entry while a toggle is in flight. */}
        <button
          className={`pin-btn ${state?.captureMode ? "pin-btn--primary" : "pin-btn--quiet"}`}
          style={{ marginLeft: "auto" }}
          onClick={() => void toggleCapture()}
          aria-pressed={state?.captureMode ?? false}
          aria-busy={captureBusy}
          disabled={!state}
        >
          <PinIcon size={14} />
          {state?.captureMode ? "Capturing" : "Capture"}
        </button>
      </header>

      <nav className="pin-panel__tabs" aria-label="Board">
        <span role="tablist" aria-label="Board views" style={{ display: "contents" }}>
          <button
            id="pin-tab-pins"
            className="pin-tab"
            role="tab"
            aria-selected={tab === "pins"}
            aria-controls="pin-panel-pins"
            data-active={tab === "pins"}
            tabIndex={tab === "pins" ? 0 : -1}
            onClick={() => setTab("pins")}
            onKeyDown={onTabKeyDown}
          >
            Pins {pinCount > 0 && <span className="pin-badge">{pinCount}</span>}
          </button>
          <button
            id="pin-tab-relationships"
            className="pin-tab"
            role="tab"
            aria-selected={tab === "relationships"}
            aria-controls="pin-panel-relationships"
            data-active={tab === "relationships"}
            tabIndex={tab === "relationships" ? 0 : -1}
            onClick={() => setTab("relationships")}
            onKeyDown={onTabKeyDown}
          >
            Relationships {relCount > 0 && <span className="pin-badge">{relCount}</span>}
          </button>
        </span>

        {/* It sits on the tab rail because it acts on exactly what those tabs
            count. One press clears; the undo toast below is what makes a
            single-click destructive action acceptable. */}
        {pinCount + relCount > 0 && (
          <span className="pin-panel__tabs-end">
            <button
              className="pin-tab-action"
              onClick={() => void clearBoard()}
              aria-label="Clear all"
              title="Remove every pin and relationship on this board"
            >
              Clear all
            </button>
          </span>
        )}
      </nav>

      <div
        className="pin-panel__body"
        role="tabpanel"
        id={tab === "pins" ? "pin-panel-pins" : "pin-panel-relationships"}
        aria-labelledby={tab === "pins" ? "pin-tab-pins" : "pin-tab-relationships"}
      >
        {captureIssue && (
          <div className="pin-banner pin-banner--error" role="alert">
            {captureIssue === "blocked"
              ? "Pinnables couldn’t access this page. Grant site access, then try Capture again."
              : "This Chrome page can’t be captured. Switch to an http or https page."}
          </div>
        )}

        {!board || !state ? (
          <div className="pin-empty" role="status" aria-live="polite">
            <span>Loading board…</span>
          </div>
        ) : tab === "pins" ? (
          pinCount === 0 ? (
            <div className="pin-empty">
              <PinIcon size={22} />
              <strong style={{ fontWeight: 500, color: "var(--pin-ink)" }}>No pins yet</strong>
              <span>
                Turn on capture, then click any element in your app to pin it. Pins survive
                navigation, so keep reviewing across routes.
              </span>
            </div>
          ) : (
            <PinList
              board={board}
              onChanged={reload}
              onRelationshipCreated={() => setTab("relationships")}
            />
          )
        ) : (
          <Relationships
            board={board}
            onChanged={reload}
            focusRelationshipId={focusRelationshipId}
            onFocusConsumed={() => setFocusRelationshipId(null)}
          />
        )}
      </div>

      {board && pinCount > 0 && (
        <footer className="pin-panel__footer">
          {!state?.serviceOnline && (
            <div className="pin-banner">
              Local service is offline. Pins are safe in the browser, but the board can&apos;t be
              sent to your agent until it&apos;s running.
            </div>
          )}
          {state?.serviceOnline && !state.cursorOnline && (
            <div className="pin-banner">
              Set <code>CURSOR_API_KEY</code> on the local service for one-click Send to Cursor.
              Without it, Ready copies a pointer for you to paste.
            </div>
          )}

          {submitError && (
            <div className="pin-banner pin-banner--error" role="alert">
              {submitError}
            </div>
          )}

          {/* A submitted board is immutable. When the clipboard refuses the
              pointer, keep only the recovery controls on screen so the panel
              never presents ready-board fields that can no longer save. */}
          {uncopied ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="pin-section-label">Couldn&apos;t copy. Paste this into your agent</span>
              <code
                style={{
                  fontFamily: "var(--pin-mono)",
                  fontSize: 11,
                  background: "var(--pin-ink)",
                  color: "var(--pin-paper)",
                  padding: "8px 9px",
                  borderRadius: "var(--pin-radius-sm)",
                  overflowWrap: "anywhere",
                  userSelect: "all",
                }}
              >
                {uncopied}
              </code>
              <button
                className="pin-btn pin-btn--primary"
                style={{ alignSelf: "flex-end" }}
                onClick={() => void startNewBoard()}
              >
                Start a new board
              </button>
            </div>
          ) : (
            <>
              <textarea
                className="pin-field"
                rows={2}
                placeholder="Add instructions for every pin…"
                aria-label="Instructions for every pin"
                value={instructionDraft}
                onChange={(e) => setInstructionDraft(e.target.value)}
                onBlur={() => {
                  if (instructionDraft !== board.globalInstruction) void setInstruction(instructionDraft);
                }}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "var(--pin-ink-muted)" }}>
                  {pinCount} pin{pinCount === 1 ? "" : "s"} · {relCount} relationship
                  {relCount === 1 ? "" : "s"}
                </span>
                {/* One control, reporting its own progress. Disabled while it works
                    Disabled mid-flight so a second press cannot double-submit,
                    but never gray: "Sending" and "Sent" are the press being
                    answered, and the answer wears the same black as the ask. */}
                <button
                  className="pin-btn pin-btn--primary"
                  style={{ marginLeft: "auto" }}
                  disabled={phase !== "idle"}
                  data-progress={phase !== "idle"}
                  aria-busy={phase === "submitting"}
                  onClick={() => void submit()}
                >
                  {phase === "submitted" && <CheckIcon size={14} />}
                  {phase === "idle"
                    ? "Send to agent"
                    : phase === "submitting"
                      ? <>Sending<WorkingDots /></>
                      : "Sent"}
                </button>
              </div>
            </>
          )}
        </footer>
      )}

      {undoClear && (
        <div className="pin-toast" role="status">
          <span>Board cleared.</span>
          <button className="pin-toast__undo" onClick={() => void undoClearNow()}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
