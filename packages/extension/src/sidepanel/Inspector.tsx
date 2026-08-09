import { useEffect, useState } from "react";
import { STYLE_INITIAL_VALUES, type Pin } from "@pinnables/shared";
import { CloseIcon } from "../ui/icons";

/**
 * The element panel, borrowed wholesale from Chrome DevTools.
 *
 * Borrowed because every developer who will open this already knows that
 * diagram — margin outside, border, padding inside, content in the middle, four
 * numbers on four edges — and inventing a second vocabulary for the same
 * measurements would be a cost with no payoff.
 *
 * What differs is what a typed value *means*. In DevTools an edit mutates the
 * live page and dies on refresh; the developer then has to remember the number
 * and go find the source. Here the typed value is recorded next to the captured
 * one and handed to the agent as a before → after pair. Nothing is mutated,
 * which is why the edit survives the tab closing: it was never an edit to the
 * page, it was a specification of what the page should be.
 */

/** Rows under the diagram, in the order DevTools lists them. */
const METRICS: Array<{ property: string; label?: string }> = [
  { property: "display" },
  { property: "position" },
  { property: "width" },
  { property: "height" },
  { property: "gap" },
  { property: "flex-direction", label: "flex-dir" },
  { property: "justify-content", label: "justify" },
  { property: "align-items", label: "align" },
  { property: "font-size" },
  { property: "font-weight", label: "font-wt" },
  { property: "line-height", label: "line-ht" },
  { property: "letter-spacing", label: "tracking" },
  { property: "color" },
  { property: "background-color", label: "background" },
  { property: "border-radius", label: "radius" },
  { property: "box-shadow", label: "shadow" },
];

/** What the element actually measured, with the captured defaults filled back in. */
function captured(pin: Pin, property: string): string {
  const value = pin.computedStyles[property];
  if (value !== undefined) return value;
  return STYLE_INITIAL_VALUES[property] ?? "";
}

/** What should be shown: the requested value if there is one, else the measured one. */
function current(pin: Pin, property: string): string {
  return pin.styleEdits[property] ?? captured(pin, property);
}

/** `16px` → `16`. The diagram has no room for units and DevTools drops them too. */
function bare(value: string): string {
  const match = /^(-?[\d.]+)px$/.exec(value.trim());
  return match ? match[1] : value.trim() || "0";
}

interface InspectorProps {
  pin: Pin;
  onEdit: (styleEdits: Record<string, string>) => void;
}

export function Inspector({ pin, onEdit }: InspectorProps) {
  /**
   * A value is committed on blur or Enter, never per keystroke — every commit
   * is a write to storage and a re-render of the whole board, and typing "24px"
   * would fire four of them, two of which ("2", "24p") are not valid CSS.
   */
  const commit = (property: string, raw: string, unitless = false) => {
    const next = { ...pin.styleEdits };
    const typed = raw.trim();
    const withUnit = unitless && /^-?[\d.]+$/.test(typed) ? `${typed}px` : typed;

    // Typing the measured value back in is a revert, not an edit — otherwise
    // the agent gets handed "padding-top: 16px → 16px" as a requested change.
    if (!withUnit || withUnit === captured(pin, property)) delete next[property];
    else next[property] = withUnit;

    if (JSON.stringify(next) === JSON.stringify(pin.styleEdits)) return;
    onEdit(next);
  };

  /**
   * What the pin *is* leads, then what it measures, then the diagram.
   *
   * The identity rows are the same grid as the metrics rather than a separate
   * treatment, because "component: StatCard" and "width: 640px" are both a
   * labelled fact about this element — the only difference is that one of them
   * can be argued with. Without the label the component name was a bare title
   * with nothing saying what it named.
   */
  const facts: Array<[string, string]> = [
    ["component", pin.componentName ?? "unresolved"],
    // Status lives here rather than as a dot on the shelf row. The row shows
    // "done" by striking its title through, which leaves "blocked" with no
    // indicator at all — a word in the fact list says it without spending a
    // colour, and this is where the rest of the pin's facts already are.
    ["status", pin.status],
    ["route", pin.route],
    ["viewport", `${pin.viewport.width}×${pin.viewport.height}`],
    // No selector row: a CSS path is the one fact here nobody reads and nobody
    // can act on — it is how the pin finds its element again, not something the
    // reviewer is deciding about. "Go to source" answers the question it was
    // standing in for.
    ["source", pin.sourceFile ?? "unresolved"],
  ];

  return (
    <div className="pin-inspector">
      <div className="pin-metrics">
        {facts.map(([name, value]) => (
          <div className="pin-metric pin-metric--fact" key={name}>
            <span className="pin-metric__name">{name}</span>
            <span className="pin-metric__value">{value}</span>
            <span />
          </div>
        ))}

        {METRICS.map(({ property, label }) => (
          <MetricRow
            key={property}
            name={label ?? property}
            value={current(pin, property)}
            was={pin.styleEdits[property] !== undefined ? captured(pin, property) : null}
            onCommit={(raw) => commit(property, raw)}
            onRevert={() => commit(property, "")}
          />
        ))}
      </div>

      <BoxModel pin={pin} onCommit={commit} />
    </div>
  );
}

/**
 * Four nested rings, told apart by line style rather than fill: dashed for the
 * space the element reserves but does not occupy, solid for the element itself.
 * See the note in ui.css for why the DevTools tints did not come with it.
 */
function BoxModel({
  pin,
  onCommit,
}: {
  pin: Pin;
  onCommit: (property: string, raw: string, unitless?: boolean) => void;
}) {
  const edge = (ring: "margin" | "padding", side: "top" | "right" | "bottom" | "left") => {
    const property = `${ring}-${side}`;
    return (
      <EdgeInput
        key={property}
        side={side}
        value={bare(current(pin, property))}
        edited={pin.styleEdits[property] !== undefined}
        title={`${property} · ${current(pin, property) || "0px"}`}
        onCommit={(raw) => onCommit(property, raw, true)}
      />
    );
  };

  const width = current(pin, "width") || "auto";
  const height = current(pin, "height") || "auto";

  return (
    <div className="pin-boxmodel">
      <div className="pin-boxmodel__ring" data-ring="margin">
        <span className="pin-boxmodel__tag">margin</span>
        {(["top", "right", "bottom", "left"] as const).map((side) => edge("margin", side))}

        <div className="pin-boxmodel__ring" data-ring="border">
          <span className="pin-boxmodel__tag">border</span>

          <div className="pin-boxmodel__ring" data-ring="padding">
            <span className="pin-boxmodel__tag">padding</span>
            {(["top", "right", "bottom", "left"] as const).map((side) => edge("padding", side))}

            {/* The content box carries the dimensions — where DevTools puts
                them, and the only place in the diagram they mean anything. */}
            <div className="pin-boxmodel__ring" data-ring="content">
              <span className="pin-boxmodel__size">
                {bare(width)} × {bare(height)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EdgeInput({
  side,
  value,
  edited,
  title,
  onCommit,
}: {
  side: string;
  value: string;
  edited: boolean;
  title: string;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      className="pin-boxmodel__edge"
      data-side={side}
      data-edited={edited}
      title={title}
      aria-label={title.split(" · ")[0]}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

function MetricRow({
  name,
  value,
  was,
  onCommit,
  onRevert,
}: {
  name: string;
  value: string;
  was: string | null;
  onCommit: (raw: string) => void;
  onRevert: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="pin-metric">
      <span className="pin-metric__name" title={name}>
        {name}
      </span>
      <input
        className="pin-metric__value"
        data-edited={was !== null}
        aria-label={name}
        value={draft}
        placeholder="—"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(value);
        }}
      />
      {was !== null ? (
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          <span className="pin-metric__was" title="Captured value">
            {was || "unset"}
          </span>
          <button
            className="pin-metric__revert"
            onClick={onRevert}
            title="Revert to captured value"
            aria-label={`Revert ${name} to its captured value`}
          >
            <CloseIcon size={11} />
          </button>
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}
