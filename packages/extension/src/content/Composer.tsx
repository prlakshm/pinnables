import { useCallback, useEffect, useRef, useState } from "react";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { ArrowUpRightIcon, LinkIcon } from "../ui/icons";

interface ComposerProps {
  /** How many pins this prompt will be written to. Drives the placeholder. */
  count: number;
  onCommit: (text: string) => Promise<void>;
  onRelate?: () => void;
  autoFocus?: boolean;
}

/**
 * One prompt, however many pins — and one line.
 *
 * Shared by the inline case (docked under a single pin) and the floating case
 * (parked beneath a multi-selection), so the two can never drift apart.
 *
 * It stays a single row on purpose. Chips naming the selected pins used to lead
 * the line, but the page already outlines those pins in blue; repeating their
 * names inside the box spent a row saying what the user was looking at. What
 * the pin *is* — its component name, its measurements — belongs in the
 * inspector, where there is room to make it editable.
 */
export function Composer({ count, onCommit, onRelate, autoFocus }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(async () => {
    const next = draft.trim();
    if (!next || saving) return;
    setSaving(true);
    try {
      await onCommit(next);
      setDraft("");
    } finally {
      setSaving(false);
    }
  }, [draft, saving, onCommit]);

  const multi = count > 1;

  return (
    <div className="pin-note__body">
      <textarea
        ref={input}
        className="pin-note__input"
        rows={1}
        value={draft}
        placeholder={multi ? `Describe the change for all ${count}` : "Describe the change"}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Enter alone would insert a newline into a box that is one line by
          // construction, so both forms submit and neither can break the row.
          e.preventDefault();
          if (hasModifier(e.nativeEvent) || !e.shiftKey) void commit();
        }}
      />

      {/* Relating N pins in one gesture rather than dragging N wires: the first
          selected is the reference, the rest are targets. */}
      {multi && onRelate && (
        <button
          className="pin-icon-btn"
          style={{ width: 26, height: 26 }}
          onClick={onRelate}
          title={`Match the other ${count - 1} to the first selected`}
          aria-label="Relate the selected pins"
        >
          <LinkIcon size={14} />
        </button>
      )}

      <span className="pin-kbd">{submitHintLabel}</span>

      <button
        className="pin-note__send"
        onClick={() => void commit()}
        disabled={!draft.trim() || saving}
        title={`Save annotation · ${submitHintLabel}`}
        aria-label="Save annotation"
      >
        <ArrowUpRightIcon size={14} />
      </button>
    </div>
  );
}
