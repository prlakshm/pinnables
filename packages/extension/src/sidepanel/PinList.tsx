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

  const pins = sortedByOrder(board.pins);

  const toggleTarget = (pinId: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(pinId) ? next.delete(pinId) : next.add(pinId);
      return next;
    });

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

      {pins.map((pin) => (
        <PinRow
          key={pin.id}
          pin={pin}
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
      ))}

      {source && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="pin-btn"
            onClick={() => {
              setSource(null);
              setTargets(new Set());
              setRelationshipIssue(null);
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

interface PinRowProps {
  pin: Pin;
  board: Board;
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

          <textarea
            className="pin-field"
            rows={2}
            value={draft}
            placeholder="Add an annotation…"
            aria-label={`Annotation for ${title || "pin"}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== pin.annotation && void update({ annotation: draft })}
          />

          {/* Two actions, both of which take you somewhere: to the code, or into
              picking what this pin should match. */}
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
