/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two entry points: the dashboard page and the background service worker.
// public/manifest.json is copied into dist/ as-is.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    modulePreload: false,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, "dashboard.html"),
        background: resolve(__dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
