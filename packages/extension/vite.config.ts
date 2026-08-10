import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

/**
 * A unique, build-stable name for a chunk.
 *
 * `[name]` alone collides — several entries are called `index.ts` — so the
 * parent directory is folded in, which is enough to separate them and still
 * reads as something a human can find in dist.
 */
function stableName(name: string, moduleId: string | null): string {
  const clean = name.replace(/\.[jt]sx?$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!moduleId) return clean;
  const parts = moduleId.split("/").filter(Boolean);
  const parent = parts.at(-2);
  return parent && /^(index|main)$/.test(clean) ? `${parent}-${clean}` : clean;
}

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "esnext",
    /*
     * No modulepreload. Vite's preload helper injects
     * `<link rel="modulepreload" href="/assets/mount.js">` into whatever page
     * the content script is running on — the *host page's* head, resolved
     * against the *host page's* origin. Any SPA server that answers unknown
     * paths with index.html then serves HTML where a module was promised,
     * printing MIME errors into the console of the very app the user is
     * reviewing, and a strict CSP can fail the overlay outright. The dynamic
     * import itself resolves against the extension and needs no warm-up.
     */
    modulePreload: false,
    rollupOptions: {
      output: {
        /*
         * Stable filenames, no content hash. This is not about caching.
         *
         * The content script is a tiny loader that dynamically imports the real
         * bundle — that split is what lets "activate in 200ms" and "nothing
         * running until you activate" both be true. But a hashed chunk name
         * changes on every build, and an unpacked extension that is already
         * loaded keeps pointing at the old one. The loader then 404s on import,
         * no listener is ever registered, and capture mode turns on to complete
         * silence with the only evidence in the page console.
         *
         * Which means every rebuild silently broke the running extension until
         * someone thought to reload it. Names derive from the source path
         * instead, so a rebuild replaces files in place and a page reload is
         * enough to pick up new code.
         */
        chunkFileNames: (chunk) => `assets/${stableName(chunk.name, chunk.facadeModuleId)}.js`,
        entryFileNames: (chunk) => `assets/${stableName(chunk.name, chunk.facadeModuleId)}.js`,
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: { port: 5174, strictPort: true, hmr: { port: 5174 } },
});
