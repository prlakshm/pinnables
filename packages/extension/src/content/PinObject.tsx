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
  /** Live, per frame — state only, never storage. */
  onMove: (position: FloatPosition) => void;
  /** Once, on release. This is the one that writes to disk. */
  onMoveEnd: (position: FloatPosition) => void;
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
  onMoveEnd,
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
  const dragging = useRef<{ dx: number; dy: number; at: FloatPosition } | null>(null);
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
      dragging.current = {
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        at: { x: rect.left, y: rect.top },
      };
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    },
    [onSelect],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragging.current;
      if (drag) {
        const next = {
          x: Math.max(4, event.clientX - drag.dx),
          y: Math.max(4, event.clientY - drag.dy),
        };
        drag.at = next;
        onMove(next);
        return;
      }
      const rect = card.current?.getBoundingClientRect();
      if (rect) setNearEdge(nearestEdge(rect, { x: event.clientX, y: event.clientY }));
    },
    [onMove],
  );

  /**
   * Release ends the drag, and it is the only moment anything is written down.
   * Persisting per frame meant a storage round-trip for every pixel of travel,
   * which is what made a card feel like it was being dragged through treacle.
   *
   * `pointercancel` has to do the same work: the browser fires it instead of
   * `pointerup` when a gesture is taken over — a scroll, a window losing focus —
   * and without it the card stays stuck to the cursor with no button held.
   */
  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragging.current;
      dragging.current = null;
      const target = event.currentTarget as Element;
      if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
      if (drag) onMoveEnd(drag.at);
    },
    [onMoveEnd],
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
  /**
   * Life size, and a radius that agrees with it.
   *
   * A screenshot is cut at device pixels, so on a 2x display a 264px element
   * arrives as a 529px PNG — and an <img> left to itself renders that at 529 CSS
   * px. Every card was drawn at twice the size of the thing it pictured, and
   * `max-width: 336px` then shrank it back by whatever factor happened to fall
   * out of the bitmap's dimensions.
   *
   * That arbitrary factor is what produced the corner gap. It shrank the
   * bitmap's own rounded corner along with everything else, while the clip
   * radius stayed at the captured value — so the clip was looser than the curve
   * the element had actually been cut along, and a crescent of page background
   * survived at each corner.
   *
   * So: render at the captured size, shrink only when it genuinely will not fit,
   * and scale the radius by exactly the same factor. Then the clip and the
   * bitmap agree at every size.
   */
  /*
   * Height decides the scale. Width crops.
   *
   * Scaling to satisfy both caps sounds even-handed and is not: a page heading
   * is 1240 wide and 40 tall, so a 336px width cap shrank it to 27% — text at
   * four pixels — to solve a height problem it never had. Anything wide and
   * short was destroyed to fit a limit it was nowhere near.
   *
   * So the shot is drawn at whatever scale the height cap demands, which for
   * most elements is none at all, and the frame around it clips the overflow.
   * A wide element arrives at life size showing its left-hand portion; a tall
   * one is scaled down whole, which is what it needed anyway.
   */
  const MAX_SHOT = { width: 420, height: 260 };
  const captured = pin.elementSize;
  const fit =
    captured && captured.width > 0 && captured.height > 0
      ? Math.min(1, MAX_SHOT.height / captured.height)
      : null;
  const shotStyle =
    fit !== null && captured
      ? { width: Math.round(captured.width * fit), height: Math.round(captured.height * fit) }
      : undefined;
  const cropped = shotStyle !== undefined && shotStyle.width > MAX_SHOT.width;
  const frameStyle = shotStyle
    ? { width: Math.min(shotStyle.width, MAX_SHOT.width), height: shotStyle.height }
    : undefined;

  const radiusPx = (() => {
    if (pin.kind !== "element") return null;
    const value = pin.computedStyles["border-radius"];
    const px = value === undefined ? 0 : Number.parseFloat(value);
    if (!Number.isFinite(px)) return null;
    return px * (fit ?? 1);
  })();
  const shape =
    radiusPx === null
      ? undefined
      : ({
          "--pin-card-radius": `${radiusPx}px`,
          // The label follows the card's corners so the two read as one object,
          // but capped well short of it — past about 8px on a 28px bar the
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
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
        <div className="pin-object__label">
          <span className="pin-object__name">{label}</span>
          <span className="pin-object__src" title={pin.sourceFile ?? pin.url}>
            {pin.sourceFile ?? pin.route}
          </span>
          <button
            className="pin-icon-btn"
            data-no-drag
            style={{ width: 20, height: 20, flex: "0 0 auto" }}
            onClick={onDismiss}
            title="Hide from this page — the pin stays on the board"
            aria-label="Hide pin from page"
          >
            <CloseIcon size={13} />
          </button>
        </div>
      )}

      <div className="pin-object__card" data-pulse={pulse} ref={card}>
        <div className="pin-object__inner" style={frameStyle} data-cropped={cropped}>
          {shot ? (
            <img
              className="pin-object__shot"
              src={shot}
              style={shotStyle}
              alt={pin.elementText || "Pinned element"}
            />
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
