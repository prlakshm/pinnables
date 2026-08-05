/**
 * One icon family: 20×20 grid, 1.6 stroke, round caps, outline only. Outline in
 * every state — the active tool is signalled by the tinted circle behind it, so
 * a filled variant would be a third redundant signal and would make the pin read
 * as a different kind of object than its neighbours.
 */
interface IconProps {
  size?: number;
  className?: string;
}

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
    <svg {...svgProps(size)}>
      <path d="M4.5 3.2l11 5.4-4.8 1.4-1.7 4.9z" />
    </svg>
  );
}

export function PinIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M12.1 2.9l5 5-1.9.5-3.1 3.1.4 2.6-5.6-5.6 2.6.4L12.6 5.8z" />
      <path d="M6.9 13.1L3.4 16.6" />
    </svg>
  );
}

export function PencilIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M13.4 3.1l3.5 3.5L7.2 16.3 3 17l.7-4.2z" />
    </svg>
  );
}

export function GripIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <circle cx="7.5" cy="5" r="1.35" />
      <circle cx="12.5" cy="5" r="1.35" />
      <circle cx="7.5" cy="10" r="1.35" />
      <circle cx="12.5" cy="10" r="1.35" />
      <circle cx="7.5" cy="15" r="1.35" />
      <circle cx="12.5" cy="15" r="1.35" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5 5l10 10M15 5L5 15" />
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
