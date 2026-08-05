import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../ui/ui.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="pin-root" style={{ height: "100%" }}>
      <App />
    </div>
  </StrictMode>,
);
