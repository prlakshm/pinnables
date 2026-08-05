import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { send } from "../lib/messages";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { CloseIcon, LinkIcon } from "../ui/icons";
import type { FloatPosition } from "./Overlay";

interface PinObjectProps {
  pin: Pin;
  board: Board;
  position: FloatPosition;
  pulse: boolean;
  onMove: (position: FloatPosition) => void;
  onDismiss: () => void;
  onChanged: () => void;
}

/**
 * A pinned component, lifted off the page.
 *
 * What floats is the captured *image*, not the live node — cloning a live DOM
 * subtree onto another route means carrying its stylesheets with it, which
 * breaks constantly. So the cursor is `grab` rather than `pointer`: this is an
 * object you move, not UI you click.
 */
export function PinObject({
  pin,
  board,
  position,
  pulse,
  onMove,
  onDismiss,
  onChanged,
}: PinObjectProps) {
  const [shot, setShot] = useState<string | null>(null);
  const [draft, setDraft] = useState(pin.annotation);
  const [editing, setEditing] = useState(pin.annotation === "");
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void chrome.storage.local.get(`shot:${pin.id}`).then((bag) => {
      setShot((bag[`shot:${pin.id}`] as string | undefined) ?? null);
    });
  }, [pin.id]);

  useEffect(() => setDraft(pin.annotation), [pin.annotation]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if ((event.target as Element).closest("[data-no-drag]")) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragging.current;
      if (!drag) return;
      onMove({
        x: Math.max(4, event.clientX - drag.dx),
        y: Math.max(4, event.clientY - drag.dy),
      });
    },
    [onMove],
  );

  const commit = useCallback(async () => {
    if (draft === pin.annotation) {
      setEditing(false);
      return;
    }
    await send("pin/update", { pinId: pin.id, patch: { annotation: draft } });
    setEditing(false);
    onChanged();
  }, [draft, pin.annotation, pin.id, onChanged]);

  const relationships = board.relationships.filter((r) => r.sourcePinId === pin.id);
  const targetCount = relationships.reduce((sum, r) => sum + r.targetPinIds.length, 0);

  return (
    <div
      ref={ref}
      className="pin-object"
      style={{ left: position.x, top: position.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (dragging.current = null)}
    >
      <span className="pin-object__marker" data-pulse={pulse} aria-hidden />

      <div className="pin-object__card">
        <div className="pin-object__meta">
          <span>{pin.route}</span>
          <span style={{ opacity: 0.7 }}>{pin.viewport.width}</span>
          <button
            className="pin-icon-btn"
            data-no-drag
            style={{ width: 20, height: 20, marginLeft: "auto", color: "inherit" }}
            onClick={onDismiss}
            title="Hide from this page — the pin stays on the board"
            aria-label="Hide pin from page"
          >
            <CloseIcon size={13} />
          </button>
        </div>
        {shot ? (
          <img className="pin-object__shot" src={shot} alt={pin.elementText || "Pinned element"} />
        ) : (
          <div className="pin-object__shot" style={{ width: 180, height: 90 }} />
        )}
      </div>

      <div className="pin-object__annotation" data-no-drag>
        {editing ? (
          <>
            <textarea
              className="pin-field"
              autoFocus
              rows={2}
              value={draft}
              placeholder="Add an annotation…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hasModifier(e.nativeEvent)) {
                  e.preventDefault();
                  void commit();
                }
              }}
              onBlur={() => void commit()}
            />
            <span className="pin-kbd">{submitHintLabel}</span>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              className="pin-object__annotation-text"
              style={{ textAlign: "left" }}
              onClick={() => setEditing(true)}
              title="Edit annotation"
            >
              {pin.annotation}
            </button>
            {targetCount > 0 && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  color: "var(--pin-cobalt)",
                }}
              >
                <LinkIcon size={13} />
                source for {targetCount} pin{targetCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
