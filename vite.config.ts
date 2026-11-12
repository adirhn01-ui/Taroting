import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * pdf.js's runtime data, served at /pdfjs/* in dev and copied to dist/pdfjs/
 * at build (src/pdf/view/pdfjs.ts points getDocument at these paths). Only
 * what the app uses: the no-WASM JPEG 2000 / JBIG2 decoders (the CSP has no
 * 'wasm-unsafe-eval', so no .wasm files ship), standard fonts, CMaps and ICC
 * profiles — about 3 MB. No new dependency: a few lines over node:fs.
 */
function pdfjsAssets(): Plugin {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "node_modules/pdfjs-dist");
  const dirs: Record<string, (name: string) => boolean> = {
    wasm: (n) => n.endsWith("_nowasm_fallback.js"),
    standard_fonts: () => true,
    cmaps: () => true,
    iccs: () => true,
  };
  const files = (): { dir: string; name: string }[] =>
    Object.entries(dirs).flatMap(([dir, keep]) =>
      existsSync(join(root, dir))
        ? readdirSync(join(root, dir))
            .filter((n) => keep(n) && statSync(join(root, dir, n)).isFile())
            .map((name) => ({ dir, name }))
        : [],
    );
  return {
    name: "taroting-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const [dir, name, extra] = decodeURIComponent((req.url ?? "").split("?")[0]!).replace(/^\/+/, "").split("/");
        const keep = dir ? dirs[dir] : undefined;
        if (!keep || !name || extra !== undefined || name.includes("..") || !keep(name)) return next();
        const file = join(root, dir!, name);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const { dir, name } of files()) {
        this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [pdfjsAssets()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    minify: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        // pdf-lib in a chunk of its own, with nothing else in it. Once two
        // lazy paths reached pdf-lib (the PDF export, and the image export's
        // PDF page), the bundler made a shared chunk for it and put its own
        // tiny module-namespace helper in the same file — and every chunk
        // that needs that helper, the start-up ones included, then loaded
        // 420 kB of pdf-lib with it (measured: +9 MB on Home, +16 MB and
        // +16 ms in the viewer). scripts/check-boot.mjs fails the build if a
        // start-up or viewer chunk ever reaches it again.
        codeSplitting: {
          groups: [
            { name: "pdf-lib", test: /node_modules[\\/](pdf-lib|@pdf-lib)[\\/]/, priority: 10 },
            { name: "rt", test: /rolldown[\\/:]runtime/, priority: 20 },
          ],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
