import { useEffect, useRef, useState } from "react";
import {
  computeStyleDiff,
  describeChange,
  expandProperties,
  pinLabel,
  rawPropertiesFor,
  STYLE_ALLOWLIST,
  STYLE_GROUPS,
  type Board,
  type DiffDetail,
  type Pin,
  type Relationship,
} from "@pinnables/shared";
import { ChangePair, hasPreview } from "./ChangePreview";
import { RenamableTitle } from "./RenamableTitle";
import { send } from "../lib/messages";
import { LinkIcon, PinIcon, TrashIcon } from "../ui/icons";

const GROUP_NAMES = Object.keys(STYLE_GROUPS);

/** Compose a group/row toggle from the latest local selection, not stale props. */
export function applySelectionToggle(
  selected: ReadonlySet<string>,
  properties: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const property of properties) {
    if (on) next.add(property);
    else next.delete(property);
  }
  return next;
}

/**
 * The differentiator, and the only screen here that no competitor has.
 *
 * The diff is computed, never typed — both pins already carry their captured
 * styles, so "make this match that" resolves into concrete before → after
 * values the agent can apply rather than interpret.
 */
export function Relationships({
  board,
  onChanged,
  focusRelationshipId,
  onFocusConsumed,
}: {
  board: Board;
  onChanged: () => void;
  /** Scroll this card into view once it exists, then report it consumed. */
  focusRelationshipId?: string | null;
  onFocusConsumed?: () => void;
}) {
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
        <RelationshipCard
          key={rel.id}
          board={board}
          relationship={rel}
          focused={focusRelationshipId === rel.id}
          onFocusConsumed={onFocusConsumed}
          onChanged={onChanged}
        />
      ))}
    </>
  );
}

function RelationshipCard({
  board,
  relationship,
  focused,
  onFocusConsumed,
  onChanged,
}: {
  board: Board;
  relationship: Relationship;
  focused?: boolean;
  onFocusConsumed?: () => void;
  onChanged: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  /**
   * A just-created relationship announces itself: scrolled into view with a
   * brief settle pulse, then it is an ordinary card. Consumed exactly once so
   * a later board refresh cannot replay the scroll under the user's cursor.
   */
  useEffect(() => {
    if (!focused) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    cardRef.current?.setAttribute("data-fresh", "true");
    const timer = window.setTimeout(() => {
      cardRef.current?.removeAttribute("data-fresh");
      onFocusConsumed?.();
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [focused, onFocusConsumed]);
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
  const incomingProperties = expandProperties(relationship.properties);
  const incomingKey = incomingProperties.join("\u0000");
  const [selected, setSelected] = useState(() => new Set(incomingProperties));
  const [writeIssue, setWriteIssue] = useState<string | null>(null);
  const selectionRef = useRef(selected);
  const incomingRef = useRef(incomingProperties);
  incomingRef.current = incomingProperties;
  const pendingWrites = useRef(0);
  const writeRevision = useRef(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  // External edits become the new baseline once our own serialized writes have
  // settled. Intermediate reloads must not roll an optimistic second click back
  // to the first patch while that second patch is still queued.
  useEffect(() => {
    if (pendingWrites.current > 0) return;
    const next = new Set(incomingProperties);
    selectionRef.current = next;
    setSelected(next);
  }, [incomingKey]);

  /**
   * Keep each target's diff intact.
   *
   * A flatMap made two targets with the same drift read as duplicate rows with
   * no owner. The target is part of the fact, so it stays attached until render;
   * the flattened views below are only for aggregate chip state.
   */
  const targetDiffs = source
    ? relationship.targetPinIds.flatMap((targetId) => {
        const target = byId.get(targetId);
        if (!target) return [];
        return [
          {
            target,
            rows: computeStyleDiff(source, target, GROUP_NAMES).map((entry) => ({
              key: `${targetId}:${entry.property}`,
              entry: describeChange(entry),
              raw: rawPropertiesFor(entry.property),
            })),
          },
        ];
      })
    : [];

  /**
   * Every actionable difference between the pins, regardless of what is
   * selected. Inapplicable differences (a border colour on a source that draws
   * no border) are simply absent — a property the agent could not act on is
   * not a choice worth a row.
   */
  const rows = targetDiffs.flatMap((target) => target.rows);

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

  const write = (next: Set<string>) => {
    const properties = [...next];
    const revision = ++writeRevision.current;
    pendingWrites.current += 1;

    const persist = async () => {
      try {
        await send("relationship/update", {
          relationshipId: relationship.id,
          patch: { properties },
        });
        if (revision === writeRevision.current) setWriteIssue(null);
      } catch {
        // Only the newest requested selection owns the visible controls. If it
        // fails, restore the latest server snapshot instead of leaving a black
        // chip that was never persisted.
        if (revision === writeRevision.current) {
          const baseline = new Set(incomingRef.current);
          selectionRef.current = new Set(incomingRef.current);
          setSelected(baseline);
          setWriteIssue("Couldn’t apply that selection. It may conflict with another relationship.");
        }
        throw new Error("Relationship update failed");
      } finally {
        pendingWrites.current -= 1;
        if (pendingWrites.current === 0) onChanged();
      }
    };

    // Both branches keep the queue moving: a failed intermediate write must not
    // strand the newer, complete selection behind it.
    writeQueue.current = writeQueue.current.then(persist, persist);
    void writeQueue.current.catch(() => {});
  };

  const toggle = (raw: readonly string[], on: boolean) => {
    const next = applySelectionToggle(selectionRef.current, raw, on);
    selectionRef.current = next;
    setSelected(next);
    write(next);
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
  const targetSections = targetDiffs
    .map(({ target, rows: targetRows }) => ({
      target,
      ordered: [...targetRows].sort((a, b) => rank(a.entry.property) - rank(b.entry.property)),
    }))
    .filter((section) => section.ordered.length > 0);
  const multipleTargets = relationship.targetPinIds.length > 1;
  const hasShadowRows = targetSections.some(({ ordered }) =>
    ordered.some((row) => row.entry.kind === "shadow"),
  );

  const disabledNote = GROUP_NAMES.some((group) => groupRaw(group).length === 0)
    ? "Faded groups already match."
    : null;

  return (
    <div className="pin-card" ref={cardRef}>
      <div style={{ padding: "10px 11px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            {line(source, "source", true)}
            {relationship.targetPinIds.map((id) => (
              <div key={id}>{line(byId.get(id), "target", false)}</div>
            ))}
          </div>
          {/* Summon the whole cluster: every involved capture lands on the
              page with its wires, ones already on screen included. */}
          <button
            className="pin-icon-btn"
            style={{ width: 28, height: 28, flex: "0 0 auto" }}
            onClick={() => {
              void send("relationship/summon", { relationshipId: relationship.id }).catch(
                () => {},
              );
            }}
            aria-label="Show this relationship on the page"
            title="Show every involved pin on the page, connected"
          >
            <PinIcon size={15} />
          </button>
          {/* The same button the shelf rows use — two deletes on two screens
              were two different shapes before. */}
          <button
            className="pin-icon-btn pin-icon-btn--danger"
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
          <div className="pin-group-grid">
            {GROUP_NAMES.map((group) => {
              const raw = groupRaw(group);
              const selectedCount = raw.filter((property) => selected.has(property)).length;
              const on = raw.length > 0 && selectedCount === raw.length;
              const partial = selectedCount > 0 && !on;
              return (
                <button
                  key={group}
                  className="pin-chip"
                  data-on={on}
                  data-partial={partial}
                  aria-pressed={partial ? "mixed" : on}
                  aria-label={raw.length === 0 ? `${group}: already matches` : undefined}
                  disabled={raw.length === 0}
                  onClick={() => toggle(raw, !on)}
                  title={raw.length === 0 ? "Already matches" : `Match on ${group}`}
                >
                  {group}
                </button>
              );
            })}
          </div>
          {/* Under the chips, where it explains something already on screen —
              above them it was a caption for a row you had not read yet. */}
          {disabledNote && <p className="pin-note-line">{disabledNote}</p>}
          {multipleTargets && (
            <p className="pin-note-line">
              Selected source styles apply to every target in this relationship.
            </p>
          )}
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
        {targetSections.length > 0 && (
          <div className="pin-changes" data-has-shadow={hasShadowRows}>
            {targetSections.map(({ target, ordered }) => {
              const headingId = `pin-change-target-${relationship.id}-${target.id}`;
              return (
                <section
                  className="pin-change-group"
                  key={target.id}
                  aria-labelledby={multipleTargets ? headingId : undefined}
                >
                  {multipleTargets && (
                    <h3 className="pin-change-target" id={headingId}>
                      <span>Target</span>
                      {pinLabel(target, board.pins)}
                    </h3>
                  )}
                  {ordered.map((row) => (
                    <ChangeRow
                      key={row.key}
                      detail={row.entry}
                      on={row.raw.every((p) => selected.has(p))}
                      allTargets={multipleTargets}
                      onToggle={(next) => toggle(row.raw, next)}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}

        {writeIssue && (
          <div className="pin-banner pin-banner--error" role="alert">
            {writeIssue}
          </div>
        )}

        <textarea
          className="pin-field"
          rows={2}
          placeholder="Add an annotation…"
          aria-label={`Relationship annotation for ${source ? pinLabel(source, board.pins) : "source"}`}
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
  allTargets,
  onToggle,
}: {
  detail: DiffDetail;
  on: boolean;
  allTargets: boolean;
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
  const shadow = detail.kind === "shadow";
  const exact = `${detail.property}: ${detail.from} → ${detail.to}`;

  return (
    <label
      className={`pin-change${visual ? " pin-change--stacked" : ""}${shadow ? " pin-change--shadow" : ""}`}
      data-on={on}
      title={exact}
    >
      <input
        type="checkbox"
        className="pin-change__box"
        checked={on}
        aria-label={
          allTargets
            ? `Match ${detail.property} on every target: ${detail.from} → ${detail.to}`
            : `Match ${exact}`
        }
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
