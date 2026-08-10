import { useEffect, useRef, useState } from "react";
import type { Pin } from "@pinnables/shared";
import { pinLabel } from "@pinnables/shared";
import { send } from "../lib/messages";

/** Resolve an edited label without mistaking an unchanged custom name for reset. */
export function nameForDraft(value: string, pin: Pin, siblings: readonly Pin[]): string | null {
  const next = value.trim();
  if (!next) return null;
  const current = pin.name?.trim() ?? "";
  if (current && next === current) return pin.name;
  const derived = pinLabel({ ...pin, name: null }, siblings);
  return next === derived ? null : next;
}

/**
 * A pin's name, editable in place.
 *
 * The name is a label, not a rename — nothing in the code changes, and the
 * component keeps whatever it is called in the source. What it buys is a way to
 * talk: on a board holding two StatCards, "Revenue card" and "Open issues card"
 * are the words a person would actually use, and the derived "StatCard 1" is
 * only ever a placeholder for them.
 *
 * Both names reach the agent. It needs the code name to find the file and the
 * user's name to understand the instruction that refers to it.
 */
export function RenamableTitle({
  pin,
  siblings,
  onChanged,
  className,
  style,
  readOnly = false,
}: {
  pin: Pin;
  siblings: readonly Pin[];
  onChanged: () => void;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Render the name as plain text, with no rename affordance.
   *
   * While relating, the whole row is one target: "pick this one" is the only
   * thing a click there can mean. A rename trigger sitting on the widest part
   * of the row swallowed that click and started an edit instead — and being a
   * button inside the row's own button, it was invalid nesting besides.
   */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cancelCommit = useRef(false);

  const shown = pinLabel(pin, siblings);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const commit = async (value: string) => {
    setEditing(false);
    // Clearing the field hands the name back to the derived one rather than
    // storing an empty string, so there is always a way back to the default.
    const name = nameForDraft(value, pin, siblings);
    if (name === (pin.name ?? null)) return;
    await send("pin/update", { pinId: pin.id, patch: { name } });
    onChanged();
  };

  if (readOnly) {
    return (
      <span className={className} style={style}>
        {shown}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={input}
        className={`pin-rename ${className ?? ""}`}
        style={style}
        value={draft}
        aria-label={`Rename ${shown}`}
        size={Math.max(draft.length + 1, 3)}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (cancelCommit.current) {
            cancelCommit.current = false;
            return;
          }
          void commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.preventDefault();
            cancelCommit.current = true;
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      className={`pin-rename-trigger ${className ?? ""}`}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        cancelCommit.current = false;
        setDraft(shown);
        setEditing(true);
      }}
      title="Click to rename. This is what you call it, not what the code calls it"
    >
      {shown}
    </button>
  );
}
