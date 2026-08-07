/**
 * One icon family, traced rather than drawn.
 *
 * The four toolbar glyphs come straight out of the nav reference in Paper:
 * cropped, thresholded, and run through potrace, then fitted to a shared 20×20
 * grid on their long axis. Hand-drawing them kept producing icons that were
 * *like* the reference — a triangle where the cursor has a tail, a pencil with
 * no ferrule — and "like" was the whole problem.
 *
 * The consequence is that these are filled outlines, not strokes. `currentColor`
 * still recolours them and the viewBox still scales them; what is lost is
 * stroke weight tracking size, which does not matter because they render at one
 * size. `fill-rule="evenodd"` is load-bearing — each glyph is an outer contour
 * and an inner one, and without it every icon fills in solid.
 *
 * Icons written by hand (link, check, chevron, arrow, trash) stay strokes on the
 * same grid; they never appear beside a traced glyph.
 */
interface IconProps {
  size?: number;
  className?: string;
}

/** Traced glyphs: filled outline, evenodd, no stroke. */
function traced(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "currentColor",
    fillRule: "evenodd" as const,
    "aria-hidden": true,
  };
}

/** Hand-drawn glyphs: 1.6 stroke, round caps, no fill. */
function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function CursorIcon({ size = 18 }: IconProps) {
  return (
    <svg {...traced(size)}>
      <path
        d="M 3.89 3.62 C 3.77 3.73, 3.67 3.92, 3.67 4.02 C 3.66 4.5, 6.64 14.14, 6.89 14.44 C 7.72 15.41,
          8.87 15.09, 9.69 13.68 L 10.22 12.76 11.96 14.46 C 14.03 16.5, 14.38 16.6, 15.59 15.47 C 16.23
          14.87, 16.34 14.66, 16.34 14.06 C 16.34 13.42, 16.19 13.19, 14.77 11.66 L 13.2 9.97 13.7 9.61 C
          14.96 8.69, 15.25 8.32, 15.25 7.65 C 15.25 7.23, 15.12 6.86, 14.9 6.64 C 14.58 6.32, 5.13 3.4,
          4.4 3.4 C 4.24 3.4, 4.01 3.5, 3.89 3.62 M 5.54 5.51 C 5.78 6.26, 7.26 11.32, 7.54 12.35 C 7.72
          12.97, 7.92 13.47, 8 13.47 C 8.08 13.47, 8.52 12.91, 8.96 12.21 C 9.53 11.34, 9.89 10.95, 10.14
          10.95 C 10.37 10.95, 11.22 11.69, 12.38 12.89 L 14.26 14.82 14.66 14.43 L 15.05 14.04 13.47
          12.33 C 12.6 11.38, 11.79 10.57, 11.67 10.53 C 11.55 10.48, 11.41 10.27, 11.35 10.06 C 11.24
          9.6, 11.46 9.36, 12.92 8.37 C 13.49 7.99, 13.92 7.65, 13.88 7.62 C 13.75 7.48, 5.98 5.2, 5.66
          5.2 C 5.54 5.2, 5.49 5.34, 5.54 5.51"
      />
    </svg>
  );
}

export function PinIcon({ size = 18 }: IconProps) {
  return (
    <svg {...traced(size)}>
      <path
        d="M 11.74 3.41 C 11.53 3.49, 11.14 3.92, 10.88 4.37 C 10.13 5.65, 8.93 6.69, 7.81 7.02 C 6.62
          7.37, 5.97 7.7, 5.12 8.37 C 4.59 8.79, 4.46 9.01, 4.46 9.48 C 4.46 9.95, 4.59 10.17, 5.16 10.62
          C 5.54 10.93, 6.03 11.42, 6.24 11.71 L 6.62 12.24 5.01 13.86 C 3.41 15.47, 3.2 15.82, 3.61 16.23
          C 4.07 16.7, 4.57 16.42, 6.13 14.86 C 7.92 13.05, 7.77 13.06, 9.07 14.81 C 9.91 15.94, 10.34 16,
          11.3 15.13 C 12 14.49, 12.42 13.72, 12.74 12.44 C 13.02 11.33, 14.64 9.43, 15.83 8.82 C 16.58
          8.44, 16.79 8.22, 16.8 7.82 C 16.8 7.51, 12.82 3.45, 12.41 3.35 C 12.25 3.3, 11.94 3.33, 11.74
          3.41 M 11.64 5.86 C 10.88 6.92, 9.41 8.09, 8.51 8.33 C 8.08 8.45, 7.34 8.74, 6.88 8.97 L 6.03
          9.4 8.19 11.68 C 10.2 13.82, 10.37 13.95, 10.66 13.68 C 10.83 13.53, 11.1 12.96, 11.25 12.41 C
          11.65 11.01, 12.22 10.12, 13.56 8.76 L 14.72 7.58 13.51 6.37 C 12.85 5.7, 12.27 5.16, 12.22 5.16
          C 12.17 5.16, 11.91 5.48, 11.64 5.86"
      />
    </svg>
  );
}

export function PencilIcon({ size = 18 }: IconProps) {
  return (
    <svg {...traced(size)}>
      <path
        d="M 12.36 3.72 C 11.93 3.93, 10.03 5.77, 7.64 8.28 L 3.65 12.49 3.52 14.29 C 3.36 16.62, 3.42
          16.7, 5.64 16.7 C 6.54 16.7, 7.4 16.65, 7.56 16.59 C 7.92 16.45, 15.73 8.22, 16.06 7.63 C 16.64
          6.58, 16.17 4.68, 15.12 3.92 C 14.39 3.38, 13.23 3.3, 12.36 3.72 M 12.72 5.19 C 12.42 5.42,
          12.48 5.53, 13.36 6.4 C 14.19 7.22, 14.38 7.32, 14.64 7.11 C 15.07 6.76, 15.02 5.81, 14.55 5.34
          C 14.11 4.9, 13.23 4.83, 12.72 5.19 M 8.28 9.73 C 6.62 11.5, 5.19 13.15, 5.12 13.4 C 5.05 13.65,
          4.98 14.15, 4.97 14.5 L 4.95 15.13 6 15.13 L 7.05 15.13 10.12 11.92 C 11.8 10.15, 13.18 8.63,
          13.18 8.53 C 13.18 8.44, 12.76 7.95, 12.25 7.44 L 11.32 6.52 8.28 9.73"
      />
    </svg>
  );
}

export function GripIcon({ size = 18 }: IconProps) {
  return (
    <svg {...traced(size)}>
      <path
        d="M 6.43 3.71 C 5.94 4.26, 5.98 5.21, 6.52 5.65 C 7.12 6.13, 7.79 6.08, 8.37 5.51 C 8.77 5.11,
          8.84 4.9, 8.74 4.41 C 8.67 4.08, 8.48 3.7, 8.3 3.57 C 7.81 3.2, 6.83 3.28, 6.43 3.71 M 10.91
          3.71 C 10.41 4.22, 10.42 5.12, 10.95 5.61 C 11.82 6.42, 13.2 5.84, 13.2 4.66 C 13.2 3.93, 12.6
          3.33, 11.87 3.33 C 11.55 3.33, 11.12 3.5, 10.91 3.71 M 6.57 8.58 C 6.26 8.8, 6.15 9.07, 6.15
          9.62 C 6.15 10.89, 7.44 11.4, 8.35 10.48 C 8.92 9.91, 8.94 9.44, 8.42 8.78 C 7.97 8.21, 7.22
          8.12, 6.57 8.58 M 10.95 8.72 C 10.12 9.6, 10.68 10.95, 11.87 10.95 C 12.18 10.95, 12.61 10.78,
          12.82 10.57 C 13.03 10.36, 13.2 9.93, 13.2 9.62 C 13.2 8.41, 11.77 7.85, 10.95 8.72 M 6.78 13.46
          C 6.28 13.71, 5.98 14.49, 6.14 15.14 C 6.26 15.63, 6.94 16.09, 7.54 16.09 C 8.03 16.1, 8.82
          15.24, 8.82 14.7 C 8.82 13.72, 7.66 13.02, 6.78 13.46 M 11.38 13.42 C 10.38 13.82, 10.25 15.11,
          11.13 15.77 C 12.52 16.8, 14.06 14.7, 12.7 13.63 C 12.15 13.21, 11.98 13.18, 11.38 13.42"
      />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...traced(size)}>
      <path
        d="M 5.23 5.06 C 4.87 5.42, 5.27 6.04, 7.07 7.87 L 9.04 9.88 7.05 11.87 C 5.48 13.45, 5.08 13.96,
          5.14 14.33 C 5.27 15.3, 5.87 15, 7.96 12.91 L 9.99 10.9 12.02 12.92 C 13.46 14.36, 14.15 14.91,
          14.37 14.83 C 15.13 14.54, 14.94 14.08, 13.38 12.48 C 12.53 11.61, 11.63 10.65, 11.37 10.36 L
          10.91 9.82 12.84 7.86 C 13.91 6.78, 14.78 5.75, 14.78 5.58 C 14.78 5.4, 14.63 5.17, 14.44 5.05 C
          14.15 4.87, 13.79 5.14, 12.09 6.83 C 10.99 7.94, 10.03 8.84, 9.97 8.84 C 9.9 8.84, 8.98 7.96,
          7.93 6.88 C 6.17 5.09, 5.59 4.7, 5.23 5.06"
      />
    </svg>
  );
}

export function LinkIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8.4 11.6a3 3 0 004.2 0l2.8-2.8a3 3 0 10-4.2-4.2l-1 1" />
      <path d="M11.6 8.4a3 3 0 00-4.2 0l-2.8 2.8a3 3 0 104.2 4.2l1-1" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function ChevronIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M7.5 4.5l5 5.5-5 5.5" />
    </svg>
  );
}

export function ArrowUpRightIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 14L14 6M7 6h7v7" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 5.5h12M8 5.5V4a1 1 0 011-1h2a1 1 0 011 1v1.5" />
      <path d="M5.5 5.5l.7 10a1 1 0 001 .9h5.6a1 1 0 001-.9l.7-10" />
    </svg>
  );
}

/** The mark. Flat dot — the tittle from the wordmark, seen head-on. */
export function BrandDot({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden>
      <circle cx="5" cy="5" r="5" fill="var(--pin-red)" />
    </svg>
  );
}
