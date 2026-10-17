// The Arabic fallback's drawing: a text box laid out and drawn by the
// WebView's canvas, which shapes joining scripts (pdf-lib and fontkit's
// encodeText do not, so vector Arabic would come out as isolated letters).
// Browser-only (OffscreenCanvas); node tests inject their own rasterizer.

import type { RasterTextSpec } from "./deps";
import { firstStrongRtl } from "./bidi";
import { wrapParagraph } from "./layout";

export async function layoutCanvasLines(
  spec: RasterTextSpec,
  toPng: (c: OffscreenCanvas) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const s = spec.scale;
  const cw = Math.max(1, Math.ceil(spec.w * s));
  const ch = Math.max(1, Math.ceil(spec.h * s));
  const c = new OffscreenCanvas(cw, ch);
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2D canvas");
  g.font = `${spec.italic ? "italic " : ""}${spec.bold ? "bold " : ""}${spec.size * s}px "${spec.font}"`;
  g.fillStyle = spec.color;
  g.textBaseline = "alphabetic";
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
  try {
    return await toPng(c);
  } finally {
    c.width = 0;
    c.height = 0;
  }
}
