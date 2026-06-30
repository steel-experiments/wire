// ABOUTME: Vite build config for the Wire Console SPA.
// ABOUTME: Wires React + Tailwind v4 and proxies /api to the Hono server in dev.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5177),
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
});
