import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The FPL API sends no CORS headers, so the browser can't call it directly.
// /fpl/* is proxied to it (dev + preview) for loading a manager's real team.
const fplProxy = {
  "/fpl": {
    target: "https://fantasy.premierleague.com/api",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/fpl/, ""),
  },
};

// Transfers already made on the FPL site stay private until the deadline, so
// the app records them in public/pending_transfers.json (keyed by team ID).
// POST /api/pending {teamId, entry} saves that team's entry; entry=null clears it.
const PENDING = fileURLToPath(new URL("./public/pending_transfers.json", import.meta.url));

function pendingHandler(req, res) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const { teamId, entry } = JSON.parse(body);
      const all = fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, "utf8")) : {};
      if (entry) all[teamId] = entry; else delete all[teamId];
      fs.writeFileSync(PENDING, JSON.stringify(all, null, 2) + "\n");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(all[teamId] ?? null));
    } catch (e) {
      res.statusCode = 400;
      res.end(String(e));
    }
  });
}

const pendingApi = {
  name: "pending-transfers",
  configureServer: (server) => { server.middlewares.use("/api/pending", pendingHandler); },
  configurePreviewServer: (server) => { server.middlewares.use("/api/pending", pendingHandler); },
};

export default defineConfig({
  plugins: [react(), pendingApi],
  server: { port: 5180, proxy: fplProxy },
  preview: { proxy: fplProxy },
});
