import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { send } from "../lib/messages";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { ArrowUpRightIcon, CloseIcon, LinkIcon } from "../ui/icons";
import type { HueTokens } from "../ui/theme";
import type { FloatPosition } from "./Overlay";

export type AnchorEdge = "left" | "right" | "top" | "bottom";
export const ANCHOR_EDGES: AnchorEdge[] = ["left", "right", "top", "bottom"];

interface PinObjectProps {
  pin: Pin;
  board: Board;
  position: FloatPosition;
  pulse: boolean;
  selected: boolean;
  connecting: boolean;
  hue: HueTokens;
  onSelect: () => void;
  onMove: (position: FloatPosition) => void;
  onDismiss: () => void;
  onChanged: () => void;
  onAnchorDown: (pinId: string, edge: AnchorEdge, event: React.PointerEvent) => void;
  onAnchorEnter: (pinId: string, edge: AnchorEdge) => void;
  onAnchorLeave: () => void;
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
  selected,
  connecting,
  hue,
  onSelect,
  onMove,
  onDismiss,
  onChanged,
  onAnchorDown,
  onAnchorEnter,
  onAnchorLeave,
}: PinObjectProps) {
  const [shot, setShot] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hovered, setHovered] = useState(false);
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void chrome.storage.local.get(`shot:${pin.id}`).then((bag) => {
      setShot((bag[`shot:${pin.id}`] as string | undefined) ?? null);
    });
  }, [pin.id]);

  // Selecting a pin should put the caret where you can type, not make you hunt
  // for the field.
  useEffect(() => {
    if (selected) input.current?.focus();
    else setDraft("");
  }, [selected]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as Element).closest("[data-no-drag]")) return;
      onSelect();
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      dragging.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    },
    [onSelect],
  );

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
    const next = draft.trim();
    if (!next) return;
    // Appends rather than replaces — a pin accumulates notes the way a comment
    // thread does, instead of the last one silently winning.
    const annotation = pin.annotation ? `${pin.annotation}\n${next}` : next;
    await send("pin/update", { pinId: pin.id, patch: { annotation } });
    setDraft("");
    onChanged();
  }, [draft, pin.annotation, pin.id, onChanged]);

  const relationships = board.relationships.filter((r) => r.sourcePinId === pin.id);
  const targetCount = relationships.reduce((sum, r) => sum + r.targetPinIds.length, 0);
  // Hover only. Anchors on every selected pin would leave four dots sitting on
  // the card the whole time you are writing a note.
  const showAnchors = hovered || connecting;
  const label = pin.componentName ?? pin.elementText.slice(0, 28) ?? "element";

  return (
    <div
      ref={ref}
      className="pin-object"
      data-selected={selected}
      data-pin-id={pin.id}
      style={
        {
          left: position.x,
          top: position.y,
          "--pin-hue": hue.line,
          "--pin-hue-text": hue.text,
          "--pin-hue-soft": hue.soft,
        } as React.CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (dragging.current = null)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="pin-object__marker" data-pulse={pulse} aria-hidden />

      <div className="pin-object__card">
        <div className="pin-object__inner">
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

        {/* Edge midpoints. Drag one onto another pin's anchor to relate them. */}
        {showAnchors &&
          ANCHOR_EDGES.map((edge) => (
            <span
              key={edge}
              className="pin-anchor"
              data-edge={edge}
              data-no-drag
              title="Drag to another pin to connect them"
              onPointerDown={(event) => {
                event.stopPropagation();
                onAnchorDown(pin.id, edge, event);
              }}
              onPointerEnter={() => onAnchorEnter(pin.id, edge)}
              onPointerLeave={onAnchorLeave}
            />
          ))}
      </div>

      {/* Selected: the note panel is open. Unselected with a note: one clamped
          line. Unselected without one: nothing, so the pin stays a picture. */}
      {selected ? (
        <div className="pin-note" data-no-drag>
          {pin.annotation && (
            <div className="pin-note__saved">
              <span>{pin.annotation}</span>
            </div>
          )}

          <div className="pin-note__body">
            {/* Chips lead the line and the prompt continues after them, the way
                Cursor's composer reads. The chip carries the pin's hue so it is
                traceable back to its card without reading the label. */}
            <div className="pin-note__chips">
              <span className="pin-note__chip">{label}</span>
              <textarea
                ref={input}
                className="pin-note__input"
                rows={1}
                value={draft}
                placeholder={pin.annotation ? "Add another note…" : "Describe the change"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasModifier(e.nativeEvent)) {
                    e.preventDefault();
                    void commit();
                  }
                }}
              />
            </div>

            <div className="pin-note__foot">
              <span className="pin-note__meta">
                {pin.route} · {pin.viewport.width}
              </span>
              <span className="pin-kbd">{submitHintLabel}</span>
              <button
                className="pin-note__send"
                onClick={() => void commit()}
                disabled={!draft.trim()}
                title={`Save annotation · ${submitHintLabel}`}
                aria-label="Save annotation"
              >
                <ArrowUpRightIcon size={14} />
              </button>
            </div>
          </div>

          {targetCount > 0 && (
            <div className="pin-note__rel">
              <LinkIcon size={13} />
              source for {targetCount} pin{targetCount === 1 ? "" : "s"}
            </div>
          )}
        </div>
      ) : (
        pin.annotation && (
          <div className="pin-note pin-note--collapsed" data-no-drag>
            <button className="pin-note__saved" onClick={onSelect} title="Open annotation">
              <span>{pin.annotation}</span>
            </button>
          </div>
        )
      )}
    </div>
  );
}
