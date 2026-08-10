import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../ui/ui.css";
import { App } from "./App";
import { detectScheme, watchScheme, type Scheme } from "../ui/theme";

/** Same browser/OS signal as the page toolbar, so both surfaces stay in sync. */
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
