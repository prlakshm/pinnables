import { useCallback, useEffect, useState } from "react";
import { describeDrawings, pinLabel, sortedByOrder, type Board, type Pin } from "@pinnables/shared";
import { send, type Contract } from "../lib/messages";
import { ArrowUpRightIcon, CheckIcon, LinkIcon, PinUprightIcon, TrashIcon } from "../ui/icons";

/**
 * Which pins are currently part of the page's focus context, published by the
 * overlay. The upright pin icon fills for exactly these rows — the shelf
 * answering "is this one on screen right now" at a glance.
 */
function useOnScreenPins(): ReadonlySet<string> {
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get("onScreenPins").then((bag) => {
      if (!cancelled) setOnScreen(new Set((bag.onScreenPins as string[]) ?? []));
    });
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== "local" || !changes.onScreenPins) return;
      setOnScreen(new Set((changes.onScreenPins.newValue as string[]) ?? []));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return onScreen;
}
import { Inspector } from "./Inspector";
import { Composer } from "../content/Composer";
import { RenamableTitle } from "./RenamableTitle";

/**
 * Compact rows by default, expand for the screenshot and the inspector.
 *
 * The shelf's job is recognition while you navigate — "did I already pin that
 * card?" — and a hundred full-size cards is a scroll nobody can navigate. So
 * rows scan, and everything measurable about a pin is one click away when you
 * are actually deciding something.
 */
export function PinList({
  board,
  onChanged,
  onRelationshipCreated,
}: {
  board: Board;
  onChanged: () => void;
  /** Move directly from target picking to the diff the user just created. */
  onRelationshipCreated?: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const onScreenPins = useOnScreenPins();
  /** The pin every picked pin will be made to match — `sourcePinId` in the contract. */
  const [source, setSource] = useState<string | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [relationshipBusy, setRelationshipBusy] = useState(false);
  const [relationshipIssue, setRelationshipIssue] = useState<string | null>(null);

  /*
   * Provisional pins show while they exist: selecting a component is how you
   * read its metadata on the shelf. What keeps the shelf honest is the other
   * half — a provisional that is dismissed unspoken is deleted, so the row
   * vanishes with the selection it mirrored.
   */
  const pins = sortedByOrder(board.pins);

  /*
   * Messaged multi-selections, reopenable. A group exists only through its
   * members' shared groupId — delete pins down to one and the row simply
   * stops existing, no cleanup to forget.
   */
  const groupsById = (() => {
    const byId = new Map<string, Pin[]>();
    for (const pin of pins) {
      if (pin.groupId === null || pin.kind !== "element") continue;
      byId.set(pin.groupId, [...(byId.get(pin.groupId) ?? []), pin]);
    }
    for (const [groupId, members] of [...byId]) {
      if (members.length < 2) byId.delete(groupId);
    }
    return byId;
  })();
  const [groupIssue, setGroupIssue] = useState<string | null>(null);
  /*
   * Collapsed is the resting state: the group is its name, and the shelf
   * stays short. Users reaching for one member mostly re-select it on the
   * page; expansion is the deliberate act, remembered per group.
   */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set<string>());

  const toggleTarget = (pinId: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(pinId) ? next.delete(pinId) : next.add(pinId);
      return next;
    });

  /*
   * The matching state reaches the page: while a source is set, clicking
   * components live picks them as targets — the page and the shelf are the
   * same picker. The mode is announced on entry, revoked on any exit, and
   * picks arrive back as broadcasts that toggle the same set the rows do.
   */
  useEffect(() => {
    void send("relate/setMode", { sourcePinId: source }).catch(() => {});
    if (source === null) return;
    return () => {
      void send("relate/setMode", { sourcePinId: null }).catch(() => {});
    };
  }, [source]);
  useEffect(() => {
    if (source === null) return;
    const onMessage = (message: unknown) => {
      const picked = message as { kind?: string; pinId?: string };
      if (picked.kind !== "relate-picked" || !picked.pinId) return;
      if (picked.pinId === source) return;
      toggleTarget(picked.pinId);
      onChanged();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [source, onChanged]);

  const confirmRelationship = useCallback(async () => {
    if (!source || targets.size === 0 || relationshipBusy) return;
    setRelationshipBusy(true);
    setRelationshipIssue(null);
    try {
      await send("relationship/create", {
        sourcePinId: source,
        targetPinIds: [...targets],
      });
      setSource(null);
      setTargets(new Set());
      onChanged();
      onRelationshipCreated?.();
    } catch {
      setRelationshipIssue("Couldn’t create this relationship. The pins may have changed; try again.");
    } finally {
      setRelationshipBusy(false);
    }
  }, [source, targets, relationshipBusy, onChanged, onRelationshipCreated]);

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

      {relationshipIssue && (
        <div className="pin-banner pin-banner--error" role="alert">
          {relationshipIssue}
        </div>
      )}

      {groupIssue && (
        <div className="pin-banner pin-banner--error" role="alert">
          {groupIssue}
        </div>
      )}

      {(() => {
        const renderRow = (pin: Pin, inGroup = false) => (
          <PinRow
            key={pin.id}
            pin={pin}
            inGroup={inGroup}
            board={board}
            expanded={expanded === pin.id}
            onScreen={onScreenPins.has(pin.id)}
            onExpand={() => setExpanded((id) => (id === pin.id ? null : pin.id))}
            relating={source !== null}
            isSource={source === pin.id}
            isTarget={targets.has(pin.id)}
            onToggleTarget={() => toggleTarget(pin.id)}
            onCreateRelationship={() => {
              setSource(pin.id);
              setTargets(new Set());
              setRelationshipIssue(null);
              setExpanded(null);
            }}
            onChanged={onChanged}
          />
        );
        // Target picking needs every row reachable, so containers dissolve
        // into the flat list for the duration of the relate flow.
        if (source) return pins.map((pin) => renderRow(pin));
        const emitted = new Set<string>();
        return pins.map((pin) => {
          const groupId = pin.kind === "element" ? pin.groupId : null;
          const members = groupId ? groupsById.get(groupId) : undefined;
          if (groupId && members) {
            if (emitted.has(groupId)) return null;
            emitted.add(groupId);
            return (
              <GroupSection
                key={`group-${groupId}`}
                groupId={groupId}
                members={members}
                board={board}
                open={openGroups.has(groupId)}
                onToggleOpen={() =>
                  setOpenGroups((previous) => {
                    const next = new Set(previous);
                    next.has(groupId) ? next.delete(groupId) : next.add(groupId);
                    return next;
                  })
                }
                allOnScreen={members.every((member) => onScreenPins.has(member.id))}
                onIssue={setGroupIssue}
                onChanged={onChanged}
                renderRow={(member) => renderRow(member, true)}
              />
            );
          }
          return renderRow(pin);
        });
      })()}

      {source && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pin-btn"
            onClick={() => {
              // Targets picked from the page were captured for this flow; the
              // silent ones go back to not existing. Spoken pins refuse the
              // discard on their own.
              for (const pinId of targets) {
                void send("pin/discardProvisional", { pinId }).catch(() => {});
              }
              setSource(null);
              setTargets(new Set());
              setRelationshipIssue(null);
              onChanged();
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
            disabled={targets.size === 0 || relationshipBusy}
            aria-busy={relationshipBusy}
            onClick={() => void confirmRelationship()}
          >
            <CheckIcon size={14} />
            {relationshipBusy ? "Matching…" : "Match"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A group on the shelf: the black plate names the set — the same identity
 * language the on-page floating labels speak — with the members inside as
 * ordinary rows and one composer speaking to all of them. Two verbs live at
 * group level: the header's pin puts the whole conversation back on the
 * page, and the composer continues it. Everything member-specific stays on
 * the member rows, behind the collapse.
 */
function GroupSection({
  groupId,
  members,
  board,
  open,
  onToggleOpen,
  allOnScreen,
  onIssue,
  onChanged,
  renderRow,
}: {
  groupId: string;
  members: Pin[];
  board: Board;
  open: boolean;
  onToggleOpen: () => void;
  allOnScreen: boolean;
  onIssue: (issue: string | null) => void;
  onChanged: () => void;
  renderRow: (pin: Pin) => React.ReactNode;
}) {
  const label = members.map((member) => pinLabel(member, board.pins)).join(" + ");
  // Lowercase like every meta line; the word does the announcing, quietly.
  const sub = `group · ${members.length} components`;

  const stashToGroup = async (text: string) => {
    for (const member of members) {
      const annotation = member.annotation ? `${member.annotation}\n${text}` : text;
      await send("pin/update", { pinId: member.id, patch: { annotation } });
    }
    onChanged();
  };

  return (
    <section className="pin-group" data-open={open}>
      <button
        type="button"
        className="pin-group__head"
        onClick={onToggleOpen}
        aria-expanded={open}
        title={open ? "Collapse the group" : "Show the group's components"}
      >
        <span className="pin-group__titles">
          <span className="pin-group__title" title={label}>
            {label}
          </span>
          <span className="pin-group__sub">{sub}</span>
        </span>
        {/* The group's go-to-pin: the whole set back on the page, combined
            bar and all. Filled while it is up; press again to send it home. */}
        <span
          role="button"
          tabIndex={0}
          className="pin-icon-btn pin-summon"
          style={{ width: 24, height: 24 }}
          data-active={allOnScreen}
          onClick={(event) => {
            event.stopPropagation();
            void (async () => {
              onIssue(null);
              try {
                if (allOnScreen) {
                  await Promise.all(
                    members.map((member) => send("pin/dismiss", { pinId: member.id })),
                  );
                  return;
                }
                const result = await send("group/summon", { groupId });
                if (!result.ok) onIssue("Couldn’t reach this group’s page.");
              } catch {
                onIssue("Couldn’t reach this group’s page.");
              }
            })();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            (event.currentTarget as HTMLElement).click();
          }}
          aria-label={onScreenLabel(allOnScreen, label)}
          aria-pressed={allOnScreen}
          title={
            allOnScreen
              ? "Remove the group from the page"
              : "Reopen the group's combined annotation bar"
          }
        >
          <PinUprightIcon size={15} />
        </span>
        {/* The rows' other trailing verb, groupwide: every member leaves the
            board together. The group was one conversation; it ends as one. */}
        <span
          role="button"
          tabIndex={0}
          className="pin-icon-btn pin-icon-btn--danger"
          style={{ width: 24, height: 24 }}
          onClick={(event) => {
            event.stopPropagation();
            void (async () => {
              for (const member of members) {
                await send("pin/delete", { pinId: member.id }).catch(() => {});
              }
              onChanged();
            })();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            (event.currentTarget as HTMLElement).click();
          }}
          aria-label={`Delete every pin in ${label}`}
          title="Delete the group's pins"
        >
          <TrashIcon size={14} />
        </span>
      </button>

      {open && (
        <div className="pin-group__body">
          {members.map((member) => renderRow(member))}
          <div className="pin-group__composer">
            <div className="pin-note">
              <Composer
                count={members.length}
                agentPinIds={members.map((member) => member.id)}
                onCommit={stashToGroup}
                placeholder={`Describe a change for all ${members.length}…`}
              />
            </div>
          </div>
          {/* The same action the card rows carry, for the whole set: the page,
              with every member selected and the combined bar up. */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className="pin-btn"
              onClick={() => {
                void (async () => {
                  onIssue(null);
                  try {
                    const result = await send("group/summon", { groupId });
                    if (!result.ok) onIssue("Couldn’t reach this group’s page.");
                  } catch {
                    onIssue("Couldn’t reach this group’s page.");
                  }
                })();
              }}
            >
              <ArrowUpRightIcon />
              Go to pin
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function onScreenLabel(onScreen: boolean, label: string): string {
  return onScreen ? `Remove ${label} from the page` : `Reopen ${label} together`;
}

interface PinRowProps {
  pin: Pin;
  board: Board;
  /*
   * Inside a group the row is a member, not a mouthpiece: the annotation box
   * and the go-to/relationship verbs live on the group box, so the expanded
   * row shows only what is member-specific — the metadata.
   */
  inGroup?: boolean;
  expanded: boolean;
  /** Whether this pin is part of the page's focus context right now. */
  onScreen: boolean;
  onExpand: () => void;
  relating: boolean;
  isSource: boolean;
  isTarget: boolean;
  onToggleTarget: () => void;
  onCreateRelationship: () => void;
  onChanged: () => void;
}

function PinRow({
  inGroup = false,
  pin,
  board,
  expanded,
  onScreen,
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
  const [revealIssue, setRevealIssue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(`thumb:${pin.id}`).then((bag) => {
      if (!cancelled) setThumb((bag[`thumb:${pin.id}`] as string | undefined) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [pin.id, pin.updatedAt]);

  useEffect(() => {
    setShot(null);
    if (!expanded) return;
    let cancelled = false;
    void chrome.storage.local.get(`shot:${pin.id}`).then((bag) => {
      if (!cancelled) setShot((bag[`shot:${pin.id}`] as string | undefined) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, pin.id, pin.updatedAt]);

  useEffect(() => setDraft(pin.annotation), [pin.annotation]);
  useEffect(() => setRevealIssue(null), [expanded, pin.id]);

  const title = pinLabel(pin, board.pins);
  const linked = board.relationships.some(
    (r) => r.sourcePinId === pin.id || r.targetPinIds.includes(pin.id),
  );
  const selectable = pin.kind === "element";
  const pickable = relating && !isSource && selectable;
  const detailsId = `pin-details-${pin.id}`;

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
      aria-pressed={pickable ? isTarget : undefined}
      aria-label={pickable ? `Select ${title || "pin"} as relationship target` : undefined}
      data-pickable={pickable}
      data-selected={isSource || isTarget}
    >
      <div className="pin-row">
        <div
          className="pin-row__hit"
          data-done={pin.status === "done"}
          data-clickable={!relating}
          onClick={relating ? undefined : onExpand}
          // The chevron used to be the keyboard stop for expansion; with the
          // trailing slot now summoning, the wide target carries it itself.
          role={relating ? undefined : "button"}
          tabIndex={relating ? undefined : 0}
          aria-expanded={relating ? undefined : expanded}
          aria-controls={relating ? undefined : detailsId}
          onKeyDown={
            relating
              ? undefined
              : (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onExpand();
                }
          }
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
            <span className="pin-row__note">
              {pin.annotation ||
                (pin.liveSends.length > 0
                  ? `${pin.liveSends.length} message${pin.liveSends.length === 1 ? "" : "s"} sent to agent`
                  : "No annotation yet")}
            </span>
          </span>
        </div>

        {/* While relating, the trailing slot says what picking this row would do
            — swapping in a delete button mid-flow would put the one destructive
            control under the cursor that is busy selecting things. */}
        <span className="pin-row__actions">
          {relating ? (
            isSource ? (
              <span className="pin-chip" data-on="true">
                source
              </span>
            ) : !selectable ? (
              <span className="pin-chip" aria-disabled="true">
                no styles
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
            <>
              {/*
                * The pin icon summons: press it and the captured component
                * appears on the page as the focus context. Expansion moved to
                * the row body itself — the wide target — because "open the
                * details" and "put it on screen" are different intents and the
                * chevron was spending the trailing slot on the lesser one.
                */}
              {/* A presence toggle: filled means on the page, and pressing it
                  again takes the capture back off — defocusing it first if it
                  was the live selection. The pin always stays on the shelf. */}
              <button
                className="pin-icon-btn pin-summon"
                style={{ width: 24, height: 24 }}
                data-active={onScreen}
                onClick={() => {
                  void (async () => {
                    setRevealIssue(null);
                    try {
                      const result = onScreen
                        ? await send("pin/dismiss", { pinId: pin.id })
                        : await send("pin/summon", { pinId: pin.id });
                      if (!result.ok) setRevealIssue("Couldn’t reach this pin’s page.");
                    } catch {
                      setRevealIssue("Couldn’t reach this pin’s page.");
                    }
                  })();
                }}
                aria-label={
                  onScreen
                    ? `Remove ${title || "pin"} from the page`
                    : `Show ${title || "pin"} on the page`
                }
                aria-pressed={onScreen}
                title={onScreen ? "Remove from the page" : "Show the pinned capture on the page"}
              >
                <PinUprightIcon size={15} />
              </button>
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
            </>
          )}
        </span>
      </div>

      {expanded && !relating && (
        <div className="pin-expand" id={detailsId}>
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

          {!inGroup && (
          <textarea
            className="pin-field"
            rows={2}
            value={draft}
            placeholder="Add an annotation…"
            aria-label={`Annotation for ${title || "pin"}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== pin.annotation && void update({ annotation: draft })}
          />
          )}

          {/* Two actions, both of which take you somewhere: to the code, or into
              picking what this pin should match. */}
          {!inGroup && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className="pin-btn"
              onClick={() => {
                void (async () => {
                  setRevealIssue(null);
                  try {
                    const result = await send("pin/revealSource", { pinId: pin.id });
                    if (!result.ok) setRevealIssue("Couldn’t open this pin on the page.");
                  } catch {
                    setRevealIssue("Couldn’t open this pin on the page.");
                  }
                })();
              }}
            >
              <ArrowUpRightIcon />
              {pin.kind === "region" ? "Go to marks" : "Go to pin"}
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
          )}
        </div>
      )}

      {/* Below the row, not inside the expansion — the summon button lives on
          the collapsed row, so its failure must be visible there too. */}
      {revealIssue && (
        <div className="pin-banner pin-banner--error" role="alert">
          {revealIssue}
        </div>
      )}
    </div>
  );
}
