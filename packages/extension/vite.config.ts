import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "esnext",
    rollupOptions: {
      // The picker bundle is fetched at activation time, not bundled into the
      // always-resident listener. Keeping it a separate chunk is what makes the
      // 200ms budget and the no-background-activity promise both true.
      output: { chunkFileNames: "assets/[name]-[hash].js" },
    },
  },
  server: { port: 5174, strictPort: true, hmr: { port: 5174 } },
});
