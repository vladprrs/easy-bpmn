import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API prefixes that, in production, are served by the SAME Worker (same-origin).
// In dev, proxy them to `wrangler dev` (http://localhost:8787) so the SPA talks to
// the real API. The SPA's own client routes live under `/` and `/console/*` and are
// NOT proxied — Vite serves index.html for them (SPA fallback).
const API_PREFIXES = [
  "/ui",
  "/projects",
  "/attention",
  "/sagas",
  "/instances",
  "/messages",
  "/definitions",
  "/jobs",
  "/worker-credentials",
];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: "http://localhost:8787", changeOrigin: true }]),
    ),
  },
});
