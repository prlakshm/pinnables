import type { ReactNode } from "react";

/** Compact catalogue card — 14px radius, 20px padding. */
export function VarietyCardCompact({ children }: { children: ReactNode }) {
  return (
    <article className="variety" style={{ background: "var(--paper)" }}>
      {children}
    </article>
  );
}
