import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../ui/ui.css";
import { App } from "./App";
import { detectScheme, watchScheme, type Scheme } from "../ui/theme";

/**
 * Same signal as the toolbar out on the page — `detectScheme` reads the
 * browser's preference for both, so the two halves of the product can never
 * disagree about what colour they are.
 */
function Panel() {
  const [scheme, setScheme] = useState<Scheme>(detectScheme);

  useEffect(() => watchScheme(setScheme), []);

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
