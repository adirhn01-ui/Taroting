// Guard: the font runtime (src/fonts/**) never enters the boot chunk. A user
// who never touches a font from the library pays nothing at startup; the
// runtime rides in the lazy chunks of the editors, the PDF editor and
// Settings, which reach it by static import from their own lazy modules or by
// dynamic import. One static import from a module the boot entry reaches,
// directly or through any chain of static imports, would put it back on
// every launch without a test going red. This walks the real static import
// graph from the entry, so a chain through a shared helper is caught too.
// (Modelled on image-chunk-boundary.test.ts.)

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(root, rel));

const ENTRY = "src/main.ts";

/** Every STATIC value import specifier in `src`: `import … from "…"`,
 *  `import "…"` and `export … from "…"`. Type-only imports and exports are
 *  erased, and `import("…")` is a separate chunk, so neither counts. */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;"']*?from\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/^\s*export\s+(?!type\b)[^;"']*?from\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  return out;
}

/** "src/…/x.ts" for a relative specifier from `file`, or null for a package
 *  or a non-TS asset. A folder specifier ("../../fonts") is its index.ts. */
function resolveRel(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const p = parts.join("/");
  if (/\.(css|json|svg|png)$/.test(p)) return null;
  if (p.endsWith(".ts")) return p;
  if (exists(`${p}.ts`)) return `${p}.ts`;
  if (exists(`${p}/index.ts`)) return `${p}/index.ts`;
  return `${p}.ts`;
}

/** Every module the entry reaches by static imports, with the chain that
 *  reaches it (for a readable failure). */
function bootGraph(): Map<string, string[]> {
  const seen = new Map<string, string[]>([[ENTRY, [ENTRY]]]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!exists(file)) continue;
    for (const spec of staticImports(read(file))) {
      const target = resolveRel(file, spec);
      if (target === null || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, target]);
      queue.push(target);
    }
  }
  return seen;
}

describe("the font runtime chunk boundary", () => {
  it("the walk sees a real boot graph (guards against a vacuous pass)", () => {
    const graph = bootGraph();
    for (const must of ["src/main.ts", "src/home/home.ts", "src/core/ipc.ts", "src/core/session.ts"]) {
      expect(graph.has(must), must).toBe(true);
    }
    expect(graph.size).toBeGreaterThan(20);
  });

  it("no module on the boot path statically imports src/fonts", () => {
    const offenders = [...bootGraph().entries()]
      .filter(([file]) => file.startsWith("src/fonts/"))
      .map(([, chain]) => chain.join(" -> "));
    expect(offenders).toEqual([]);
  });

  it("the walk follows folder imports, side-effect imports and re-exports", () => {
    const src =
      'import type { A } from "../fonts";\nimport { b } from "../../fonts";\nimport "./x.css";\nimport "./side";\n' +
      'export { c } from "./re";\nexport type { D } from "./t";\nconst e = await import("../fonts/picker");';
    expect(staticImports(src)).toEqual(["../../fonts", "./x.css", "./side", "./re"]);
    expect(resolveRel("src/editor/media/generators.ts", "../../fonts")).toBe("src/fonts/index.ts");
    expect(resolveRel("src/editor/media/generators.ts", "./generators.css")).toBeNull();
  });

  it("the runtime reaches the picker list only by dynamic import, and imports nothing heavy", () => {
    const index = read("src/fonts/index.ts");
    expect(index).toContain('await import("./picker")');
    expect(staticImports(index).map((s) => resolveRel("src/fonts/index.ts", s) ?? s).sort()).toEqual(
      ["./fonts.css", "src/core/font-id.ts", "src/core/ipc.ts"].sort(),
    );
  });
});
