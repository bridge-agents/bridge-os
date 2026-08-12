import bridgeIcon from "@bridge/ui/assets/bridge-icon.png";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const favicon = document.createElement("link");
favicon.rel = "icon";
favicon.type = "image/png";
favicon.href = bridgeIcon;
document.head.appendChild(favicon);

// biome-ignore lint/style/noNonNullAssertion: #root exists in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
