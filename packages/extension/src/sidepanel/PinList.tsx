import { useCallback, useEffect, useState } from "react";
import { describeDrawings, sortedByOrder, type Board, type Pin } from "@pinnables/shared";
import { send, type Contract } from "../lib/messages";
import { ArrowUpRightIcon, CheckIcon, LinkIcon, TrashIcon } from "../ui/icons";
import { Inspector } from "./Inspector";

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
  const [relatingFrom, setRelatingFrom] = useState<string | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());

  const pins = sortedByOrder(board.pins);

  const toggleTarget = (pinId: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(pinId) ? next.delete(pinId) : next.add(pinId);
      return next;
    });

  const confirmRelationship = useCallback(async () => {
    if (!relatingFrom || targets.size === 0) return;
    await send("relationship/create", {
      sourcePinId: relatingFrom,
      targetPinIds: [...targets],
    });
    setRelatingFrom(null);
    setTargets(new Set());
    onChanged();
  }, [relatingFrom, targets, onChanged]);

  return (
    <>
      {relatingFrom && (
        <div
          className="pin-banner"
          style={{
            background: "var(--pin-sky-tint)",
            color: "var(--pin-cobalt)",
            borderColor: "transparent",
          }}
        >
          <LinkIcon size={14} />
          <span style={{ flex: 1 }}>Pick which pins should match this one, then confirm.</span>
        </div>
      )}

      {pins.map((pin) => (
        <PinRow
          key={pin.id}
          pin={pin}
          board={board}
          expanded={expanded === pin.id}
          onExpand={() => setExpanded((id) => (id === pin.id ? null : pin.id))}
          relating={relatingFrom !== null}
          isSource={relatingFrom === pin.id}
          isTarget={targets.has(pin.id)}
          onToggleTarget={() => toggleTarget(pin.id)}
          onRelateFrom={() => {
            setRelatingFrom(pin.id);
            setTargets(new Set());
            setExpanded(null);
          }}
          onChanged={onChanged}
        />
      ))}

      {relatingFrom && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pin-btn"
            onClick={() => {
              setRelatingFrom(null);
              setTargets(new Set());
            }}
          >
            Cancel
          </button>
          <button
            className="pin-btn pin-btn--primary"
            style={{ marginLeft: "auto" }}
            disabled={targets.size === 0}
            onClick={() => void confirmRelationship()}
          >
            <CheckIcon size={14} />
            Match {targets.size} pin{targets.size === 1 ? "" : "s"}
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
  onRelateFrom: () => void;
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
  onRelateFrom,
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

  const title = pin.componentName ?? pin.elementText.slice(0, 32) ?? pin.selector;
  const linked = board.relationships.some(
    (r) => r.sourcePinId === pin.id || r.targetPinIds.includes(pin.id),
  );
  const selectable = pin.kind === "element";

  const update = async (patch: Contract["pin/update"]["req"]["patch"]) => {
    await send("pin/update", { pinId: pin.id, patch });
    onChanged();
  };

  return (
    <div className="pin-card" data-selected={isSource || isTarget}>
      <div className="pin-row">
        <button
          className="pin-row__hit"
          data-done={pin.status === "done"}
          onClick={relating ? (isSource || !selectable ? undefined : onToggleTarget) : onExpand}
          style={relating && !selectable ? { opacity: 0.45 } : undefined}
        >
          {thumb ? (
            <img className="pin-row__thumb" src={thumb} alt="" />
          ) : (
            <span className="pin-row__thumb" />
          )}

          <span className="pin-row__main">
            <span className="pin-row__head">
              <span className="pin-row__title">{title || "Element"}</span>
              {pin.kind === "region" && <span className="pin-chip pin-chip--mono">region</span>}
              <span className="pin-row__route">{pin.route}</span>
              {linked && (
                <span
                  style={{ color: "var(--pin-cobalt)", display: "inline-flex" }}
                  title="In a relationship"
                >
                  <LinkIcon size={13} />
                </span>
              )}
            </span>
            <span className="pin-row__note">{pin.annotation || "No annotation yet"}</span>
          </span>
        </button>

        {/* While relating, the trailing slot says what picking this row would do
            — swapping in a delete button mid-flow would put the one destructive
            control under the cursor that is busy selecting things. */}
        <span className="pin-row__actions">
          {relating ? (
            isSource ? (
              <span className="pin-chip" data-on="true">
                reference
              </span>
            ) : (
              <span className="pin-chip" data-on={isTarget}>
                {isTarget ? "match" : "pick"}
              </span>
            )
          ) : (
            /* Same tinted disc as the active tool in the nav, in red — the one
               control here that destroys something, so it gets the one colour
               reserved for the mark. Status lives on the row's own styling
               (a resolved pin strikes through its title), so a second dot
               beside this would be a signal nobody reads. */
            <button
              className="pin-icon-btn pin-icon-btn--danger"
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

          {/* The tags the composer deliberately doesn't carry. On the page they
              would repeat what the outline already says; here they are the only
              place the pin's identity is written down. */}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {pin.componentName && <span className="pin-chip">{pin.componentName}</span>}
            <span className="pin-chip pin-chip--mono">{pin.route}</span>
            <span className="pin-chip pin-chip--mono">
              {pin.viewport.width}×{pin.viewport.height}
              {pin.captureState !== "default" ? ` · ${pin.captureState}` : ""}
            </span>
            <span className="pin-chip pin-chip--mono">{pin.sourceFile ?? "source unresolved"}</span>
          </div>

          {pin.kind === "region" ? (
            <dl className="pin-meta-grid">
              <dt>Marks</dt>
              <dd>{describeDrawings(pin.drawings) || "none"}</dd>
            </dl>
          ) : (
            <>
              <span className="pin-section-label">Computed — type over any value</span>
              <Inspector pin={pin} onEdit={(styleEdits) => void update({ styleEdits })} />
              <dl className="pin-meta-grid">
                <dt>Selector</dt>
                <dd>{pin.selector}</dd>
              </dl>
            </>
          )}

          <textarea
            className="pin-field"
            rows={2}
            value={draft}
            placeholder="Add an annotation…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== pin.annotation && void update({ annotation: draft })}
          />

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="pin-btn" onClick={() => void send("pin/revealSource", { pinId: pin.id })}>
              <ArrowUpRightIcon />
              Go to source
            </button>
            {/* Relationships resolve into a style diff, and a region pin has no
                computed styles to diff — it marks an area, not a component. */}
            {pin.kind === "element" && (
              <button className="pin-btn" onClick={onRelateFrom}>
                <LinkIcon size={14} />
                Use as reference
              </button>
            )}
            <button
              className="pin-btn"
              onClick={() => void update({ status: pin.status === "done" ? "todo" : "done" })}
            >
              <CheckIcon size={14} />
              {pin.status === "done" ? "Reopen" : "Resolve"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
