import type { ReactNode } from "react";

export function VarietyCardLegacy({ children }: { children: ReactNode }) {
  return (
    <article className="variety variety--legacy" style={{ background: "var(--paper)" }}>
      {children}
    </article>
  );
}
