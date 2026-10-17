// Node-side helpers for the PDF export tests (never imported by app code):
// fixtures, a project builder, dependencies that read C:/Windows/Fonts, and
// pdf.js / pdf-lib readers for checking what came out.

import { existsSync, readFileSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from "pdf-lib";
import type { FontFamily, MediaRef, PdfAnnot, PdfPage, PdfSource, ProjectFile } from "../../core/types";
import type { ExportDeps, PdfjsLike, RasterTextSpec } from "./deps";

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
}

export function nodeDeps(over: Partial<ExportDeps> = {}): TestDeps {
  const rasterCalls: RasterTextSpec[] = [];
  const decodeCalls: string[] = [];
  const base: TestDeps = {
    rasterCalls,
    decodeCalls,
    pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike,
    pdfjsOptions: { verbosity: 0, standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/" },
    fileStat: async (path) => (existsSync(path) ? { size: readFileSync(path).length, mtimeMs: 1000 } : null),
    readBytes: async (path) => new Uint8Array(readFileSync(path)),
    fontBytes: async (family, bold, italic) => {
      const f = fontFile(family, bold, italic);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
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
  return Object.assign(base, over);
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
  annots: { id: string; subtype: string; rect: number[]; fieldName?: string; fieldValue?: unknown }[];
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
      const an = (await p.getAnnotations()) as { id: string; subtype: string; rect: number[]; fieldName?: string; fieldValue?: unknown }[];
      pages.push({
        rotate: p.rotate,
        view: [...p.view],
        text: tc.items.map((x) => ("str" in x ? x.str : "")).join(" "),
        annots: an.map((a) => ({ id: a.id, subtype: a.subtype, rect: [...a.rect], fieldName: a.fieldName, fieldValue: a.fieldValue })),
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
