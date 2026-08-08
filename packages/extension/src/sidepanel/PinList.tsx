import { useCallback, useEffect, useState } from "react";
import { describeDrawings, pinLabel, sortedByOrder, type Board, type Pin } from "@pinnables/shared";
import { send, type Contract } from "../lib/messages";
import { ArrowUpRightIcon, CheckIcon, LinkIcon, TrashIcon } from "../ui/icons";
import { Inspector } from "./Inspector";
import { RenamableTitle } from "./RenamableTitle";

/**
 * Compact rows by default, expand for the screenshot and the inspector.
 *
 * The shelf's job is recognition while you navigate — "did I already pin that
 * card?" — and a hundred full-size cards is a scroll nobody can navigate. So
 * rows scan, and everything measurable about a pin is one click away when you
 * are actually deciding something.
 */
export function PinList({ board, onChanged }: { board: Board; onChanged: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The pin every picked pin will be made to match — `sourcePinId` in the contract. */
  const [source, setSource] = useState<string | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());

  const pins = sortedByOrder(board.pins);

  const toggleTarget = (pinId: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(pinId) ? next.delete(pinId) : next.add(pinId);
      return next;
    });

  const confirmRelationship = useCallback(async () => {
    if (!source || targets.size === 0) return;
    await send("relationship/create", {
      sourcePinId: source,
      targetPinIds: [...targets],
    });
    setSource(null);
    setTargets(new Set());
    onChanged();
  }, [source, targets, onChanged]);

  return (
    <>
      {source && (
        <div
          className="pin-banner"
          style={{
            background: "var(--pin-off)",
            color: "var(--pin-ink)",
            borderColor: "transparent",
          }}
        >
          <LinkIcon size={14} />
          {/* Source and target are named here rather than left to be inferred,
              because the direction is the whole meaning of the relationship —
              which pin changes and which one stays put. */}
          <span style={{ flex: 1 }}>Pick the targets that should match this source.</span>
        </div>
      )}

      {pins.map((pin) => (
        <PinRow
          key={pin.id}
          pin={pin}
          board={board}
          expanded={expanded === pin.id}
          onExpand={() => setExpanded((id) => (id === pin.id ? null : pin.id))}
          relating={source !== null}
          isSource={source === pin.id}
          isTarget={targets.has(pin.id)}
          onToggleTarget={() => toggleTarget(pin.id)}
          onCreateRelationship={() => {
            setSource(pin.id);
            setTargets(new Set());
            setExpanded(null);
          }}
          onChanged={onChanged}
        />
      ))}

      {source && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pin-btn"
            onClick={() => {
              setSource(null);
              setTargets(new Set());
            }}
          >
            Cancel
          </button>
          {/* Just the verb. The count was already on screen twice — once as the
              highlighted rows, once as their target chips — and a button that
              renumbers itself as you click is a label you have to re-read. */}
          <button
            className="pin-btn pin-btn--primary"
            style={{ marginLeft: "auto" }}
            disabled={targets.size === 0}
            onClick={() => void confirmRelationship()}
          >
            <CheckIcon size={14} />
            Match
          </button>
        </div>
      )}
    </>
  );
}

interface PinRowProps {
  pin: Pin;
  board: Board;
  expanded: boolean;
  onExpand: () => void;
  relating: boolean;
  isSource: boolean;
  isTarget: boolean;
  onToggleTarget: () => void;
  onCreateRelationship: () => void;
  onChanged: () => void;
}

function PinRow({
  pin,
  board,
  expanded,
  onExpand,
  relating,
  isSource,
  isTarget,
  onToggleTarget,
  onCreateRelationship,
  onChanged,
}: PinRowProps) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [draft, setDraft] = useState(pin.annotation);

  useEffect(() => {
    void chrome.storage.local.get(`thumb:${pin.id}`).then((bag) => {
      setThumb((bag[`thumb:${pin.id}`] as string | undefined) ?? null);
    });
  }, [pin.id]);

  useEffect(() => {
    if (!expanded || shot) return;
    void chrome.storage.local.get(`shot:${pin.id}`).then((bag) => {
      setShot((bag[`shot:${pin.id}`] as string | undefined) ?? null);
    });
  }, [expanded, shot, pin.id]);

  useEffect(() => setDraft(pin.annotation), [pin.annotation]);

  const title = pinLabel(pin, board.pins);
  const linked = board.relationships.some(
    (r) => r.sourcePinId === pin.id || r.targetPinIds.includes(pin.id),
  );
  const selectable = pin.kind === "element";
  const pickable = relating && !isSource && selectable;
  /*
   * While relating, the card is the control.
   *
   * Outside that mode the content area is the expand button and the trailing
   * action is a separate delete button. In target-picking mode there is only
   * one possible action, so the content switches to a span and the card owns
   * the click. That makes the thumbnail, title, empty space, and the visible
   * "pick" affordance one target without nesting buttons.
   */
  const Hit = relating ? "span" : "button";

  const update = async (patch: Contract["pin/update"]["req"]["patch"]) => {
    await send("pin/update", { pinId: pin.id, patch });
    onChanged();
  };

  return (
    <div
      className="pin-card"
      onClick={pickable ? onToggleTarget : undefined}
      onKeyDown={
        pickable
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggleTarget();
            }
          : undefined
      }
      role={pickable ? "button" : undefined}
      tabIndex={pickable ? 0 : undefined}
      aria-label={pickable ? `Select ${title || "pin"} as relationship target` : undefined}
      data-pickable={pickable}
      data-selected={isSource || isTarget}
    >
      <div className="pin-row">
        <Hit
          className="pin-row__hit"
          data-done={pin.status === "done"}
          onClick={relating ? undefined : onExpand}
          style={relating && !selectable ? { opacity: 0.45 } : undefined}
        >
          {thumb ? (
            <img className="pin-row__thumb" src={thumb} alt="" />
          ) : (
            <span className="pin-row__thumb" />
          )}

          <span className="pin-row__main">
            <span className="pin-row__head">
              <RenamableTitle
                pin={pin}
                siblings={board.pins}
                onChanged={onChanged}
                className="pin-row__title"
                readOnly={relating}
              />
              {pin.kind === "region" && <span className="pin-chip pin-chip--mono">region</span>}
              <span className="pin-row__route">{pin.route}</span>
              {linked && (
                <span
                  style={{ color: "var(--pin-ink-muted)", display: "inline-flex" }}
                  title="In a relationship"
                >
                  <LinkIcon size={13} />
                </span>
              )}
            </span>
            <span className="pin-row__note">{pin.annotation || "No annotation yet"}</span>
          </span>
        </Hit>

        {/* While relating, the trailing slot says what picking this row would do
            — swapping in a delete button mid-flow would put the one destructive
            control under the cursor that is busy selecting things. */}
        <span className="pin-row__actions">
          {relating ? (
            isSource ? (
              <span className="pin-chip" data-on="true">
                source
              </span>
            ) : (
              /* Picked rows name their role; unpicked ones name the gesture,
                 since "target" on a row you have not chosen would read as a
                 claim about the row rather than an invitation. */
              <span className="pin-chip" data-on={isTarget}>
                {isTarget ? "target" : "pick"}
              </span>
            )
          ) : (
            /* Plain icon button. Colouring it would make every row on the shelf
               carry a warning, and the row is not dangerous — the click is, and
               the click is one gesture away from being undone by re-pinning. */
            <button
              className="pin-icon-btn pin-icon-btn--square"
              style={{ width: 24, height: 24 }}
              onClick={async () => {
                await send("pin/delete", { pinId: pin.id });
                onChanged();
              }}
              aria-label={`Delete ${title || "pin"}`}
              title="Delete pin"
            >
              <TrashIcon size={14} />
            </button>
          )}
        </span>
      </div>

      {expanded && !relating && (
        <div className="pin-expand">
          {shot && <img className="pin-expand__shot" src={shot} alt={pin.elementText} />}

          {pin.kind === "region" ? (
            <div className="pin-metrics">
              <div className="pin-metric pin-metric--fact">
                <span className="pin-metric__name">route</span>
                <span className="pin-metric__value">{pin.route}</span>
                <span />
              </div>
              <div className="pin-metric pin-metric--fact">
                <span className="pin-metric__name">marks</span>
                <span className="pin-metric__value">
                  {describeDrawings(pin.drawings) || "none"}
                </span>
                <span />
              </div>
            </div>
          ) : (
            /* Identity and measurements are one list now — the component name is
               a labelled row like every other fact, rather than a bare chip. */
            <Inspector pin={pin} onEdit={(styleEdits) => void update({ styleEdits })} />
          )}

          <textarea
            className="pin-field"
            rows={2}
            value={draft}
            placeholder="Add an annotation…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== pin.annotation && void update({ annotation: draft })}
          />

          {/* Two actions, both of which take you somewhere: to the code, or into
              picking what this pin should match. */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="pin-btn" onClick={() => void send("pin/revealSource", { pinId: pin.id })}>
              <ArrowUpRightIcon />
              Go to pin
            </button>
            {/* Relationships resolve into a style diff, and a region pin has no
                computed styles to diff — it marks an area, not a component. */}
            {/* The noun matches the tab this ends up on, so the button and the
                place its result lands are called the same thing. "New" rather
                than "Create" because pressing this makes nothing yet — it opens
                the picker, and the relationship is written two clicks later at
                Match. */}
            {pin.kind === "element" && (
              <button className="pin-btn" onClick={onCreateRelationship}>
                <LinkIcon size={14} />
                New relationship
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
