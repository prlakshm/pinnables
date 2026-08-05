import { useCallback, useEffect, useState } from "react";
import { describeDrawings, formatStyles, sortedByOrder, type Board, type Pin } from "@pinnables/shared";
import { send, type Contract } from "../lib/messages";
import { ArrowUpRightIcon, CheckIcon, LinkIcon, TrashIcon } from "../ui/icons";

/**
 * Compact rows by default, expand for the screenshot.
 *
 * The shelf's job is recognition while you navigate — "did I already pin that
 * card?" — and a hundred full-size cards is a scroll nobody can navigate. So
 * rows scan, and the screenshot is one click away when you're actually deciding
 * something.
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
        <div className="pin-banner" style={{ background: "var(--pin-sky-tint)", color: "var(--pin-cobalt)" }}>
          <LinkIcon size={14} />
          <span style={{ flex: 1 }}>
            Pick which pins should match this one, then confirm.
          </span>
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
      <button
        className="pin-row"
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
              <span style={{ color: "var(--pin-cobalt)", display: "inline-flex" }} title="In a relationship">
                <LinkIcon size={13} />
              </span>
            )}
          </span>
          <span className="pin-row__note">{pin.annotation || "No annotation yet"}</span>
        </span>

        {relating ? (
          <span className="pin-row__actions">
            {isSource ? (
              <span className="pin-chip" data-on="true">reference</span>
            ) : (
              <span className="pin-chip" data-on={isTarget}>{isTarget ? "match" : "pick"}</span>
            )}
          </span>
        ) : (
          <span className="pin-status" data-status={pin.status}>
            <span className="pin-status-dot" />
          </span>
        )}
      </button>

      {expanded && !relating && (
        <div className="pin-expand">
          {shot && <img className="pin-expand__shot" src={shot} alt={pin.elementText} />}

          <dl className="pin-meta-grid">
            <dt>Viewport</dt>
            <dd>
              {pin.viewport.width}×{pin.viewport.height}
              {pin.captureState !== "default" ? ` · ${pin.captureState}` : ""}
            </dd>
            {pin.kind === "region" ? (
              <>
                <dt>Marks</dt>
                <dd>{describeDrawings(pin.drawings) || "none"}</dd>
              </>
            ) : (
              <>
                <dt>Source</dt>
                <dd>{pin.sourceFile ?? "unresolved"}</dd>
                <dt>Selector</dt>
                <dd>{pin.selector}</dd>
                <dt>Styles</dt>
                <dd>{formatStyles(pin.computedStyles)}</dd>
              </>
            )}
          </dl>

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
            <button
              className="pin-btn pin-btn--ghost"
              style={{ marginLeft: "auto" }}
              onClick={async () => {
                await send("pin/delete", { pinId: pin.id });
                onChanged();
              }}
              aria-label="Delete pin"
              title="Delete pin"
            >
              <TrashIcon size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
