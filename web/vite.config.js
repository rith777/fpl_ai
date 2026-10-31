import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The FPL API sends no CORS headers, so the browser can't call it directly.
// /fpl/* is proxied to it (dev + preview) for loading a manager's real team;
// in production a small function does the same (infra/template.yaml).
const fplProxy = {
  "/fpl": {
    target: "https://fantasy.premierleague.com/api",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/fpl/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: fplProxy },
  preview: { proxy: fplProxy },
});
