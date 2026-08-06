import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { CloseIcon, LinkIcon } from "../ui/icons";
import type { HueTokens } from "../ui/theme";
import { Composer, type SelectionChip } from "./Composer";
import type { FloatPosition } from "./Overlay";

export type { SelectionChip };

export type AnchorEdge = "left" | "right" | "top" | "bottom";
export const ANCHOR_EDGES: AnchorEdge[] = ["left", "right", "top", "bottom"];

interface PinObjectProps {
  pin: Pin;
  board: Board;
  position: FloatPosition;
  pulse: boolean;
  selected: boolean;
  /**
   * True only for a lone selection. Two or more and the composer detaches to
   * float beneath the group instead — docking it under one card of several
   * implies that card is the subject, when the prompt applies to all of them.
   */
  primary: boolean;
  chips: SelectionChip[];
  connecting: boolean;
  hue: HueTokens;
  onSelect: (additive: boolean) => void;
  onMove: (position: FloatPosition) => void;
  onDismiss: () => void;
  onCommit: (text: string) => Promise<void>;
  onRelate: () => void;
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
  primary,
  chips,
  connecting,
  hue,
  onSelect,
  onMove,
  onDismiss,
  onCommit,
  onRelate,
  onAnchorDown,
  onAnchorEnter,
  onAnchorLeave,
}: PinObjectProps) {
  const [shot, setShot] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void chrome.storage.local.get(`shot:${pin.id}`).then((bag) => {
      setShot((bag[`shot:${pin.id}`] as string | undefined) ?? null);
    });
  }, [pin.id]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as Element).closest("[data-no-drag]")) return;
      onSelect(event.metaKey || event.ctrlKey || event.shiftKey);
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

  const relationships = board.relationships.filter((r) => r.sourcePinId === pin.id);
  const targetCount = relationships.reduce((sum, r) => sum + r.targetPinIds.length, 0);
  /**
   * Anchors are a connection affordance, so they stay hidden until there is
   * something to connect *to* — one pin on the board means four dots offering
   * an action that cannot be completed. Beyond that they wait for hover or
   * selection rather than sitting on every card permanently.
   */
  const canConnect = board.pins.length >= 2;
  const showAnchors = canConnect && (hovered || selected || connecting);
  const multi = chips.length > 1;

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
      <div className="pin-object__card" data-pulse={pulse}>
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

      {primary ? (
        <div className="pin-note" data-no-drag>
          {pin.annotation && !multi && (
            <div className="pin-note__saved">
              <span>{pin.annotation}</span>
            </div>
          )}

          <Composer
            chips={chips}
            meta={multi ? `${chips.length} pins selected` : `${pin.route} · ${pin.viewport.width}`}
            onCommit={onCommit}
            onRelate={onRelate}
            autoFocus
          />

          {targetCount > 0 && !multi && (
            <div className="pin-note__rel">
              <LinkIcon size={13} />
              source for {targetCount} pin{targetCount === 1 ? "" : "s"}
            </div>
          )}
        </div>
      ) : (
        pin.annotation &&
        !selected && (
          <div className="pin-note pin-note--collapsed" data-no-drag>
            <button className="pin-note__saved" onClick={() => onSelect(false)} title="Open annotation">
              <span>{pin.annotation}</span>
            </button>
          </div>
        )
      )}
    </div>
  );
}
