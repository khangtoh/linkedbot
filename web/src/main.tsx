import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

// The accent is a per-device choice (Settings); terracotta until one is picked.
try {
  const accent = localStorage.getItem("accent");
  if (accent) document.documentElement.dataset.accent = accent;
} catch {
  /* storage unavailable: keep the default */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
