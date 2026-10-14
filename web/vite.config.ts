import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The studio is served by src/server.ts under /studio/. In development, `npm run dev:web` proxies the
// API to a local server on :8080 (npm run serve).
export default defineConfig({
  root: "web",
  base: "/studio/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://localhost:8080", "/login": "http://localhost:8080", "/ws": { target: "ws://localhost:8080", ws: true } } },
});
