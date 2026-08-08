import { useEffect, useRef, useState } from "react";
import type { Pin } from "@pinnables/shared";
import { pinLabel } from "@pinnables/shared";
import { send } from "../lib/messages";

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
}: {
  pin: Pin;
  siblings: readonly Pin[];
  onChanged: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const shown = pinLabel(pin, siblings);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const commit = async (value: string) => {
    setEditing(false);
    const next = value.trim();
    // Clearing the field hands the name back to the derived one rather than
    // storing an empty string, so there is always a way back to the default.
    const name = next.length > 0 && next !== shown ? next : null;
    if (name === (pin.name ?? null)) return;
    await send("pin/update", { pinId: pin.id, patch: { name } });
    onChanged();
  };

  if (editing) {
    return (
      <input
        ref={input}
        className={`pin-rename ${className ?? ""}`}
        style={style}
        value={draft}
        size={Math.max(draft.length + 1, 3)}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
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
        setDraft(shown);
        setEditing(true);
      }}
      title="Click to rename — this is what you call it, not what the code calls it"
    >
      {shown}
    </button>
  );
}
