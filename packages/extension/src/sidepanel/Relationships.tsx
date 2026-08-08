import { useState } from "react";
import {
  applicabilityGuard,
  computeStyleDiff,
  describeChange,
  expandProperties,
  rawPropertiesFor,
  STYLE_GROUPS,
  type Board,
  type DiffDetail,
  type Pin,
  type Relationship,
} from "@pinnables/shared";
import { RenamableTitle } from "./RenamableTitle";
import { ChangePair, hasPreview } from "./ChangePreview";
import { send } from "../lib/messages";
import { LinkIcon, TrashIcon } from "../ui/icons";

const GROUP_NAMES = Object.keys(STYLE_GROUPS);

/**
 * The differentiator, and the only screen here that no competitor has.
 *
 * The diff is computed, never typed — both pins already carry their captured
 * styles, so "make this match that" resolves into concrete before → after
 * values the agent can apply rather than interpret.
 */
export function Relationships({ board, onChanged }: { board: Board; onChanged: () => void }) {
  if (board.relationships.length === 0) {
    return (
      <div className="pin-empty">
        <LinkIcon size={22} />
        <strong style={{ fontWeight: 500, color: "var(--pin-ink)" }}>No relationships yet</strong>
        <span>
          Open a pin, choose <em>New relationship</em>, then pick the targets that should match it.
          Pinnables works out the exact style differences for you.
        </span>
      </div>
    );
  }

  return (
    <>
      {board.relationships.map((rel) => (
        <RelationshipCard key={rel.id} board={board} relationship={rel} onChanged={onChanged} />
      ))}
    </>
  );
}

function RelationshipCard({
  board,
  relationship,
  onChanged,
}: {
  board: Board;
  relationship: Relationship;
  onChanged: () => void;
}) {
  const byId = new Map(board.pins.map((p) => [p.id, p]));
  const source = byId.get(relationship.sourcePinId);
  const [showSubtle, setShowSubtle] = useState(false);

  /*
   * Selection lives in raw CSS properties, never in the names on screen.
   *
   * A chip says "spacing" and a row says "padding", and neither is something the
   * diff can compare — `computedStyles` holds `padding-top` and its siblings.
   * Storing the raw properties is what makes the two controls one selection seen
   * twice: a chip is on when every property beneath it is on, and ticking a row
   * can complete its chip without either control knowing the other exists.
   */
  const selected = new Set(expandProperties(relationship.properties));

  /** Every difference between the pins, regardless of what is selected. */
  const rows = source
    ? relationship.targetPinIds.flatMap((targetId) => {
        const target = byId.get(targetId);
        if (!target) return [];
        const applicable = applicabilityGuard(source, target);
        return computeStyleDiff(source, target, GROUP_NAMES).map((entry) => ({
          key: `${targetId}:${entry.property}`,
          // The same guard the diff itself ran, handed on so ranking cannot
          // promote a change that could never manifest.
          entry: describeChange(entry, applicable(entry.property)),
          raw: rawPropertiesFor(entry.property),
        }));
      })
    : [];

  /*
   * Ordered for the eye, never filtered for the agent.
   *
   * `rows` stays whole — the chips above count against it, the selection is
   * stored against it, and `computeStyleDiff` runs again untouched when the
   * board is materialized. This decides only which rows are rendered up front
   * and which sit behind a count. Nothing is dropped: a 15px that should be
   * 16px is invisible *and* is the drift this product exists to catch, so it
   * stays a click away rather than a threshold away.
   */
  const perceptible = rows.filter((r) => r.entry.perceptible);
  const subtle = rows.filter((r) => !r.entry.perceptible);

  const differingRaw = new Set(rows.flatMap((r) => r.raw));
  const groupRaw = (group: string) => expandProperties([group]).filter((p) => differingRaw.has(p));

  const write = (next: Set<string>) =>
    send("relationship/update", {
      relationshipId: relationship.id,
      patch: { properties: [...next] },
    }).then(onChanged);

  const toggle = (raw: readonly string[], on: boolean) => {
    const next = new Set(selected);
    for (const property of raw) {
      if (on) next.add(property);
      else next.delete(property);
    }
    void write(next);
  };

  const line = (pin: Pin | undefined, role: string, lead: boolean) => {
    if (!pin) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {/*
          The icon belongs to the pair rather than to each half, so only the
          source carries it — the target keeps the same indent so both names
          start on one line.
        */}
        <span
          style={{
            width: 14,
            flex: "0 0 auto",
            display: "inline-flex",
            color: "var(--pin-ink-muted)",
          }}
        >
          {lead ? <LinkIcon size={14} /> : null}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, minWidth: 0 }}>
          <RenamableTitle pin={pin} siblings={board.pins} onChanged={onChanged} />
          <span style={{ color: "var(--pin-ink-muted)", fontWeight: 400 }}> is the {role}</span>
        </span>
      </div>
    );
  };

  const anyMatched = GROUP_NAMES.some((group) => groupRaw(group).length === 0);

  return (
    <div className="pin-card">
      <div style={{ padding: "10px 11px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            {line(source, "source", true)}
            {relationship.targetPinIds.map((id) => (
              <div key={id}>{line(byId.get(id), "target", false)}</div>
            ))}
          </div>
          {/* The same button the shelf rows use — two deletes on two screens
              were two different shapes before. */}
          <button
            className="pin-icon-btn pin-icon-btn--square"
            style={{ width: 28, height: 28, flex: "0 0 auto" }}
            onClick={async () => {
              await send("relationship/delete", { relationshipId: relationship.id });
              onChanged();
            }}
            aria-label="Delete relationship"
            title="Delete relationship"
          >
            <TrashIcon size={15} />
          </button>
        </div>

        <div>
          <span className="pin-section-label">Apply changes</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {GROUP_NAMES.map((group) => {
              const raw = groupRaw(group);
              const on = raw.length > 0 && raw.every((p) => selected.has(p));
              return (
                <button
                  key={group}
                  className="pin-chip"
                  data-on={on}
                  disabled={raw.length === 0}
                  onClick={() => toggle(raw, !on)}
                  title={raw.length === 0 ? "Already the same on both" : `Match on ${group}`}
                >
                  {group}
                </button>
              );
            })}
          </div>
          {/* Under the chips, where it explains something already on screen —
              above them it was a caption for a row you had not read yet. */}
          {anyMatched && <p className="pin-note-line">Disabled properties already match.</p>}
        </div>

        {/*
          The same selection at the resolution you can actually judge. "Radius"
          is a category to have an opinion about; `4px → 12px` is two values you
          can look at.
        */}
        {rows.length > 0 && (
          <div className="pin-changes">
            {perceptible.map(({ key, entry, raw }) => (
              <ChangeRow
                key={key}
                detail={entry}
                on={raw.every((p) => selected.has(p))}
                onToggle={(next) => toggle(raw, next)}
              />
            ))}

            {/*
              The quiet ones, counted rather than listed.

              They are still in the diff and still selected by default — the
              line says so, because a reader who is told something is hidden
              will assume it was dropped.
            */}
            {subtle.length > 0 && (
              <>
                <button
                  className="pin-change pin-change--more"
                  onClick={() => setShowSubtle((open) => !open)}
                  aria-expanded={showSubtle}
                >
                  {showSubtle
                    ? `Hide ${subtle.length} you can't see`
                    : `${subtle.length} more you can't see — sent to the agent anyway`}
                </button>
                {showSubtle &&
                  subtle.map(({ key, entry, raw }) => (
                    <ChangeRow
                      key={key}
                      detail={entry}
                      on={raw.every((p) => selected.has(p))}
                      onToggle={(next) => toggle(raw, next)}
                    />
                  ))}
              </>
            )}
          </div>
        )}

        <textarea
          className="pin-field"
          rows={2}
          placeholder="Add an annotation…"
          defaultValue={relationship.exception}
          onBlur={(e) => {
            if (e.target.value === relationship.exception) return;
            void send("relationship/update", {
              relationshipId: relationship.id,
              patch: { exception: e.target.value },
            }).then(onChanged);
          }}
        />
      </div>
    </div>
  );
}

/**
 * One difference, drawn where it can be and spelled where it cannot.
 *
 * The checkbox means the same thing in both cases — this property is part of
 * the match — so the row stays a label wrapping a real checkbox rather than
 * becoming two different controls for one idea.
 */
function ChangeRow({
  detail,
  on,
  onToggle,
}: {
  detail: DiffDetail;
  on: boolean;
  onToggle: (next: boolean) => void;
}) {
  const visual = hasPreview(detail.kind);

  return (
    <label className={`pin-change${visual ? " pin-change--visual" : ""}`} data-on={on}>
      <input
        type="checkbox"
        className="pin-change__box"
        checked={on}
        onChange={() => onToggle(!on)}
      />
      <span className="pin-change__name">{detail.property}</span>

      {visual ? (
        <>
          <ChangePair detail={detail} />
          {/* The numbers keep their place, one step quieter — available to
              check, no longer the thing you have to decode. */}
          <span className="pin-change__caption">
            {detail.summary ?? `${detail.from} → ${detail.to}`}
          </span>
        </>
      ) : (
        <>
          <span className="pin-change__from">{detail.from}</span>
          <span className="pin-change__arrow">→</span>
          <span className="pin-change__to">{detail.to}</span>
        </>
      )}
    </label>
  );
}
