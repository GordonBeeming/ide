import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyDocumentTheme } from "./layout";
import "./styles.css";
import { systemPrefersDark } from "./systemTheme";

applyDocumentTheme(systemPrefersDark());

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
