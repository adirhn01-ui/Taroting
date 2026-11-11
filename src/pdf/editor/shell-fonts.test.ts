// The PDF editor shell and non-legacy fonts (0.9.4): which requests a project
// makes on open (none for a project without a fontId, I1) and the remembered
// Text tool font. The notice for fonts not on this PC: shell.mount.test.ts.

import { describe, expect, it, vi } from "vitest";
import { createPdfProject } from "../../core/pdf-project";
import type { PdfAnnot, ProjectFile } from "../../core/types";

vi.mock("../view", () => ({}));
vi.mock("./tools", () => ({ toolsPart: () => ({ dispose() {} }) }));
vi.mock("./inspector", () => ({ inspectorPart: () => ({ dispose() {} }) }));
vi.mock("./forms", () => ({ formsPart: () => ({ dispose() {} }) }));
vi.mock("./export-dialog", () => ({ openPdfExportDialog: () => {} }));

const { defaultToolState, projectFontRequests } = await import("./shell");

const text = (id: string, extra: Partial<Extract<PdfAnnot, { t: "text" }>> = {}): PdfAnnot => ({
  id, t: "text", x: 1, y: 2, w: 30, h: 10, text: "x", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", ...extra,
});
function withMarks(byPage: PdfAnnot[][]): ProjectFile {
  const p = createPdfProject("x", { path: "C:\\a.pdf", size: 1, mtimeMs: 1, pages: byPage.length });
  const annots: Record<string, PdfAnnot[]> = {};
  p.pdf!.pages.forEach((pg, i) => (annots[pg.id] = byPage[i]!));
  return { ...p, pdf: { ...p.pdf!, annots } };
}

describe("projectFontRequests", () => {
  it("is empty for a project whose text uses only legacy fonts (the runtime is never loaded)", () => {
    expect(projectFontRequests(withMarks([[text("a"), text("b", { font: "Impact" })]]))).toEqual([]);
  });

  it("one request per distinct id and face, across pages; ill-shaped ids ignored", () => {
    const p = withMarks([
      [text("a", { fontId: "lib:Inter", bold: true }), text("b", { fontId: "lib:Inter", bold: true })],
      [text("c", { fontId: "Consolas", italic: true }), text("d", { fontId: "lib:" })],
    ]);
    expect(projectFontRequests(p)).toEqual([
      { id: "lib:Inter", bold: true, italic: false },
      { id: "Consolas", bold: false, italic: true },
    ]);
  });
});

describe("projectFontRequests and style runs (0.9.4)", () => {
  it("includes every run's font once, each resolved over its box (a bold-only run asks for the bold face)", () => {
    const p = withMarks([
      [
        text("a", {
          text: "hello world",
          fontId: "lib:Inter",
          runs: [
            { s: 0, e: 2, font: "Georgia", fontId: "lib:Lato" },
            { s: 3, e: 4, bold: true },
            { s: 6, e: 8, font: "Georgia", fontId: "lib:Lato" },
            { s: 9, e: 10, font: "Courier New" },
          ],
        }),
      ],
      [text("b", { text: "xy", runs: [{ s: 0, e: 1, font: "Arial", fontId: "lib:Lato", italic: true }] })],
    ]);
    expect(projectFontRequests(p)).toEqual([
      { id: "lib:Inter", bold: false, italic: false },
      { id: "lib:Lato", bold: false, italic: false },
      { id: "lib:Inter", bold: true, italic: false },
      { id: "lib:Lato", bold: false, italic: true },
    ]);
  });

  it("stays empty for a legacy-only project whose runs are legacy too", () => {
    const p = withMarks([[text("a", { text: "hello", runs: [{ s: 0, e: 2, font: "Georgia", bold: true }, { s: 3, e: 5, size: 30 }] })]]);
    expect(projectFontRequests(p)).toEqual([]);
  });
});

describe("defaultToolState and the remembered font", () => {
  it("brings back a remembered fontId beside its legacy font; none when absent", () => {
    expect(defaultToolState({ font: "Segoe UI", fontId: "lib:Inter" })).toMatchObject({ font: "Segoe UI", fontId: "lib:Inter" });
    expect("fontId" in defaultToolState({ font: "Georgia" })).toBe(false);
  });
});
