import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same shape as the logistics CRM's config. In dev, /api goes to a running app
// (APP_PORT, default 8801) so the shell can be worked on against real data.
export default defineConfig({
  plugins: [react()],
  // Relative asset paths, resolved against the <base href> the server writes into the
  // page — "/" on the app's own port, "/apps/<build>/" inside a hosted builder.
  base: "./",
  server: {
    port: 5180,
    proxy: { "/api": `http://127.0.0.1:${process.env.APP_PORT ?? 8801}` },
  },
  build: {
    target: "es2020",
  },
});
