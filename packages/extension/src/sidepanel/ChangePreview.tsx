import type { CSSProperties } from "react";
import type { DiffDetail, ValueKind } from "@pinnables/shared";

/**
 * A style difference, drawn rather than spelled.
 *
 * `box-shadow: rgba(0,0,0,0.06) 0px 1px 2px 0px → rgba(0,0,0,0.08) 0px 4px 12px 0px`
 * is a sentence you have to parse character by character to find the two numbers
 * that moved. Every CSS-diff tool that came before this one renders exactly
 * that, because they were built for reading. This is a diff about *appearance*,
 * so the appearance is the row: a radius is a corner, a shadow is a shadow, a
 * colour is the colour.
 *
 * The numbers do not go away — they move to the caption, where they are
 * available to check rather than required to decode.
 */

const SWATCH = 22;

/** The largest specimen we will draw, so a 48px heading cannot blow up the row. */
const TYPE_CEILING = 20;

export function hasPreview(kind: ValueKind): boolean {
  return kind !== "text";
}

const frame: CSSProperties = {
  width: SWATCH,
  height: SWATCH,
  flex: "0 0 auto",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
};

/**
 * Both halves of one row, so the pair can be scaled together — a font size only
 * means something next to the size it is being compared with.
 */
export function ChangePair({ detail }: { detail: DiffDetail }) {
  const scale = detail.property === "font-size" ? typeScale(detail.from, detail.to) : 1;
  return (
    <>
      <span style={frame}>{swatch(detail.kind, detail.property, detail.from, scale)}</span>
      <span className="pin-change__arrow">→</span>
      <span style={frame}>{swatch(detail.kind, detail.property, detail.to, scale)}</span>
    </>
  );
}

/**
 * Keep the ratio, lose the absolute size.
 *
 * 32px → 48px matters because one is half again as large, not because either is
 * a particular number of pixels — and 48px would push the row to twice the
 * height of every other row in the list.
 */
function typeScale(from: string, to: string): number {
  const largest = Math.max(parseFloat(from) || 0, parseFloat(to) || 0);
  return largest > TYPE_CEILING ? TYPE_CEILING / largest : 1;
}

function swatch(kind: ValueKind, property: string, value: string, scale: number) {
  switch (kind) {
    case "color":
      return property === "color" ? (
        <Specimen style={{ color: value, fontSize: 14, fontWeight: 500 }}>Ag</Specimen>
      ) : (
        <span
          style={{
            width: SWATCH - 4,
            height: SWATCH - 4,
            borderRadius: 4,
            background: value,
            border: "1px solid var(--pin-rule)",
          }}
        />
      );

    case "shadow":
      return (
        <span
          style={{
            width: SWATCH - 6,
            height: SWATCH - 6,
            borderRadius: 5,
            background: "var(--pin-paper)",
            border: "1px solid var(--pin-rule)",
            boxShadow: value === "none" ? undefined : value,
          }}
        />
      );

    case "radius":
      return (
        <span
          style={{
            width: SWATCH - 3,
            height: SWATCH - 3,
            border: "1.5px solid var(--pin-ink)",
            // A pill radius would otherwise render as a circle and lose the
            // difference between "quite round" and "fully round".
            borderRadius: `min(${value}, ${(SWATCH - 3) / 2}px)`,
          }}
        />
      );

    case "box":
      return (
        <span
          style={{
            width: SWATCH,
            height: SWATCH,
            boxSizing: "border-box",
            border: "1px dashed var(--pin-rule-strong)",
            padding: value,
            display: "flex",
          }}
        >
          <span style={{ flex: 1, background: "var(--pin-ink)", opacity: 0.7, minWidth: 1 }} />
        </span>
      );

    case "gap":
      return (
        <span style={{ display: "flex", gap: value, height: SWATCH - 6, alignItems: "stretch" }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 3, background: "var(--pin-ink)", opacity: 0.7 }} />
          ))}
        </span>
      );

    case "type":
      return <TypeSpecimen property={property} value={value} scale={scale} />;

    default:
      return null;
  }
}

function TypeSpecimen({
  property,
  value,
  scale,
}: {
  property: string;
  value: string;
  scale: number;
}) {
  if (property === "line-height") {
    // Line height is invisible on one line, so the specimen is two.
    return (
      <Specimen style={{ lineHeight: value, fontSize: 8, textAlign: "center" }}>
        Ag
        <br />
        Ag
      </Specimen>
    );
  }

  const style: CSSProperties = { fontSize: 14, whiteSpace: "nowrap" };
  if (property === "font-size") style.fontSize = (parseFloat(value) || 14) * scale;
  if (property === "font-weight") style.fontWeight = value;
  if (property === "font-family") style.fontFamily = value;
  if (property === "letter-spacing") style.letterSpacing = value;

  return <Specimen style={style}>{property === "letter-spacing" ? "AVA" : "Ag"}</Specimen>;
}

function Specimen({ style, children }: { style: CSSProperties; children: React.ReactNode }) {
  return (
    <span style={{ color: "var(--pin-ink)", lineHeight: 1, ...style }}>{children}</span>
  );
}
