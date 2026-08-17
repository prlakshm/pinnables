import type { ReactNode } from "react";

export function VarietyCardFeature({ children }: { children: ReactNode }) {
  return (
    <article
      className="variety variety--feature"
      style={{ background: "var(--paper)" }}
    >
      {children}
    </article>
  );
}
