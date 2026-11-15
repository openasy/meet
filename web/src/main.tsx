import "@openasy/ui/styles.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followLinks } from "@openasy/ui";
import { App } from "./App.tsx";
import { PATHS } from "./links.ts";

followLinks(PATHS);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
