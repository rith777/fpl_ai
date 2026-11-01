import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);

// Offline support once the site is installed (sw.js); dev serves files fresh.
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
