import { useCallback, useEffect, useState } from "react";
import type { Board } from "@pinnables/shared";
import { send, type Broadcast, type ExtensionState } from "../lib/messages";
// Flat variant: same highlight, no gradient. The header renders at 17px, where
// radial shading has nothing to resolve into but the highlight still reads.
import wordmarkUrl from "../ui/wordmark-flat.svg";
import { PinIcon } from "../ui/icons";
import { PinList } from "./PinList";
import { Relationships } from "./Relationships";

type Tab = "pins" | "relationships";

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<ExtensionState | null>(null);
  const [tab, setTab] = useState<Tab>("pins");
  const [pointer, setPointer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const toggleCapture = useCallback(async () => {
    if (!state) return;
    const next = await send("capture/setMode", { enabled: !state.captureMode });
    setState(next);
    void reload();
  }, [state, reload]);

  const markReady = useCallback(async () => {
    if (!board) return;
    setBusy(true);
    try {
      const result = await send("board/markReady", { boardId: board.id });
      setBoard(result.board);
      setPointer(result.pointer);
      await navigator.clipboard.writeText(result.pointer).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [board]);

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
        <button
          className={state?.captureMode ? "pin-btn pin-btn--primary" : "pin-btn"}
          style={{ marginLeft: "auto" }}
          onClick={() => void toggleCapture()}
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
            placeholder="Board instruction — applies to every pin…"
            defaultValue={board.globalInstruction}
            onBlur={(e) => void setInstruction(e.target.value)}
          />

          {pointer ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="pin-section-label">Copied — paste into your agent</span>
              <code
                style={{
                  fontFamily: "var(--pin-mono)",
                  fontSize: 11,
                  background: "var(--pin-ink)",
                  color: "var(--pin-paper)",
                  padding: "8px 9px",
                  borderRadius: "var(--pin-radius-sm)",
                  overflowWrap: "anywhere",
                }}
              >
                {pointer}
              </code>
              <button className="pin-btn" onClick={() => setPointer(null)}>
                Keep editing
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--pin-ink-muted)" }}>
                {pinCount} pin{pinCount === 1 ? "" : "s"} · {relCount} relationship
                {relCount === 1 ? "" : "s"}
              </span>
              <button
                className="pin-btn pin-btn--primary"
                style={{ marginLeft: "auto" }}
                disabled={busy}
                onClick={() => void markReady()}
              >
                {busy ? "Preparing…" : "Ready for agent"}
              </button>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
