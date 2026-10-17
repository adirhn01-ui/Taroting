// Flatten form fields: paint every widget's current appearance into its page
// and drop the form. pdf-lib's own form.flatten() throws on a widget with no
// /AP /N (spike), so this walks the pages itself.
//
// Placement follows the PDF spec's annotation rule (ISO 32000 12.5.5): the
// form's /BBox transformed by its /Matrix gives a box; the transform A maps
// that box onto /Rect; the viewer paints with A and `Do` applies /Matrix
// itself. A rotated widget (/MK /R) is exactly a widget whose appearance has a
// rotating /Matrix, so this covers it. Widgets live in page /Annots however
// deeply their fields nest (/Kids), so a per-page walk reaches all of them.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument } from "pdf-lib";
import { isSubtype, num } from "./marks";

/** Annotation flags that keep a widget off the page (Hidden 2, NoView 32). */
const HIDDEN = 2 | 32;

function numbers(arr: unknown, n: number): number[] | null {
  if (!(arr instanceof PDFArray) || arr.size() < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

/** The `cm` operands that place an appearance form onto `rect`, or null when
 *  either has no area. */
export function widgetPlacement(rect: number[], bbox: number[], matrix: number[] | null): number[] | null {
  const m = matrix ?? [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [bbox[0]!, bbox[1]!],
    [bbox[2]!, bbox[1]!],
    [bbox[0]!, bbox[3]!],
    [bbox[2]!, bbox[3]!],
  ] as [number, number][]) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  const tx0 = Math.min(...xs);
  const ty0 = Math.min(...ys);
  const tw = Math.max(...xs) - tx0;
  const th = Math.max(...ys) - ty0;
  const rx0 = Math.min(rect[0]!, rect[2]!);
  const ry0 = Math.min(rect[1]!, rect[3]!);
  const rw = Math.abs(rect[2]! - rect[0]!);
  const rh = Math.abs(rect[3]! - rect[1]!);
  if (!(tw > 0) || !(th > 0) || !(rw > 0) || !(rh > 0)) return null;
  const sx = rw / tw;
  const sy = rh / th;
  return [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
}

/** The widget's normal appearance stream ref for its current state. */
function normalAppearance(doc: PDFDocument, w: PDFDict): PDFRef | null {
  const ap = w.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return null;
  let n = ap.get(PDFName.of("N"));
  let nl = n instanceof PDFRef ? doc.context.lookup(n) : n;
  if (nl instanceof PDFDict && !(nl instanceof PDFStream)) {
    // on/off states: the one /AS names
    const as = w.get(PDFName.of("AS"));
    if (!(as instanceof PDFName)) return null;
    n = nl.get(as);
    nl = n instanceof PDFRef ? doc.context.lookup(n) : n;
  }
  if (!(nl instanceof PDFStream)) return null;
  if (n instanceof PDFRef) return n;
  // a direct stream (not legal, but seen): register it so it can be named
  return doc.context.register(nl);
}

/** Paint every widget into its page, drop the widgets and the AcroForm.
 *  Returns how many widgets were painted. */
export function flattenForms(doc: PDFDocument): number {
  const ctx = doc.context;
  let painted = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep: (PDFRef | PDFDict)[] = [];
    const ops: string[] = [];
    let dropped = false;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const a = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (!(a instanceof PDFDict) || !isSubtype(a, "Widget")) {
        if (raw instanceof PDFRef || raw instanceof PDFDict) keep.push(raw);
        continue;
      }
      dropped = true;
      const flags = a.lookup(PDFName.of("F"));
      if (flags instanceof PDFNumber && flags.asNumber() & HIDDEN) continue;
      const ref = normalAppearance(doc, a);
      const rect = numbers(a.lookup(PDFName.of("Rect")), 4);
      if (!ref || !rect) continue; // nothing to draw: dropped silently
      const stream = ctx.lookup(ref) as PDFStream;
      const bbox = numbers(stream.dict.lookup(PDFName.of("BBox")), 4);
      if (!bbox) continue;
      const cm = widgetPlacement(rect, bbox, numbers(stream.dict.lookup(PDFName.of("Matrix")), 6));
      if (!cm) continue;
      const name = page.node.newXObject("TrtField", ref);
      ops.push(`q ${cm.map(num).join(" ")} cm ${name.asString()} Do Q`);
      painted++;
    }
    if (ops.length) {
      const start = ctx.register(ctx.stream("q\n"));
      const end = ctx.register(ctx.stream("\nQ\n"));
      page.node.wrapContentStreams(start, end);
      page.node.addContentStream(ctx.register(ctx.flateStream(ops.join("\n"))));
    }
    if (dropped) {
      if (keep.length) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
      else page.node.delete(PDFName.of("Annots"));
    }
  }
  doc.catalog.delete(PDFName.of("AcroForm"));
  return painted;
}
