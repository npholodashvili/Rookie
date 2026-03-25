import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Use 127.0.0.1 (not "localhost") — on Windows, ::1 vs 127.0.0.1 can leave Vite proxy failing while the browser UI loads.
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:3001", ws: true, changeOrigin: true },
    },
  },
});
