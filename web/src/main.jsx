import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);

// Offline support once the site is installed (sw.js); dev serves files fresh.
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

// Cards below the fold rise in as they scroll into view. Only cards that start
// off-screen are tagged, so nothing already visible ever blinks out; without
// IntersectionObserver (or with reduced motion) everything just shows.
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const seen = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -40px 0px" });
  const tag = () => {
    for (const el of document.querySelectorAll(".page .card")) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.getBoundingClientRect().top > window.innerHeight) { el.classList.add("reveal"); io.observe(el); }
    }
  };
  new MutationObserver(() => requestAnimationFrame(tag)).observe(document.getElementById("root"), { childList: true, subtree: true });
}
