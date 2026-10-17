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

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import { isSubtype, num } from "./marks";

/** Annotation flags that keep a widget off the page (Hidden 2, NoView 32). */
export const HIDDEN = 2 | 32;

export function numbers(arr: unknown, n: number): number[] | null {
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
export function normalAppearance(doc: PDFDocument, w: PDFDict): PDFRef | null {
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

/* ---------------- values with no appearance ---------------- */

/** pdf.js's id of the widget at `ref` (its annotation id / storage key). */
export function pdfjsId(ref: PDFRef): string {
  return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;
}

/** A field entry from the dictionary or its /Parent chain (a field's /FT and
 *  /V are inheritable). Bounded: a crafted /Parent loop ends. */
export function inherited(d: PDFDict, key: string): PDFObject | undefined {
  let cur: PDFDict | undefined = d;
  for (let depth = 0; cur && depth < 64; depth++) {
    const v = cur.lookup(PDFName.of(key));
    if (v !== undefined) return v;
    const p: PDFObject | undefined = cur.lookup(PDFName.of("Parent"));
    cur = p instanceof PDFDict ? p : undefined;
  }
  return undefined;
}

export function hasValue(v: PDFObject | undefined): boolean {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText().trim() !== "";
  if (v instanceof PDFArray) return v.size() > 0;
  return v instanceof PDFName;
}

/** The widget's turn as pdf.js reads it (/MK /R, else /Rotate): a multiple of
 *  90 in 0..270, else 0. */
export function widgetTurn(w: PDFDict): number {
  const mk = w.lookup(PDFName.of("MK"));
  const r = mk instanceof PDFDict ? mk.lookup(PDFName.of("R")) : w.lookup(PDFName.of("Rotate"));
  if (!(r instanceof PDFNumber)) return 0;
  const a = ((Math.trunc(r.asNumber()) % 360) + 360) % 360;
  return a % 90 === 0 ? a : 0;
}

/** The text and choice widgets whose value a flattened export would lose:
 *  a value and no normal appearance — or every valued one when the form sets
 *  /NeedAppearances (the viewer is to draw them; what is there may be stale).
 *  pdf.js id → the widget's turn. Buttons are left alone (pdf.js draws no
 *  check box, and a check box without its on/off appearances is rare). */
export function fieldsNeedingAppearance(doc: PDFDocument): Map<string, number> {
  const out = new Map<string, number>();
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return out;
  const flag = acro.lookup(PDFName.of("NeedAppearances"));
  const all = flag instanceof PDFBool && flag.asBoolean();
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      if (!(raw instanceof PDFRef)) continue; // pdf.js cannot save an inline widget
      const a = ctx.lookup(raw);
      if (!(a instanceof PDFDict) || !isSubtype(a, "Widget")) continue;
      const flags = a.lookup(PDFName.of("F"));
      if (flags instanceof PDFNumber && flags.asNumber() & HIDDEN) continue;
      const ft = inherited(a, "FT");
      if (!(ft instanceof PDFName) || (ft.asString() !== "/Tx" && ft.asString() !== "/Ch")) continue;
      if (!hasValue(inherited(a, "V"))) continue;
      if (all || !normalAppearance(doc, a)) out.set(pdfjsId(raw), widgetTurn(a));
    }
  }
  return out;
}

/* ---------------- merged forms ---------------- */

/** Rename the later of two top-level form fields with the same name
 *  ("name" → "name_2"): pdf.js merges every source's fields as they are, and a
 *  viewer treats fields of one name as ONE field — two copies of a form filled
 *  in differently would show one copy's values in both. Each copy keeps its
 *  own values; the names of nested fields follow their renamed parent.
 *  Returns how many were renamed. */
export function separateDuplicateFields(doc: PDFDocument): number {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return 0;
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return 0;
  const T = PDFName.of("T");
  const nameOf = (d: PDFDict): string | null => {
    const t = d.lookup(T);
    return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
  };
  const dicts: PDFDict[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fields.size(); i++) {
    const d = fields.lookup(i);
    if (!(d instanceof PDFDict) || dicts.includes(d)) continue;
    dicts.push(d);
    const n = nameOf(d);
    if (n !== null) seen.add(n);
  }
  const taken = new Set<string>();
  let renamed = 0;
  for (const d of dicts) {
    const n = nameOf(d);
    if (n === null) continue;
    if (!taken.has(n)) {
      taken.add(n);
      continue;
    }
    let k = 2;
    while (seen.has(`${n}_${k}`) || taken.has(`${n}_${k}`)) k++;
    const fresh = `${n}_${k}`;
    d.set(T, PDFHexString.fromText(fresh));
    taken.add(fresh);
    renamed++;
  }
  return renamed;
}
