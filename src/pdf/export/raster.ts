// The Arabic fallback's drawing: a text box laid out and drawn by the
// WebView's canvas, which shapes joining scripts (pdf-lib and fontkit's
// encodeText do not, so vector Arabic would come out as isolated letters).
// Browser-only (OffscreenCanvas); node tests inject their own rasterizer.

import { rowMetrics, type RowPiece } from "../../core/pdf-runs";
import type { RasterTextSpec } from "./deps";
import { firstStrongRtl, paragraphBidi, visualGroups } from "./bidi";
import { rangeMeasurer, rasterScale, wrapParagraph, wrapRanges, type MeasurePiece } from "./layout";

/** `alias`: the font runtime's alias of `spec.fontId`, already loaded (the
 *  caller awaited it); absent = `spec.font`, exactly as 0.9.3. `runAliases`:
 *  the same for each of `spec.runs`, by index. */
export async function layoutCanvasLines(
  spec: RasterTextSpec,
  toPng: (c: OffscreenCanvas) => Promise<Uint8Array>,
  alias?: string,
  runAliases?: readonly (string | undefined)[],
): Promise<Uint8Array> {
  // capped here too: whatever asked, the canvas stays within the limits
  const s = Math.min(spec.scale, rasterScale(spec.w, spec.h));
  const cw = Math.max(1, Math.ceil(spec.w * s));
  const ch = Math.max(1, Math.ceil(spec.h * s));
  const c = new OffscreenCanvas(cw, ch);
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2D canvas");
  const family = alias === undefined ? `"${spec.font}"` : `${alias}, "${spec.font}"`;
  g.font = `${spec.italic ? "italic " : ""}${spec.bold ? "bold " : ""}${spec.size * s}px ${family}`;
  g.fillStyle = spec.color;
  g.textBaseline = "alphabetic";
  if (spec.runs) {
    drawRuns(g, spec, s, runAliases ?? []);
  } else {
    const m = g.measureText("Hg");
    const asc = m.fontBoundingBoxAscent / s;
    const desc = m.fontBoundingBoxDescent / s;
    const lh = spec.lineHeight;
    let row = 0;
    for (const para of spec.text.split(/\r\n|\r|\n/)) {
      g.direction = firstStrongRtl(para) ? "rtl" : "ltr";
      const lines = wrapParagraph(para, spec.w, (t) => g.measureText(t).width / s);
      for (const [a, b] of lines) {
        const text = para.slice(a, b);
        const base = row * lh + (lh - (asc + desc)) / 2 + asc;
        const x = spec.align === "left" ? 0 : spec.align === "center" ? spec.w / 2 : spec.w;
        g.textAlign = spec.align;
        g.fillText(text, x * s, base * s);
        row++;
      }
    }
  }
  try {
    return await toPng(c);
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/**
 * A box with style runs (0.9.4): wrapped by the sum of its pieces' widths,
 * rows by `rowMetrics` with the box's own font (already set on `g`) as the
 * strut, and each line drawn as its visual groups, left to right: one
 * `fillText` per group in that group's face, size and colour. A group is
 * LOGICAL text with its own direction, so the canvas still shapes it (joining
 * stops where the style changes).
 */
function drawRuns(g: OffscreenCanvasRenderingContext2D, spec: RasterTextSpec, s: number, aliases: readonly (string | undefined)[]): void {
  const runs = spec.runs!;
  const metrics = (size: number): RowPiece & { font: string } => {
    const m = g.measureText("Hg");
    return { font: g.font, size, asc: m.fontBoundingBoxAscent / s, desc: m.fontBoundingBoxDescent / s };
  };
  const strut = metrics(spec.size);
  const faces = runs.map((r, i) => {
    const a = aliases[i];
    const family = a === undefined ? `"${r.font}"` : `${a}, "${r.font}"`;
    g.font = `${r.italic ? "italic " : ""}${r.bold ? "bold " : ""}${r.size * s}px ${family}`;
    return metrics(r.size);
  });
  const segAt = (i: number): number => {
    let lo = 0;
    let hi = runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid]!.e <= i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const width = (k: number, t: string): number => {
    g.font = faces[k]!.font;
    return g.measureText(t).width / s;
  };
  g.textAlign = "left";
  let top = 0;
  let ps = 0;
  for (const para of spec.text.split(/\r\n|\r|\n/)) {
    const local: (MeasurePiece & { seg: number })[] = [];
    if (para) {
      for (let k = segAt(ps); k < runs.length && runs[k]!.s < ps + para.length; k++) {
        local.push({ s: Math.max(runs[k]!.s, ps) - ps, e: Math.min(runs[k]!.e, ps + para.length) - ps, seg: k });
      }
    }
    const bidi = paragraphBidi(para);
    const measure = rangeMeasurer(local, (k, a, b) => width(local[k]!.seg, para.slice(a, b)));
    for (const [a, b] of wrapRanges(para, spec.w, measure)) {
      const m = rowMetrics(
        local.filter((p) => p.s < b && p.e > a).map((p) => faces[p.seg]!),
        strut,
      );
      const base = top + m.baseline;
      top += m.height;
      const groups = visualGroups(bidi, a, b, (i) => segAt(ps + i));
      const ws = groups.map((gr) => width(gr.seg, para.slice(gr.s, gr.e)));
      const lw = ws.reduce((t, w) => t + w, 0);
      let x = spec.align === "left" ? 0 : spec.align === "center" ? (spec.w - lw) / 2 : spec.w - lw;
      groups.forEach((gr, i) => {
        g.font = faces[gr.seg]!.font;
        g.fillStyle = runs[gr.seg]!.color;
        g.direction = gr.rtl ? "rtl" : "ltr";
        g.fillText(para.slice(gr.s, gr.e), x * s, base * s);
        x += ws[i]!;
      });
    }
    ps += para.length + (spec.text.startsWith("\r\n", ps + para.length) ? 2 : 1);
  }
}
