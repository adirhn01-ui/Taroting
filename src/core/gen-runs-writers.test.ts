// Guard: a text generator's `runs` are written only through the setters in
// core/gen-text-runs.ts (withRunsKey, withGenText, styleGenRange,
// styleGenWhole). A `{ ...g, text }` spread elsewhere would carry the runs of
// the OLD text onto the new one (offsets pointing past its end, or at other
// characters), and a direct `runs` write skips normalizeRuns. These checks read
// the source of the image and video editors.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A spread of some object with a new `text`, a `runs` key in a literal, a
 *  `.runs =` assignment, or a `delete x.runs`. */
const WRITES = [/\{\s*\.\.\.[A-Za-z_$][\w$.]*\s*,\s*text\s*[:,}]/, /(^|[{,\s])runs\s*:/, /\.runs\s*=(?!=)/, /\bdelete\s+[\w$.]+\.runs\b/];

/** Lines that write `runs` legitimately, exactly as they read (trimmed). */
const ALLOWED: Record<string, readonly string[]> = {
  // The load cleaner keeps the runs it was given, clipped to the cut text.
  "src/image/layers.ts": ["const out: TextGen = { ...g, text, fontFamily, sizePx, color, bold, italic };", "if (runs && runs.length > 0) out.runs = runs;", "else delete out.runs;"],
  // The open editor's own undo snapshots (never a generator), and a snapshot
  // turned back into a generator through withRunsKey on the same line.
  "src/image/text/text-edit.ts": [
    "runs: PdfTextRun[] | undefined;",
    "runs: normalizeRuns(startText, genRunBase(opened), opened.runs),",
    "push({ text: cur.text, runs: runsNow(), sel: keep }, false);",
    "stack = stack.map((x) => ({ ...x, runs: clearRunFields(base, x.runs, fields) }));",
    "const g = withRunsKey({ ...cur, text: s.text }, normalizeRuns(s.text, genRunBase(cur), s.runs));",
  ],
  // A font request with the text it must cover, not a generator.
  "src/editor/export/export-dialog.ts": ["const answer = await ipc.fontsMissingGlyphs(present.map((i) => ({ ...i.req, text: i.gen.text })));"],
};

/** `file: line` for every write outside the allowed lines. Comments and
 *  push(`...`) report strings are not code and are skipped. */
function strayWrites(file: string, src: string): string[] {
  const allowed = new Set(ALLOWED[file] ?? []);
  const out: string[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    if (!WRITES.some((re) => re.test(line))) return;
    if (allowed.has(line)) return;
    out.push(`${file}:${i + 1}: ${line}`);
  });
  return out;
}

const sources = (dir: string): string[] =>
  readdirSync(resolve(root, dir), { recursive: true })
    .map((p) => `${dir}/${p.replace(/\\/g, "/")}`)
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !/\.test(-util)?\.ts$/.test(p) && !p.endsWith(".test-util.ts"));

describe("only the run setters write a text's runs", () => {
  it("the checker sees each kind of write", () => {
    expect(strayWrites("x.ts", "apply({ ...cur, text });")).toHaveLength(1);
    expect(strayWrites("x.ts", "const g = { ...gen, text: t };")).toHaveLength(1);
    expect(strayWrites("x.ts", "next = { ...g, runs: r };")).toHaveLength(1);
    expect(strayWrites("x.ts", "g.runs = [];")).toHaveLength(1);
    expect(strayWrites("x.ts", "delete g.runs;")).toHaveLength(1);
    expect(strayWrites("x.ts", "if (g.runs === r) return g;")).toEqual([]);
    expect(strayWrites("x.ts", "apply(withGenText(cur, text));")).toEqual([]);
  });

  it("no file under src/image or src/editor writes them another way", () => {
    const stray = [...sources("src/image"), ...sources("src/editor")].flatMap((f) => strayWrites(f, readFileSync(resolve(root, f), "utf8")));
    expect(stray).toEqual([]);
  });

  it("every allowed line still exists (a stale entry hides nothing)", () => {
    const missing: string[] = [];
    for (const [file, lines] of Object.entries(ALLOWED)) {
      const have = new Set(readFileSync(resolve(root, file), "utf8").split(/\r?\n/).map((l) => l.trim()));
      for (const l of lines) if (!have.has(l)) missing.push(`${file}: ${l}`);
    }
    expect(missing).toEqual([]);
  });
});
