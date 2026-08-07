import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Pin } from "@pinnables/shared";
import { CloseIcon, LinkIcon } from "../ui/icons";
import { defaultEdgeFor, nearestEdge, type AnchorEdge } from "../ui/theme";
import { Composer } from "./Composer";
import type { FloatPosition } from "./Overlay";

export type { AnchorEdge };

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
  selectionCount: number;
  connecting: boolean;
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
  selectionCount,
  connecting,
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
  const [nearEdge, setNearEdge] = useState<AnchorEdge | null>(null);
  const dragging = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

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
      if (drag) {
        onMove({
          x: Math.max(4, event.clientX - drag.dx),
          y: Math.max(4, event.clientY - drag.dy),
        });
        return;
      }
      const rect = card.current?.getBoundingClientRect();
      if (rect) setNearEdge(nearestEdge(rect, { x: event.clientX, y: event.clientY }));
    },
    [onMove],
  );

  const relationships = board.relationships.filter((r) => r.sourcePinId === pin.id);
  const targetCount = relationships.reduce((sum, r) => sum + r.targetPinIds.length, 0);
  /** The component name where the build provides one, else the text it wraps. */
  const label = pin.componentName ?? pin.elementText.slice(0, 28).trim() ?? "";

  /*
   * The card keeps the element's own corners.
   *
   * The picker already traces them, so a fixed radius here meant the outline you
   * drew and the card you got disagreed — you selected a 4px stat card and were
   * handed a 10px one. What floats is a picture of the component, so it should
   * be that component's shape. Clamped, because an element with a pill radius
   * would turn its card into a lozenge, and region pins fall back since they
   * have no element to borrow from.
   */
  const radiusPx = (() => {
    if (pin.kind !== "element") return null;
    const captured = pin.computedStyles["border-radius"];
    if (captured === undefined) return 0;
    const px = Number.parseFloat(captured);
    return Number.isFinite(px) ? Math.min(px, 18) : null;
  })();
  const shape =
    radiusPx === null
      ? undefined
      : ({
          "--pin-card-radius": `${radiusPx}px`,
          // The label follows the card's corners so the two read as one object,
          // but capped well short of it — past about 8px on a 24px bar the
          // curves eat the ends and crowd the text against them.
          "--pin-label-radius": `${Math.min(radiusPx, 8)}px`,
        } as React.CSSProperties);

  /**
   * One anchor, on one edge.
   *
   * Anchors are a connection affordance, so they stay hidden until there is
   * something to connect *to* — one pin on the board means dots offering an
   * action that cannot be completed. Beyond that: the edge with the most room
   * to run a wire into is offered by default (a card against the right of the
   * screen offers its left, one at the top offers its bottom), and moving
   * toward any other edge midpoint offers that one instead. All four stay
   * reachable without four dots sitting on every card.
   */
  const canConnect = board.pins.length >= 2;
  const showAnchor = canConnect && (hovered || selected || connecting);
  const rect = card.current?.getBoundingClientRect();
  const fallbackEdge: AnchorEdge = rect
    ? defaultEdgeFor(rect, { width: window.innerWidth, height: window.innerHeight })
    : "left";
  const anchorEdge = nearEdge ?? fallbackEdge;

  return (
    <div
      ref={ref}
      className="pin-object"
      data-selected={selected}
      data-pin-id={pin.id}
      style={{ left: position.x, top: position.y, ...shape }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (dragging.current = null)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setNearEdge(null);
      }}
    >
      {/*
        * The name floats above the card rather than sitting on it, and only
        * while the pin is selected.
        *
        * It is the picker's own label, kept after the click — one language for
        * "what is this", inverted to black so the two are not mistaken for each
        * other. Keeping it off the card matters more here than in most UI: the
        * card is a picture of the component, and a bar drawn across its top is a
        * lie about what that component looks like.
        */}
      {selected && (
        <div className="pin-object__label" data-no-drag>
          <span className="pin-object__name">{label}</span>
          <span className="pin-object__src" title={pin.sourceFile ?? pin.url}>
            {pin.sourceFile ?? pin.route}
          </span>
          <button
            className="pin-icon-btn"
            style={{ width: 18, height: 18, flex: "0 0 auto" }}
            onClick={onDismiss}
            title="Hide from this page — the pin stays on the board"
            aria-label="Hide pin from page"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      )}

      <div className="pin-object__card" data-pulse={pulse} ref={card}>
        <div className="pin-object__inner">
          {shot ? (
            <img className="pin-object__shot" src={shot} alt={pin.elementText || "Pinned element"} />
          ) : (
            <div className="pin-object__shot" style={{ width: 180, height: 90 }} />
          )}
        </div>

        {showAnchor && (
          <span
            className="pin-anchor"
            data-edge={anchorEdge}
            data-no-drag
            title="Drag to another pin to connect them"
            onPointerDown={(event) => {
              event.stopPropagation();
              onAnchorDown(pin.id, anchorEdge, event);
            }}
            onPointerEnter={() => onAnchorEnter(pin.id, anchorEdge)}
            onPointerLeave={onAnchorLeave}
          />
        )}
      </div>

      {primary ? (
        <div className="pin-note" data-no-drag>
          {pin.annotation && (
            <div className="pin-note__saved">
              <span>{pin.annotation}</span>
            </div>
          )}

          <Composer count={selectionCount} onCommit={onCommit} onRelate={onRelate} autoFocus />

          {targetCount > 0 && (
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
