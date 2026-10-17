// Guard: the image editor (src/image/**) is its own lazy chunk that nothing
// prefetches, so a user who never opens an image project never loads it. Every
// other module reaches it ONLY through `mountEditor`'s dynamic import — one
// static import from Home, the boot module or any shared helper would pull the
// whole image editor into startup (or into the prefetched editor chunk)
// without any test going red. The E2E checks the loaded chunks; this catches
// the import before a build is needed, and it sweeps the whole tree rather
// than a list of files someone has to remember to extend.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

/** Any specifier into src/image ("./image/…" from src, "../image/…" from a
 *  sibling folder), static or dynamic. "../core/image-project" is not one. */
const ANY_IMAGE_IMPORT = /["'](?:\.\.?\/)+image\//;
/** A static `import … from "…/image/…"` (a type-only `typeof import()` is not one). */
const STATIC_IMAGE_IMPORT = /^\s*import\b[^;]*?from\s+["'](?:\.\.?\/)+image\//m;
/** The one door in. */
const DISPATCH = "src/editor/editor.ts";
/** The PDF editor's chunk (src/pdf/**) draws ink with the image editor's own
 *  primitives, so a mark looks the same in both editors and in the PDF export.
 *  It may import THESE leaf modules and nothing else under src/image — none of
 *  them reaches the editor (checked below), so Vite puts them in a small
 *  shared chunk and opening a PDF never loads the image editor. */
const SHARED_WITH_PDF: ReadonlySet<string> = new Set([
  "src/image/strokes.ts",
  "src/image/icons.ts",
  "src/image/ink/outline.ts",
  "src/image/ink/input.ts",
  "src/image/ink/paint.ts",
  "src/image/ink/shapes.ts",
  "src/image/ink/grain.ts",
  "src/image/ink/eraser.ts",
]);
/** Every VALUE import specifier in `src` (type-only imports are erased). */
function valueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}
/** "src/…/x.ts" for a relative specifier from `file`, else null. */
function resolveRel(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const p = parts.join("/");
  return p.endsWith(".ts") || p.endsWith(".css") || p.endsWith(".json") ? p : `${p}.ts`;
}

/** Every app source file outside the image chunk itself, as "src/…" paths.
 *  Tests and the dev harness are not shipped code, so they are left out. */
function appSources(): string[] {
  return readdirSync(resolve(root, "src"), { recursive: true })
    .map((p) => `src/${p.replace(/\\/g, "/")}`)
    .filter(
      (p) =>
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".d.ts") &&
        !p.startsWith("src/image/") &&
        !p.startsWith("src/dev/"),
    );
}

describe("the image chunk boundary", () => {
  it("finds the files it is guarding", () => {
    const files = appSources();
    // A sweep that silently matched nothing would pass everything below.
    for (const must of ["src/main.ts", "src/home/home.ts", "src/core/open-media.ts", "src/core/image-project.ts", DISPATCH]) {
      expect(files, must).toContain(must);
    }
  });

  it("no app module imports the image editor, except the dispatch", () => {
    for (const file of appSources()) {
      if (file === DISPATCH || file.startsWith("src/pdf/")) continue;
      expect(read(file), file).not.toMatch(ANY_IMAGE_IMPORT);
    }
  });

  it("the PDF chunk imports only the shared ink primitives from src/image", () => {
    const pdfFiles = appSources().filter((f) => f.startsWith("src/pdf/"));
    for (const file of pdfFiles) {
      for (const spec of valueImports(read(file))) {
        const target = resolveRel(file, spec);
        if (target === null || !target.startsWith("src/image/")) continue;
        expect(SHARED_WITH_PDF.has(target), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("the shared ink primitives never reach the rest of the image editor", () => {
    for (const file of SHARED_WITH_PDF) {
      for (const spec of valueImports(read(file))) {
        const target = resolveRel(file, spec);
        if (target === null || !target.startsWith("src/image/")) continue;
        expect(SHARED_WITH_PDF.has(target) || target.endsWith(".css"), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("the import checker sees value imports and skips type-only ones", () => {
    const src = 'import type { A } from "../image/context";\nimport { b } from "../image/layers";\nconst c = await import("../image/image-editor");';
    expect(valueImports(src)).toEqual(["../image/layers", "../image/image-editor"]);
    expect(resolveRel("src/pdf/editor/x.ts", "../../image/ink/paint")).toBe("src/image/ink/paint.ts");
  });

  it("the dispatch reaches it only through the dynamic import", () => {
    const editor = read(DISPATCH);
    expect(editor).not.toMatch(STATIC_IMAGE_IMPORT);
    expect(editor).toContain('await import("../image/image-editor")');
  });
});

/** The modules the boot screen (Home) and the always-loaded shell pull in. */
const BOOT_PATH = [
  "src/main.ts",
  "src/home/home.ts",
  "src/core/open-media.ts",
  "src/core/app-close.ts",
  "src/core/session.ts",
  "src/core/ipc.ts",
  "src/core/types.ts",
  "src/core/diagnostics.ts",
];
/** A static import of a module that only a lazy screen needs. */
const staticImportOf = (mod: string): RegExp =>
  // String.raw: in a plain template literal "\s" collapses to "s" and the
  // pattern silently matches nothing.
  new RegExp(String.raw`^\s*import\b[^;]*?from\s+["'](?:\.\.?\/)+(?:core\/)?${mod}["']`, "m");

describe("off the boot path", () => {
  // Startup parses only what Home needs. Photo/blank image-project creation
  // and the export run hold are used by lazy screens alone (open-media awaits
  // the former; both export dialogs import the latter), and one static import
  // from a boot module would put them back on every launch unnoticed.
  it("no boot module statically imports image-project, pdf-project, export-hold or the PDF chunk", () => {
    for (const f of BOOT_PATH) {
      const src = read(f);
      expect(src, f).not.toMatch(staticImportOf("image-project"));
      expect(src, f).not.toMatch(staticImportOf("pdf-project"));
      expect(src, f).not.toMatch(staticImportOf("export-hold"));
      expect(src, f).not.toMatch(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](?:\.\.?\/)+pdf\//m);
    }
  });

  it("open-media reaches image-project only through the awaited dynamic import", () => {
    expect(read("src/core/open-media.ts")).toContain('await import("./image-project")');
  });
});
