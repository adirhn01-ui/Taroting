// Node-side helpers for the PDF export tests (never imported by app code):
// fixtures, a project builder, dependencies that read C:/Windows/Fonts, and
// pdf.js / pdf-lib readers for checking what came out.

import { existsSync, readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from "pdf-lib";
import type { FontEmbed, FontFamily, FontRequest, MediaRef, PdfAnnot, PdfPage, PdfSource, ProjectFile, ResolvedFont } from "../../core/types";
import type { ExportDeps, PdfjsLike, RasterTextSpec } from "./deps";
import { buildAppearance, markContext } from "./marks";

export const FIXTURES = "tests/fixtures/pdf/";
export const fixture = (name: string): string => FIXTURES + name;
export const hasFixture = (...names: string[]): boolean => names.every((n) => existsSync(fixture(n)));

const FONT_FILES: Record<FontFamily, [string, string, string, string]> = {
  "Segoe UI": ["segoeui", "segoeuib", "segoeuii", "segoeuiz"],
  Arial: ["arial", "arialbd", "ariali", "arialbi"],
  Georgia: ["georgia", "georgiab", "georgiai", "georgiaz"],
  "Times New Roman": ["times", "timesbd", "timesi", "timesbi"],
  "Courier New": ["cour", "courbd", "couri", "courbi"],
  Impact: ["impact", "impact", "impact", "impact"],
};
export function fontFile(family: FontFamily, bold: boolean, italic: boolean): string {
  return `C:/Windows/Fonts/${FONT_FILES[family][(bold ? 1 : 0) + (italic ? 2 : 0)]}.ttf`;
}
export const hasFont = (f: FontFamily = "Arial"): boolean => existsSync(fontFile(f, false, false));

/** A 2×2 opaque red PNG. */
export const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

export interface TestDeps extends ExportDeps {
  rasterCalls: RasterTextSpec[];
  decodeCalls: string[];
  /** every resolveFonts request list, in order */
  resolveCalls: FontRequest[][];
}

export function nodeDeps(over: Partial<ExportDeps> = {}): TestDeps {
  const rasterCalls: RasterTextSpec[] = [];
  const decodeCalls: string[] = [];
  const resolveCalls: FontRequest[][] = [];
  const base: TestDeps = {
    rasterCalls,
    decodeCalls,
    resolveCalls,
    pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike,
    pdfjsOptions: { verbosity: 0, standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/" },
    fileStat: async (path) => (existsSync(path) ? { size: readFileSync(path).length, mtimeMs: 1000 } : null),
    readBytes: async (path) => new Uint8Array(readFileSync(path)),
    fontBytes: async (family, bold, italic) => {
      const f = fontFile(family, bold, italic);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
    // no non-legacy font is on the test PC unless a test says so
    resolveFonts: async (reqs) =>
      reqs.map((r) => ({ requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" as const })),
    decodeImage: async (_bytes, mime) => {
      decodeCalls.push(mime);
      return TINY_PNG;
    },
    rasterizeText: async (spec) => {
      rasterCalls.push(spec);
      return TINY_PNG;
    },
    now: () => new Date("2026-10-17T12:00:00Z"),
  };
  const out = Object.assign(base, over);
  // count the calls whichever resolveFonts is in force
  const resolve = out.resolveFonts;
  out.resolveFonts = (reqs) => {
    resolveCalls.push(reqs);
    return resolve(reqs);
  };
  return out;
}

let seq = 0;
export const uid = (p: string): string => `${p}${++seq}`;

export function source(file: string, id = uid("s")): PdfSource {
  const bytes = readFileSync(fixture(file));
  return { id, path: fixture(file), size: bytes.length, mtimeMs: 1000, pages: 0 };
}

export const pg = (src: PdfSource | null, page: number, rotate: 0 | 90 | 180 | 270 = 0, w?: number, h?: number): PdfPage => ({
  id: uid("p"),
  src: src ? src.id : null,
  page,
  rotate,
  ...(w !== undefined ? { w, h } : {}),
});

export function project(
  sources: PdfSource[],
  pages: PdfPage[],
  annots: Record<string, PdfAnnot[]> = {},
  forms: Record<string, Record<string, string | boolean | string[]>> = {},
  media: MediaRef[] = [],
): ProjectFile {
  return {
    schema: 4,
    kind: "pdf",
    app: "taroting",
    id: "proj",
    name: "test",
    createdAt: "",
    modifiedAt: "",
    media,
    timeline: { tracks: [] } as unknown as ProjectFile["timeline"],
    export: {} as ProjectFile["export"],
    pdf: { sources, pages, annots, forms },
  };
}

/** Encode [x, y, pressure] triples the way strokes.ts stores them. */
export function encodePts(pts: number[]): string {
  const f = new Float32Array(pts);
  const b = new Uint8Array(f.buffer);
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return btoa(s).replace(/=+$/, "");
}

/* ---------------- reading output back ---------------- */

export interface ReadPage {
  rotate: number;
  view: number[];
  text: string;
  annots: { id: string; subtype: string; rect: number[]; fieldName?: string; fieldValue?: unknown; textContent?: string[] }[];
}

export async function readBack(bytes: Uint8Array): Promise<{ pages: ReadPage[]; fields: Map<string, Record<string, unknown>[]> | null }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: ReadPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      const an = (await p.getAnnotations()) as ReadPage["annots"];
      pages.push({
        rotate: p.rotate,
        view: [...p.view],
        text: tc.items.map((x) => ("str" in x ? x.str : "")).join(" "),
        annots: an.map((a) => ({
          id: a.id,
          subtype: a.subtype,
          rect: [...a.rect],
          fieldName: a.fieldName,
          fieldValue: a.fieldValue,
          // the text pdf.js reads from the widget's appearance stream (none
          // while the form sets /NeedAppearances)
          textContent: a.textContent,
        })),
      });
    }
    const fields = (await doc.getFieldObjects()) as Map<string, Record<string, unknown>[]> | null;
    return { pages, fields };
  } finally {
    await task.destroy();
  }
}

/** Raw annotation dictionaries of one page, via pdf-lib. */
export async function rawAnnots(bytes: Uint8Array, pageIndex: number): Promise<{ doc: PDFDocument; annots: PDFDict[] }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const arr = page.node.Annots();
  const annots: PDFDict[] = [];
  if (arr) for (let i = 0; i < arr.size(); i++) annots.push(arr.lookup(i, PDFDict));
  return { doc, annots };
}

export function nums(d: PDFDict, key: string): number[] {
  const a = d.lookup(PDFName.of(key));
  if (!(a instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = a.lookup(i);
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

export function apStream(doc: PDFDocument, annot: PDFDict): PDFStream | null {
  const ap = annot.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return null;
  const n = ap.get(PDFName.of("N"));
  const s = n instanceof PDFRef ? doc.context.lookup(n) : n;
  return s instanceof PDFStream ? s : null;
}

export function subtypeOf(d: PDFDict): string {
  return d.get(PDFName.of("Subtype"))?.toString().slice(1) ?? "";
}

/* ---------------- one text box's appearance (0.9.4 runs) ---------------- */

export const CONSOLAS = "C:/Windows/Fonts/consola.ttf";

export const textBox = (over: Partial<Extract<PdfAnnot, { t: "text" }>> = {}): Extract<PdfAnnot, { t: "text" }> => ({
  id: "t1",
  t: "text",
  x: 72,
  y: 90,
  w: 180,
  h: 120,
  text: "Hello there",
  font: "Georgia",
  size: 13,
  c: "#102030",
  bold: false,
  italic: false,
  align: "left",
  ...over,
});

/** fonts_resolve: every id resolves to Consolas' regular file with `embed`. */
export function consolas(embed: FontEmbed | "missing" = "full") {
  return async (reqs: FontRequest[]): Promise<ResolvedFont[]> =>
    reqs.map((r) =>
      embed === "missing"
        ? { requested: r.id, found: false, bold: false, italic: false, path: "", lineHeightEm: 0, embed: "none" }
        : { requested: r.id, found: true, bold: false, italic: false, path: CONSOLAS, lineHeightEm: 1.17, embed },
    );
}

/** One mark's appearance, refs printed as "n 0 R". */
export async function appear(a: PdfAnnot, deps: TestDeps = nodeDeps()) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const cx = markContext(doc, project([], [], {}), deps);
  const app = await buildAppearance(a, { x: 0, y: 0, w: 612, h: 792 }, cx);
  if (!app) return null;
  const json = (v: unknown): unknown =>
    JSON.parse(
      JSON.stringify(v, (_k, x) =>
        x instanceof PDFRef ? `ref ${x.toString()}` : x instanceof PDFHexString || x instanceof PDFString ? `str ${x.toString()}` : x,
      ),
    );
  return { ops: app.ops, rect: app.rect, resources: json(app.resources), annot: json(app.annot), raster: deps.rasterCalls };
}
