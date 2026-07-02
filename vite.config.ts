import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
