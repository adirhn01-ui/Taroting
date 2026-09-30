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
      if (file === DISPATCH) continue;
      expect(read(file), file).not.toMatch(ANY_IMAGE_IMPORT);
    }
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
  it("no boot module statically imports image-project or export-hold", () => {
    for (const f of BOOT_PATH) {
      const src = read(f);
      expect(src, f).not.toMatch(staticImportOf("image-project"));
      expect(src, f).not.toMatch(staticImportOf("export-hold"));
    }
  });

  it("open-media reaches image-project only through the awaited dynamic import", () => {
    expect(read("src/core/open-media.ts")).toContain('await import("./image-project")');
  });
});
