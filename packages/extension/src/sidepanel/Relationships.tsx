import {
  computeBlockedChanges,
  computeStyleDiff,
  groupOf,
  describeChange,
  expandProperties,
  rawPropertiesFor,
  STYLE_ALLOWLIST,
  STYLE_GROUPS,
  type Board,
  type BlockedChange,
  type DiffDetail,
  type Pin,
  type Relationship,
} from "@pinnables/shared";
import { ChangePair, hasPreview } from "./ChangePreview";
import { RenamableTitle } from "./RenamableTitle";
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
        // No applicability threaded here: `computeStyleDiff` already dropped
        // everything the guard rejects, so every entry that reaches this line
        // is applicable by construction and passing the guard's verdict would
        // only imply a variation that cannot occur. The blocked ones come back
        // separately below, carrying their own.
        return computeStyleDiff(source, target, GROUP_NAMES).map((entry) => ({
          key: `${targetId}:${entry.property}`,
          entry: describeChange(entry),
          raw: rawPropertiesFor(entry.property),
        }));
      })
    : [];

  /**
   * The differences that exist and cannot be acted on — a width the flex row
   * decides, a border colour on a card that draws no border. They are not in
   * the diff, because the agent must not be handed instructions that do
   * nothing, and the preview must not try to apply them. They are still true
   * about these two pins, so the panel says so rather than leaving the reader
   * to wonder why "size" is greyed out.
   */
  const blocked = source
    ? relationship.targetPinIds.flatMap((targetId) => {
        const target = byId.get(targetId);
        if (!target) return [];
        return computeBlockedChanges(source, target, GROUP_NAMES).map((entry) => ({
          key: `${targetId}:${entry.property}`,
          entry,
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

  /*
   * "Already match" has to mean it, and it did not.
   *
   * A chip is disabled when `groupRaw` finds nothing to apply — but that happens
   * for two unrelated reasons. The group genuinely matches, or every difference
   * in it is *blocked*: real, visible, and impossible to write to the target.
   * `size` is the second case whenever both cards are flex-stretched — the
   * widths differ, you can see they differ, and the card claimed they matched
   * while a disclosure two lines below said "2 that can't be applied".
   *
   * So the sentence is now earned per group: a group counts as matching only
   * when nothing differs *and* nothing was blocked in it.
   */
  const blockedGroups = new Set(
    blocked.map(({ entry }) => groupOf(entry.property)).filter((g): g is string => g !== null),
  );
  /*
   * Canonical order, so the table does not reshuffle as selections change.
   *
   * `STYLE_ALLOWLIST` is the order the properties are captured in, which is the
   * order they were read in before the buckets split them up. A collapsed row
   * like `padding` sorts by the first longhand underneath it.
   */
  const rank = (property: string) => {
    const first = rawPropertiesFor(property)[0] ?? property;
    const at = STYLE_ALLOWLIST.indexOf(first);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const ordered = [
    ...rows.map((r) => ({ ...r, blocked: false as const })),
    ...blocked.map((b) => ({ ...b, raw: [] as string[], blocked: true as const })),
  ].sort((a, b) => rank(a.entry.property) - rank(b.entry.property));

  const anyMatched = GROUP_NAMES.some(
    (group) => groupRaw(group).length === 0 && !blockedGroups.has(group),
  );

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
            className="pin-icon-btn"
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
        {/*
          One table, in the order the properties are captured in.
          
          Splitting it into "you can see these", "you cannot see these" and
          "these cannot be applied" was three disclosures over five rows: you
          had to open two of them to find out that width and height were even
          in the diff. Every difference is listed, in one place, in a stable
          order — the ones that cannot be applied say so in their own row rather
          than being counted behind a toggle.
        */}
        {ordered.length > 0 && (
          <div className="pin-changes">
            {ordered.map((row) =>
              row.blocked ? (
                <BlockedRow key={row.key} change={row.entry} />
              ) : (
                <ChangeRow
                  key={row.key}
                  detail={row.entry}
                  on={row.raw.every((p) => selected.has(p))}
                  onToggle={(next) => toggle(row.raw, next)}
                />
              ),
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
 * A difference the guard rejected, shown as an explanation rather than an option.
 *
 * No checkbox: the row exists precisely because there is nothing to apply, and
 * a control that cannot be acted on is worse than no control. The values move
 * to the tooltip — they are why this looks like a change, not what you would do
 * about it — and the reason takes their place, uncapitalised in the data and
 * read as a fragment here.
 */
function BlockedRow({ change }: { change: BlockedChange }) {
  return (
    <div
      className="pin-change pin-change--blocked"
      title={`${change.property}: ${change.from} → ${change.to}`}
    >
      <span />
      <span className="pin-change__name">{change.property}</span>
      <span className="pin-change__caption pin-change__caption--lead">
        can&apos;t apply — {change.applicability.reason}
      </span>
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
  /*
   * The grid, not the swatches.
   *
   * Rendering each difference in its own medium reads better one row at a time
   * and worse as a list: every row became three lines tall, and a card with six
   * changes no longer fit on screen — you lost the comparison the table was for.
   *
   * The decomposition survives, which was the half that mattered. `summary`
   * turns `rgba(0,0,0,.06) 0 1px 2px → rgba(0,0,0,.08) 0 4px 12px` into
   * `y 1→4 · blur 2→12`, and that is text, so it costs one line like the rest.
   *
   * `ChangePreview` is kept, not deleted — the swatches are right for a single
   * focused change, and this is the call site that decided against them.
   */
  const from = detail.summary ? null : detail.from;
  const visual = hasPreview(detail.kind);

  return (
    <label className={`pin-change${visual ? " pin-change--stacked" : ""}`} data-on={on}>
      <input
        type="checkbox"
        className="pin-change__box"
        checked={on}
        onChange={() => onToggle(!on)}
      />
      <span className="pin-change__name">{detail.property}</span>

      {from === null ? (
        <span className="pin-change__summary">{detail.summary}</span>
      ) : (
        <>
          <span className="pin-change__from">{from}</span>
          <span className="pin-change__arrow">→</span>
          <span className="pin-change__to">{detail.to}</span>
        </>
      )}

      {/*
        The picture under the numbers, not instead of them.
        
        Showing only the drawing lost the exact values, and showing only the
        values made a shadow into two forty-character strings. Stacked, the row
        reads the way you actually judge one: the shape tells you whether you
        want it, the numbers tell you what it is. Aligned to the value columns
        so the before sits under the before.
        
        Only where a drawing can be honest — a radius is a corner and a shadow
        is a shadow, but there is no picture of `display: flex` that is not a
        diagram of something else.
      */}
      {visual && (
        <span className="pin-change__viz">
          <ChangePair detail={detail} />
        </span>
      )}
    </label>
  );
}
