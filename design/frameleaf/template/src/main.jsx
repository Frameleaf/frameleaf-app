import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "./styles.css";
import "./apple-style.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
