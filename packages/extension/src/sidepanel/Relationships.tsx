import {
  computeStyleDiff,
  differingGroups,
  STYLE_GROUPS,
  type Board,
  type Relationship,
} from "@pinnables/shared";
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
  /** Source and target read the same way, so the pair scans as a pair. */
  const line = (pinId: string, role: string) => {
    const pin = byId.get(pinId);
    if (!pin) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ color: "var(--pin-ink-muted)", display: "inline-flex", flex: "0 0 auto" }}>
          <LinkIcon size={14} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, minWidth: 0 }}>
          <RenamableTitle pin={pin} siblings={board.pins} onChanged={onChanged} />
          <span style={{ color: "var(--pin-ink-muted)", fontWeight: 400 }}> is the {role}</span>
        </span>
      </div>
    );
  };

  /*
   * Which groups are worth deciding about.
   *
   * A group where both pins already agree has nothing to apply, so offering it
   * as a live choice is offering a change that would do nothing. It stays on
   * screen, greyed, because silence would read as "never checked" rather than
   * "checked and fine".
   */
  const differing = source
    ? new Set(
        relationship.targetPinIds.flatMap((id) => {
          const target = byId.get(id);
          return target ? differingGroups(source, target, GROUP_NAMES) : [];
        }),
      )
    : new Set<string>();
  const matched = GROUP_NAMES.filter((g) => !differing.has(g));

  const patch = async (next: Partial<Relationship>) => {
    await send("relationship/update", { relationshipId: relationship.id, patch: next });
    onChanged();
  };

  const toggleProperty = (group: string) => {
    const has = relationship.properties.includes(group);
    void patch({
      properties: has
        ? relationship.properties.filter((p) => p !== group)
        : [...relationship.properties, group],
    });
  };

  return (
    <div className="pin-card">
      <div style={{ padding: "10px 11px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            {line(relationship.sourcePinId, "source")}
            {relationship.targetPinIds.map((id) => (
              <div key={id}>{line(id, "target")}</div>
            ))}
          </div>
          <button
            className="pin-btn pin-btn--ghost"
            style={{ width: 28, padding: 0, flex: "0 0 auto" }}
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
          {matched.length > 0 && <p className="pin-note-line">Grayed properties already match.</p>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {GROUP_NAMES.map((group) => {
              const same = !differing.has(group);
              return (
                <button
                  key={group}
                  className="pin-chip"
                  data-on={relationship.properties.includes(group)}
                  disabled={same}
                  onClick={() => !same && toggleProperty(group)}
                  title={same ? "Already the same on both" : `Make the target match on ${group}`}
                >
                  {group}
                </button>
              );
            })}
          </div>
        </div>

        {source &&
          relationship.targetPinIds.map((targetId) => {
            const target = byId.get(targetId);
            if (!target) return null;
            const diff = computeStyleDiff(source, target, relationship.properties);
            return (
              <div key={targetId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {diff.length === 0 ? null : (
                  <div className="pin-diff">
                    {diff.map((entry) => (
                      <div className="pin-diff__row" key={entry.property}>
                        <span>{entry.property}</span>
                        <span className="pin-diff__from">{entry.from}</span>
                        <span className="pin-diff__arrow">→</span>
                        <span>{entry.to}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

        <textarea
          className="pin-field"
          rows={2}
          placeholder="Add an annotation…"
          defaultValue={relationship.exception}
          onBlur={(e) => e.target.value !== relationship.exception && void patch({ exception: e.target.value })}
        />
      </div>
    </div>
  );
}
