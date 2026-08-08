import { useCallback, useEffect, useState } from "react";
import type { Board } from "@pinnables/shared";
import { send, type Broadcast, type ExtensionState } from "../lib/messages";
// Flat variant: same highlight, no gradient. The header renders at 17px, where
// radial shading has nothing to resolve into but the highlight still reads.
import wordmarkUrl from "../ui/wordmark-flat.svg";
import { CheckIcon, PinIcon } from "../ui/icons";
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

/**
 * Hand the pointer to Cursor directly.
 *
 * MCP cannot push, so the agent has to be told to come and look. Cursor's
 * deeplink is the one channel that goes the other way: it opens the app with a
 * prompt already in the composer, which is the difference between "press
 * submit" and "press submit, switch apps, paste".
 *
 * Only ever called once the board is materialised — a prompt telling Cursor to
 * load a board that never reached disk is worse than no prompt, because it
 * fails inside the agent where the reason is invisible.
 *
 * The anchor is deliberate: assigning `location.href` in a side panel navigates
 * the panel itself, and a synthetic click on a detached anchor hands the URL to
 * the OS without the panel going anywhere.
 */
function openInCursor(pointer: string): void {
  const url = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(pointer)}`;
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<ExtensionState | null>(null);
  const [tab, setTab] = useState<Tab>("pins");
  const [phase, setPhase] = useState<Phase>("idle");
  /**
   * Only ever set when the clipboard write failed. The pointer is the whole
   * interface to the agent and the panel has no board list to recover an id
   * from, so clearing the board after a failed copy would strand the work.
   */
  const [uncopied, setUncopied] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [{ board: next }, extState] = await Promise.all([
      send("board/get", {}),
      send("state/get", {}),
    ]);
    setBoard(next);
    setState(extState);
  }, []);

  useEffect(() => {
    void reload();
    const listener = (message: Broadcast) => {
      if (message.kind === "board-updated" || message.kind === "capture-mode") void reload();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [reload]);

  const clearBoard = useCallback(async () => {
    if (!board) return;
    await send("board/clear", { boardId: board.id });
    void reload();
  }, [board, reload]);

  const toggleCapture = useCallback(async () => {
    if (!state) return;
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
    /*
     * Asked first, and never awaited before asking.
     *
     * `permissions.request` has to run inside the user gesture, and an `await`
     * spends it — checking `permissions.contains` first meant the request that
     * followed threw "must be called during a user gesture", the handler
     * rejected, and `capture/setMode` was never reached. The button did nothing.
     * It looked intermittent because the check is skipped once the permission is
     * held, so it only failed when it mattered.
     *
     * `request` already resolves true when the origin is granted, so the check
     * bought nothing. And a refusal must not block the toggle: capture mode
     * still works, it just cannot take screenshots, and that is a better answer
     * than a dead button.
     */
    if (!state.captureMode) {
      try {
        await chrome.permissions.request({ origins: ["<all_urls>"] });
      } catch {
        // Declined, or no gesture left to spend. Either way, still toggle.
      }
    }
    const next = await send("capture/setMode", { enabled: !state.captureMode });
    setState(next);
    void reload();
  }, [state, reload]);

  const submit = useCallback(async () => {
    if (!board || phase !== "idle") return;
    setPhase("submitting");
    setUncopied(null);
    try {
      const result = await send("board/markReady", { boardId: board.id });
      setBoard(result.board);
      try {
        await navigator.clipboard.writeText(result.pointer);
      } catch {
        setUncopied(result.pointer);
      }
      // The clipboard is still written first, and on purpose: the deeplink can
      // fail quietly — no Cursor installed, protocol handler declined, the
      // wrong app registered — and a pointer already on the clipboard turns
      // that into a paste rather than a dead end.
      if (result.materialized) openInCursor(result.pointer);
      setPhase("submitted");
    } catch {
      // The board is untouched and still on screen, so the press can simply be
      // made again — which is the whole recovery.
      setPhase("idle");
    }
  }, [board, phase]);

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
        // this screen, so that board keeps its pins — but the button still has
        // to come back, or the panel ends on a control nobody can press.
        if (!uncopied) {
          await send("board/create", { title: "Untitled board" });
          await reload();
        }
        setPhase("idle");
      })();
    }, SUBMITTED_MS);
    return () => clearTimeout(timer);
  }, [phase, uncopied, reload]);

  const setInstruction = useCallback(
    async (instruction: string) => {
      if (!board) return;
      const { board: next } = await send("board/setInstruction", { boardId: board.id, instruction });
      setBoard(next);
    },
    [board],
  );

  const pinCount = board?.pins.length ?? 0;
  const relCount = board?.relationships.length ?? 0;

  return (
    <div className="pin-panel">
      <header className="pin-panel__header">
        <img src={wordmarkUrl} alt="Pinnables" style={{ height: 17, display: "block" }} />
        {/* Black when armed, the grey plate when not — the same pair as Ready
            for agent and the composer's send. */}
        <button
          className={`pin-btn ${state?.captureMode ? "pin-btn--primary" : "pin-btn--quiet"}`}
          style={{ marginLeft: "auto" }}
          onClick={() => void toggleCapture()}
          aria-pressed={state?.captureMode ?? false}
        >
          <PinIcon size={14} />
          {state?.captureMode ? "Capturing" : "Capture"}
        </button>
      </header>

      <nav className="pin-panel__tabs">
        <button className="pin-tab" data-active={tab === "pins"} onClick={() => setTab("pins")}>
          Pins {pinCount > 0 && <span className="pin-badge">{pinCount}</span>}
        </button>
        <button
          className="pin-tab"
          data-active={tab === "relationships"}
          onClick={() => setTab("relationships")}
        >
          Relationships {relCount > 0 && <span className="pin-badge">{relCount}</span>}
        </button>

        {/*
          * One click. A confirm step here was protecting the wrong thing — this
          * gets pressed constantly while setting a board up, and a board of
          * unsent pins is minutes of work, not hours. It sits on the tab rail
          * because it acts on exactly what the tabs are counting, and it hides
          * when there is nothing to clear.
          */}
        {pinCount + relCount > 0 && (
          <span className="pin-panel__tabs-end">
            <button
              className="pin-tab-action"
              onClick={() => void clearBoard()}
              title="Remove every pin and relationship on this board"
            >
              Clear all
            </button>
          </span>
        )}
      </nav>

      <div className="pin-panel__body">
        {!board || pinCount === 0 ? (
          <div className="pin-empty">
            <PinIcon size={22} />
            <strong style={{ fontWeight: 500, color: "var(--pin-ink)" }}>No pins yet</strong>
            <span>
              Turn on capture, then click any element on your localhost app to pin it. Pins survive
              navigation, so keep reviewing across routes.
            </span>
          </div>
        ) : tab === "pins" ? (
          <PinList board={board} onChanged={reload} />
        ) : (
          <Relationships board={board} onChanged={reload} />
        )}
      </div>

      {board && pinCount > 0 && (
        <footer className="pin-panel__footer">
          {!state?.serviceOnline && (
            <div className="pin-banner">
              Local service is offline. Pins are safe in the browser, but the board can&apos;t be
              written to disk for your agent until it&apos;s running.
            </div>
          )}

          <textarea
            className="pin-field"
            rows={2}
            placeholder="Add instructions for every pin…"
            defaultValue={board.globalInstruction}
            onBlur={(e) => void setInstruction(e.target.value)}
          />

          {/* The one case that keeps a screen: the clipboard refused, so the
              pointer is here and the board stays until it has been taken. */}
          {uncopied && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="pin-section-label">Couldn&apos;t copy — paste this into your agent</span>
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
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--pin-ink-muted)" }}>
              {pinCount} pin{pinCount === 1 ? "" : "s"} · {relCount} relationship
              {relCount === 1 ? "" : "s"}
            </span>
            {/* One control, reporting its own progress. Disabled while it works
                and while it says so, which is also what greys it — the panel's
                black-when-it-will-act rule, spent here on the only press that
                sends anything. */}
            <button
              className="pin-btn pin-btn--primary"
              style={{ marginLeft: "auto" }}
              disabled={phase !== "idle"}
              onClick={() => void submit()}
            >
              {phase === "submitted" && <CheckIcon size={14} />}
              {phase === "idle" ? "Send to agent" : phase === "submitting" ? "Submitting…" : "Submitted"}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
