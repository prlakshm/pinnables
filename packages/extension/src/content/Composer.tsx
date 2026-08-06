import { useCallback, useEffect, useRef, useState } from "react";
import { hasModifier, submitHintLabel } from "../lib/platform";
import { ArrowUpRightIcon, LinkIcon } from "../ui/icons";
import type { HueTokens } from "../ui/theme";

/** One entry per selected pin, for the chip row. */
export interface SelectionChip {
  id: string;
  label: string;
  hue: HueTokens;
}

interface ComposerProps {
  chips: SelectionChip[];
  meta: string;
  onCommit: (text: string) => Promise<void>;
  onRelate?: () => void;
  autoFocus?: boolean;
}

/**
 * One prompt, however many pins.
 *
 * Shared by the inline case (docked under a single pin) and the floating case
 * (parked beneath a multi-selection), so the two can never drift apart. Chips
 * lead the line and the prompt continues after them, each chip wearing its own
 * pin's hue — the trick that makes a chip traceable to its outline without
 * reading the label.
 */
export function Composer({ chips, meta, onCommit, onRelate, autoFocus }: ComposerProps) {
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

  const multi = chips.length > 1;

  return (
    <div className="pin-note__body">
      <div className="pin-note__chips">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className="pin-note__chip"
            style={
              {
                "--pin-hue-text": chip.hue.text,
                "--pin-hue-soft": chip.hue.soft,
              } as React.CSSProperties
            }
          >
            {chip.label}
          </span>
        ))}
        <textarea
          ref={input}
          className="pin-note__input"
          rows={1}
          value={draft}
          placeholder={multi ? `Describe the change for all ${chips.length}` : "Describe the change"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hasModifier(e.nativeEvent)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
      </div>

      <div className="pin-note__foot">
        <span className="pin-note__meta">{meta}</span>
        {/* Relating N pins in one gesture rather than dragging N wires: the
            first selected is the reference, the rest are targets. */}
        {multi && onRelate && (
          <button className="pin-btn" style={{ height: 26 }} onClick={onRelate}>
            <LinkIcon size={13} />
            Relate
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
    </div>
  );
}
