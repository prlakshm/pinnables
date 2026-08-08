import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../ui/ui.css";
import { App } from "./App";
import type { Scheme } from "../ui/theme";

/**
 * The panel picks its scheme from the browser, not from the page.
 *
 * This is the one place the overlay's rule is wrong. Out on a page, the scheme
 * is read from that page's own background — the OS setting says nothing about
 * an app you are annotating, and a dark app on a light OS is exactly where the
 * chrome would break. But the panel is not on anyone's page. It is our own
 * surface sitting in browser furniture, so the browser's preference is the only
 * signal that means anything here.
 */
function Panel() {
  const [scheme, setScheme] = useState<Scheme>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setScheme(event.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // The document background too, or the strip under a short panel stays white.
  useEffect(() => {
    document.documentElement.style.colorScheme = scheme;
    document.body.style.background = scheme === "dark" ? "#1c1f23" : "#f6f5f3";
  }, [scheme]);

  return (
    <div className="pin-root" data-scheme={scheme} style={{ height: "100%" }}>
      <App />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
