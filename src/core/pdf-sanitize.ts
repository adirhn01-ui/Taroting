// PDF projects: load-time sanitation and invariants. Split from
// core/project.ts so the boot path never parses it: ipc.loadProject imports
// this module only for a `kind: "pdf"` file, and importing it registers the
// rules with project.ts (`registerPdfProjectHooks`), which sanitizeProject and
// checkInvariants dispatch through.
//
// A `.trt` is plain JSON that `load_project` hands over RAW, and it is the
// file people share — so everything in a PDF project's `pdf` block is read as
// hostile (see the comment block at the end of core/project.ts). It must never
// import src/pdf/** or pdf.js, and it does not import core/session (session
// imports project.ts): the helpers it needs from elsewhere are MIRRORED here
// with a test pinning each copy to its original.

import type {
  FontFamily,
  PdfTextEdit,
  MediaRef,
  PdfAnnot,
  PdfExportPreset,
  PdfFormValue,
  PdfMeta,
  PdfPage,
  PdfSource,
  ProjectFile,
  Rational,
  Timeline,
  Track,
} from "./types";
import { PDF_MAX_ANNOTS_PER_PAGE, PDF_MAX_PAGES } from "./types";
import { MAX_CANVAS, MIN_CANVAS, ProjectFileError, registerPdfProjectHooks, sanitizeFps, sanitizeMediaRef, uid } from "./project";

/** Blank page side, points (PDF's own user-space limit is 14400). */
export const PDF_PAGE_SIDE_MIN = 1;
export const PDF_PAGE_SIDE_MAX = 14_400;
/** Any page-space coordinate or extent: far beyond a 14400 pt page, so only a
 *  crafted value is refused. */
export const PDF_COORD_MAX = 1e6;
/** Stroke width, points: (0, PDF_STROKE_WIDTH_MAX]. */
export const PDF_STROKE_WIDTH_MAX = 1000;
/** Characters in a text mark, and in a form text value / one choice. */
export const PDF_TEXT_MAX_CHARS = 20_000;
export const PDF_FONT_SIZE_MIN = 4;
export const PDF_FONT_SIZE_MAX = 288;
export const PDF_HIGHLIGHT_MAX_RECTS = 1000;
export const PDF_SIGNATURE_MAX_STROKES = 1000;
/** Glyph rects an edited text box ("Edit text") may replace. Each one also
 *  counts as a point against PDF_TOTAL_MAX_POINTS: every rect is parsed
 *  against the page content at export, and may become a cover rect. */
export const PDF_EDIT_MAX_RECTS = 2000;
/** Points in one ink stroke / across the whole document. Lower than the image
 *  editor's MAX_STROKE_POINTS / MAX_TOTAL_POINTS (src/image/strokes.ts; a
 *  test pins them no higher): every PDF point becomes vector text in the
 *  exported file (outline ring + InkList), and at the image editor's 20M a
 *  crafted `.trt` made an export run for minutes and take GBs (2M points
 *  measured 58 s / 3.5 GB before the build became cancellable).
 *  Real use: a pointer reports ~120-240 points a second, so one 100k-point
 *  stroke is 7-14 minutes of drawing without lifting the pen; a page of
 *  dense handwriting is ~30k points, so 2M is ~65 such pages. */
export const PDF_STROKE_MAX_POINTS = 100_000;
export const PDF_TOTAL_MAX_POINTS = 2_000_000;
/** Filled-in form fields kept per source, and selected options per field. */
export const PDF_FORM_MAX_FIELDS = 10_000;
export const PDF_FORM_MAX_CHOICES = 500;
/** Longest path Windows can name (the \\?\ form). */
export const PDF_PATH_MAX_CHARS = 32_767;

/** Every id in a PDF block (source, page, mark): what `uid()` produces. The
 *  three keys that can REWRITE a prototype are refused; other built-in names
 *  ("toString", "valueOf", "hasOwnProperty"…) still pass, so every lookup by
 *  one of these ids must be an own-property read, a Map or a null-prototype
 *  record — never a plain `{}[id]`. */
const PDF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isPdfId(v: unknown): v is string {
  return typeof v === "string" && PDF_ID_RE.test(v) && !RESERVED_KEYS.has(v);
}

/** A form field key: a pdf.js widget annotation id — its object reference
 *  ("12R", or "12R3" for generation 3) or, for a widget written inline in
 *  /Annots, "annot_p<page>_<n>". Nothing else: pdf.js reads a storage key
 *  starting "pdfjs_internal_editor_" as a NEW annotation, and a form value
 *  there breaks the export. */
const PDF_FIELD_ID_RE = /^(?:\d{1,10}R(?:\d{1,5})?|annot_p\d{1,6}_\d{1,9})$/;

export function isPdfFieldId(v: unknown): v is string {
  return typeof v === "string" && PDF_FIELD_ID_RE.test(v);
}

/** The turn of a text, image or signature mark (`r`), or null for none. */
function markTurnOf(v: unknown): 90 | 180 | 270 | null {
  return v === 90 || v === 180 || v === 270 ? v : null;
}

/** The FontFamily whitelist as a value. Typed `Record<FontFamily, true>` so
 *  the compiler fails if the union and this table ever disagree. */
const PDF_FONTS: Record<FontFamily, true> = {
  "Segoe UI": true,
  Arial: true,
  Georgia: true,
  "Times New Roman": true,
  "Courier New": true,
  Impact: true,
};

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isPdfFont(v: unknown): v is FontFamily {
  return typeof v === "string" && hasOwn(PDF_FONTS, v);
}

const PDF_HEX_BODY = /^[0-9a-f]{3}$|^[0-9a-f]{6}$/;
/** `normalizeHexColor(v, "")` from core/session, MIRRORED (session imports
 *  this module, so importing it back would be a cycle): a readable colour as
 *  lowercase #rrggbb, or null. A test pins the two to the same answers. */
export function pdfHexColor(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 12) return null;
  const s = v.trim().toLowerCase();
  const body = s.startsWith("#") ? s.slice(1) : s;
  if (!PDF_HEX_BODY.test(body)) return null;
  if (body.length === 3) {
    const r = body[0]!;
    const g = body[1]!;
    const b = body[2]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return `#${body}`;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** A scheme of two or more characters followed by `//` — a URL, never a file
 *  (a drive letter is one character). Media inputs are files, never URLs. */
const URL_LIKE = /^[a-z][a-z0-9+.-]+:\/\//i;

/** A path the app may stat/read as a source file. */
export function isPdfFilePath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= PDF_PATH_MAX_CHARS &&
    !CONTROL_CHARS.test(v) &&
    !URL_LIKE.test(v)
  );
}

function isCoord(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= PDF_COORD_MAX;
}
function isExtent(v: unknown): v is number {
  return isCoord(v) && v >= 0;
}
function isStrokeWidth(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= PDF_STROKE_WIDTH_MAX;
}
function isCount(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}
function isStamp(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
/** Opacity: a finite number is clamped into [0, 1]; anything else is null. */
function opacityOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : null;
}
function pairOf(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x: unknown = v[0];
  const y: unknown = v[1];
  return isCoord(x) && isCoord(y) ? [x, y] : null;
}
function boxOf(o: Record<string, unknown>): { x: number; y: number; w: number; h: number } | null {
  const { x, y, w, h } = o;
  return isCoord(x) && isCoord(y) && isExtent(w) && isExtent(h) ? { x, y, w, h } : null;
}

const PDF_B64_BODY = /^[A-Za-z0-9+/]+$/;
/** `decodePoints` (src/image/strokes.ts), MIRRORED — core never imports
 *  src/image — plus the page-space bound: unpadded base64 of Float32LE
 *  [x, y, pressure] triples (16 chars per point), every value finite,
 *  pressure in [0, 1], |x|,|y| <= PDF_COORD_MAX, at most `maxPoints` points
 *  (checked from the length BEFORE decoding). Null when it is not one.
 *  Total: never throws. */
export function decodePdfPoints(
  p: unknown,
  maxPoints: number = PDF_STROKE_MAX_POINTS,
): Float32Array | null {
  if (typeof p !== "string" || p.length === 0 || p.length % 16 !== 0) return null;
  if (p.length / 16 > maxPoints) return null;
  if (!PDF_B64_BODY.test(p)) return null;
  let bin: string;
  try {
    bin = atob(p);
  } catch {
    return null;
  }
  if (bin.length % 12 !== 0) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return null;
    if (i % 3 === 2 ? v < 0 || v > 1 : Math.abs(v) > PDF_COORD_MAX) return null;
    out[i] = v;
  }
  return out;
}

/** Points an annot carries (ink `p`, signature `strokes`), from lengths; an
 *  edited text box counts one per replaced glyph rect. */
export function pdfAnnotPointCount(a: PdfAnnot): number {
  if (a.t === "ink") return Math.floor(a.p.length / 16);
  if (a.t === "text") return a.edit ? a.edit.rects.length : 0;
  if (a.t === "signature") {
    let n = 0;
    for (const s of a.strokes) n += Math.floor(s.length / 16);
    return n;
  }
  return 0;
}

/** An edited text box's `edit` (PdfTextEdit), or null when it is not one:
 *  1..PDF_EDIT_MAX_RECTS rects of [x, y, w, h] (coordinates per isCoord, w/h
 *  >= 0) and no more than `maxRects`; `orig` a string <= PDF_TEXT_MAX_CHARS;
 *  `cover` a colour, #ffffff when unreadable. A fresh copy. */
export function sanitizePdfTextEdit(v: unknown, maxRects: number = PDF_EDIT_MAX_RECTS): PdfTextEdit | null {
  if (!isRecord(v)) return null;
  const { rects, cover, orig } = v;
  if (typeof orig !== "string" || orig.length > PDF_TEXT_MAX_CHARS) return null;
  if (!Array.isArray(rects) || rects.length === 0) return null;
  if (rects.length > PDF_EDIT_MAX_RECTS || rects.length > maxRects) return null;
  const out: [number, number, number, number][] = [];
  for (const r of rects as unknown[]) {
    if (!Array.isArray(r) || r.length !== 4) return null;
    const [x, y, w, h] = r as unknown[];
    if (!isCoord(x) || !isCoord(y) || !isExtent(w) || !isExtent(h)) return null;
    out.push([x, y, w, h]);
  }
  return { rects: out, cover: pdfHexColor(cover) ?? "#ffffff", orig };
}

const INK_KINDS: ReadonlySet<string> = new Set(["pen", "pencil", "marker"]);
const SHAPE_KINDS: ReadonlySet<string> = new Set(["line", "rect", "ellipse", "arrow"]);
const ALIGNS: ReadonlySet<string> = new Set(["left", "center", "right"]);

/**
 * One untrusted mark → a FRESH annot carrying only its kind's fields, or null
 * when it cannot be one. Rules (any failure drops the mark):
 *  - `id` passes `isPdfId`; `t` is one of the eleven kinds
 *  - colours via the hex normaliser (stored lowercase #rrggbb)
 *  - coordinates finite with |v| <= 1e6; box w/h also >= 0
 *  - stroke width in (0, 1000]; opacity finite (clamped into [0, 1])
 *  - ink: kind pen/pencil/marker, `p` decodes (`decodePdfPoints`)
 *  - highlight: 1..1000 rects of [x, y, w, h]
 *  - text: string <= 20k chars, font on the whitelist, size 4..288, bold and
 *    italic booleans, align left/center/right
 *  - text: `bg` / `border` kept only when readable colours; `edit` per
 *    `sanitizePdfTextEdit` (its rects within the point budget) — a bad one is
 *    left out and the box kept
 *  - text, image, signature: `r` kept only when 90, 180 or 270 (else absent)
 *  - image: `media` names an image in `imageMedia`
 *  - signature: 1..1000 strokes, each decodes
 *  - ink + signature points of this mark at most `maxPoints` (the caller's
 *    remaining document budget)
 */
export function sanitizePdfAnnot(
  raw: unknown,
  imageMedia: ReadonlySet<string>,
  maxPoints: number = PDF_STROKE_MAX_POINTS,
): PdfAnnot | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  if (!isPdfId(id)) return null;
  const t = raw.t;
  if (typeof t !== "string") return null;

  if (t === "whiteout" || t === "image" || t === "signature" || t === "text") {
    const b = boxOf(raw);
    if (!b) return null;
    // whiteout has no turn; any other value than 90/180/270 is no turn
    const r = t === "whiteout" ? null : markTurnOf(raw.r);
    const turn = r === null ? {} : { r };
    if (t === "image") {
      const media = raw.media;
      if (typeof media !== "string" || !imageMedia.has(media)) return null;
      return { id, t, ...b, media, ...turn };
    }
    const c = pdfHexColor(raw.c);
    if (c === null) return null;
    if (t === "whiteout") return { id, t, ...b, c };
    if (t === "signature") {
      const strokes = raw.strokes;
      if (!Array.isArray(strokes) || strokes.length === 0) return null;
      if (strokes.length > PDF_SIGNATURE_MAX_STROKES) return null;
      let budget = maxPoints;
      const out: string[] = [];
      for (const s of strokes as unknown[]) {
        if (decodePdfPoints(s, Math.min(budget, PDF_STROKE_MAX_POINTS)) === null) return null;
        const str = s as string;
        budget -= str.length / 16;
        out.push(str);
      }
      return { id, t, ...b, c, strokes: out, ...turn };
    }
    // text
    const { text, font, size, bold, italic, align } = raw;
    if (typeof text !== "string" || text.length > PDF_TEXT_MAX_CHARS) return null;
    if (!isPdfFont(font)) return null;
    if (typeof size !== "number" || !(size >= PDF_FONT_SIZE_MIN && size <= PDF_FONT_SIZE_MAX))
      return null;
    if (typeof bold !== "boolean" || typeof italic !== "boolean") return null;
    if (typeof align !== "string" || !ALIGNS.has(align)) return null;
    const bg = pdfHexColor(raw.bg);
    const border = pdfHexColor(raw.border);
    const edit = sanitizePdfTextEdit(raw.edit, maxPoints);
    return {
      id,
      t,
      ...b,
      text,
      font,
      size,
      c,
      bold,
      italic,
      align: align as "left" | "center" | "right",
      ...turn,
      ...(bg === null ? {} : { bg }),
      ...(border === null ? {} : { border }),
      ...(edit === null ? {} : { edit }),
    };
  }

  const c = pdfHexColor(raw.c);
  if (c === null) return null;

  if (t === "ink") {
    const kind = raw.kind;
    if (typeof kind !== "string" || !INK_KINDS.has(kind)) return null;
    const w = raw.w;
    if (!isStrokeWidth(w)) return null;
    const o = opacityOf(raw.o);
    if (o === null) return null;
    if (decodePdfPoints(raw.p, Math.min(maxPoints, PDF_STROKE_MAX_POINTS)) === null) return null;
    return { id, t, kind: kind as "pen" | "pencil" | "marker", c, w, o, p: raw.p as string };
  }

  if (t === "highlight") {
    const o = opacityOf(raw.o);
    if (o === null) return null;
    const rects = raw.rects;
    if (!Array.isArray(rects) || rects.length === 0 || rects.length > PDF_HIGHLIGHT_MAX_RECTS)
      return null;
    const out: [number, number, number, number][] = [];
    for (const r of rects as unknown[]) {
      if (!Array.isArray(r) || r.length !== 4) return null;
      const [x, y, w, h] = r as unknown[];
      if (!isCoord(x) || !isCoord(y) || !isExtent(w) || !isExtent(h)) return null;
      out.push([x, y, w, h]);
    }
    return { id, t, c, o, rects: out };
  }

  if (SHAPE_KINDS.has(t)) {
    const w = raw.w;
    if (!isStrokeWidth(w)) return null;
    const a = pairOf(raw.a);
    const b = pairOf(raw.b);
    if (!a || !b) return null;
    return { id, t: t as "line" | "rect" | "ellipse" | "arrow", c, w, a, b };
  }
  return null;
}

/** A form value: string (<= 20k chars), boolean, or <= 500 strings. A fresh
 *  copy, or null. */
export function sanitizePdfFormValue(v: unknown): PdfFormValue | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= PDF_TEXT_MAX_CHARS ? v : null;
  if (!Array.isArray(v) || v.length > PDF_FORM_MAX_CHOICES) return null;
  const out: string[] = [];
  for (const s of v as unknown[]) {
    if (typeof s !== "string" || s.length > PDF_TEXT_MAX_CHARS) return null;
    out.push(s);
  }
  return out;
}

/** One untrusted source → a fresh PdfSource, or null. */
export function sanitizePdfSource(raw: unknown): PdfSource | null {
  if (!isRecord(raw)) return null;
  const { id, path, size, mtimeMs, pages } = raw;
  if (!isPdfId(id) || !isPdfFilePath(path) || !isStamp(size) || !isStamp(mtimeMs)) return null;
  if (!isCount(pages, 1, PDF_MAX_PAGES)) return null;
  return { id, path, size, mtimeMs, pages };
}

function isPageSide(v: unknown): v is number {
  return typeof v === "number" && v >= PDF_PAGE_SIDE_MIN && v <= PDF_PAGE_SIDE_MAX;
}

function sanitizePdfPage(raw: unknown, sources: ReadonlyMap<string, PdfSource>): PdfPage | null {
  if (!isRecord(raw)) return null;
  const { id, src, page, w, h } = raw;
  if (!isPdfId(id)) return null;
  const r = raw.rotate;
  const rotate = r === 90 || r === 180 || r === 270 ? r : 0;
  if (src === null) {
    if (!isPageSide(w) || !isPageSide(h)) return null;
    return { id, src: null, page: 0, rotate, w, h };
  }
  if (typeof src !== "string") return null;
  const source = sources.get(src);
  if (!source || !isCount(page, 0, source.pages - 1)) return null;
  return { id, src, page, rotate };
}

/**
 * Rebuild an untrusted `pdf` block (see the section header). `media` is the
 * project's (already sanitized) media list: an image mark must name one of
 * its kind-"image" entries.
 *
 *  - sources: id valid + unique, path a file path (non-empty, no control
 *    characters, not a URL), size/mtime finite >= 0, pages an integer in
 *    1..PDF_MAX_PAGES; at most PDF_MAX_PAGES of them
 *  - pages: id valid + unique; src null (blank: w/h in 1..14400) or a kept
 *    source with `page` an integer within its page count; rotate one of
 *    0/90/180/270, else 0; at most PDF_MAX_PAGES. NONE left → throws
 *    `ProjectFileError`
 *  - annots: only under kept page ids, each mark per `sanitizePdfAnnot`, ids
 *    unique across the document, at most PDF_MAX_ANNOTS_PER_PAGE per page and
 *    PDF_TOTAL_MAX_POINTS ink points in all; an empty list is left out
 *  - forms: only under kept source ids, field ids pdf.js widget ids
 *    (`isPdfFieldId`), values per
 *    `sanitizePdfFormValue`, at most PDF_FORM_MAX_FIELDS per source
 *  - export: absent stays absent; otherwise each flag is true only when it is
 *    literally `true`
 *
 * `annots`, `forms` and every per-source form record are created with
 * `Object.create(null)`, and every read of the raw input goes through an own-
 * property check after the key has passed `isPdfId` / `isPdfFieldId` — a
 * "__proto__" key can
 * neither be read through to Object.prototype nor written onto one.
 */
export function sanitizePdfMeta(raw: unknown, media: readonly MediaRef[] = []): PdfMeta {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};

  const sources: PdfSource[] = [];
  const byId = new Map<string, PdfSource>();
  if (Array.isArray(src.sources)) {
    for (const s of src.sources as unknown[]) {
      if (sources.length >= PDF_MAX_PAGES) break;
      const clean = sanitizePdfSource(s);
      if (!clean || byId.has(clean.id)) continue;
      byId.set(clean.id, clean);
      sources.push(clean);
    }
  }

  const pages: PdfPage[] = [];
  const pageIds = new Set<string>();
  if (Array.isArray(src.pages)) {
    for (const pg of src.pages as unknown[]) {
      if (pages.length >= PDF_MAX_PAGES) break;
      const clean = sanitizePdfPage(pg, byId);
      if (!clean || pageIds.has(clean.id)) continue;
      pageIds.add(clean.id);
      pages.push(clean);
    }
  }
  if (pages.length === 0) {
    throw new ProjectFileError("This PDF project is damaged: it has no page that can be opened.");
  }

  const imageMedia = new Set<string>();
  for (const m of media) if (m.kind === "image" && !m.generator) imageMedia.add(m.id);

  const annots = Object.create(null) as Record<string, PdfAnnot[]>;
  const rawAnnots = isRecord(src.annots) ? src.annots : null;
  if (rawAnnots) {
    const annotIds = new Set<string>();
    let points = 0;
    for (const page of pages) {
      if (!hasOwn(rawAnnots, page.id)) continue;
      const list = rawAnnots[page.id];
      if (!Array.isArray(list)) continue;
      const kept: PdfAnnot[] = [];
      for (const r of list as unknown[]) {
        if (kept.length >= PDF_MAX_ANNOTS_PER_PAGE) break;
        const a = sanitizePdfAnnot(r, imageMedia, PDF_TOTAL_MAX_POINTS - points);
        if (!a || annotIds.has(a.id)) continue;
        points += pdfAnnotPointCount(a);
        annotIds.add(a.id);
        kept.push(a);
      }
      if (kept.length > 0) annots[page.id] = kept;
    }
  }

  const forms = Object.create(null) as Record<string, Record<string, PdfFormValue>>;
  const rawForms = isRecord(src.forms) ? src.forms : null;
  if (rawForms) {
    for (const s of sources) {
      if (!hasOwn(rawForms, s.id)) continue;
      const rec = rawForms[s.id];
      if (!isRecord(rec)) continue;
      const out = Object.create(null) as Record<string, PdfFormValue>;
      let n = 0;
      for (const key of Object.keys(rec)) {
        if (n >= PDF_FORM_MAX_FIELDS) break;
        if (!isPdfFieldId(key)) continue;
        const v = sanitizePdfFormValue(rec[key]);
        if (v === null) continue;
        out[key] = v;
        n++;
      }
      if (n > 0) forms[s.id] = out;
    }
  }

  const meta: PdfMeta = { sources, pages, annots, forms };
  const ex = src.export;
  if (isRecord(ex)) {
    const e: PdfExportPreset = {
      flattenMarks: ex.flattenMarks === true,
      flattenForms: ex.flattenForms === true,
    };
    meta.export = e;
  }
  return meta;
}

/** The timeline every PDF project carries: no time, no clips — the shape is
 *  shared with video projects and the Rust loader types it. 1920×1080 at 30/1
 *  so the video canvas rule (even, 16..8192) holds unchanged: no PDF branch
 *  is needed in the canvas repair or its invariant. */
export function emptyPdfTimeline(trackId: string = uid()): Timeline {
  return {
    fps: { num: 30, den: 1 },
    width: 1920,
    height: 1080,
    tracks: [{ id: trackId, kind: "video", name: "Video", muted: false, clips: [] }],
  };
}

/** True when `t` is a well-formed timeline with no clips and no markers. */
function isEmptyTimeline(t: unknown): boolean {
  if (!isRecord(t)) return false;
  const fps = t.fps;
  if (!isRecord(fps) || (sanitizeFps(fps as unknown as Rational) as unknown) !== fps) return false;
  for (const side of [t.width, t.height]) {
    if (!isCount(side, MIN_CANVAS, MAX_CANVAS) || side % 2 !== 0) return false;
  }
  const tracks = t.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return false;
  for (const tr of tracks as unknown[]) {
    if (!isRecord(tr) || typeof tr.id !== "string" || typeof tr.name !== "string") return false;
    if (tr.kind !== "video" && tr.kind !== "audio") return false;
    if (typeof tr.muted !== "boolean") return false;
    if (!Array.isArray(tr.clips) || tr.clips.length !== 0) return false;
  }
  if ((tracks[0] as Track).kind !== "video") return false;
  const markers = t.markers;
  return markers === undefined || (Array.isArray(markers) && markers.length === 0);
}

/** A media row a PDF project may keep: a real (not generated) still on disk. */
function isPdfImageMedia(m: unknown): m is MediaRef {
  if (!isRecord(m)) return false;
  if (!isPdfId(m.id) || !isPdfFilePath(m.path) || m.kind !== "image") return false;
  if (m.generator !== undefined || !isStamp(m.size) || !isStamp(m.mtimeMs)) return false;
  for (const side of [m.width, m.height]) {
    if (side !== undefined && !(typeof side === "number" && Number.isFinite(side) && side > 0))
      return false;
  }
  return true;
}

/** The PDF branch of `sanitizeProject`: media → only real stills on disk
 *  (unique ids), `pdf` → `sanitizePdfMeta` (throws when no page survives),
 *  timeline → kept when already the empty one, else `emptyPdfTimeline()`,
 *  `tempEdited` → the same rule as every project. Always a new object. */
function sanitizePdfProject(p: ProjectFile): ProjectFile {
  const rawMedia: unknown = (p as { media?: unknown }).media;
  const media: MediaRef[] = [];
  const mediaIds = new Set<string>();
  if (Array.isArray(rawMedia)) {
    for (const m of rawMedia as unknown[]) {
      if (!isPdfImageMedia(m) || mediaIds.has(m.id)) continue;
      mediaIds.add(m.id);
      media.push(sanitizeMediaRef(m));
    }
  }
  const pdf = sanitizePdfMeta((p as { pdf?: unknown }).pdf, media);
  const timeline = isEmptyTimeline(p.timeline) ? p.timeline : emptyPdfTimeline();
  const out: ProjectFile = { ...p, media, timeline, pdf };
  if ("tempEdited" in p && (p as { tempEdited?: unknown }).tempEdited !== true) {
    delete out.tempEdited;
  }
  return out;
}

/** PDF-project invariants (test-only, like `checkInvariants`, which calls
 *  this for `kind: "pdf"`): exactly what `sanitizePdfMeta` guarantees, plus
 *  schema 4, an empty timeline and image-only media. */
export function checkPdfInvariants(p: ProjectFile): string[] {
  const errors: string[] = [];
  if (p.schema !== 4) errors.push(`pdf project has schema ${p.schema}, expected 4`);
  if (!isEmptyTimeline(p.timeline)) errors.push("pdf project timeline is not the empty one");
  for (const m of p.media as unknown[]) {
    if (!isPdfImageMedia(m)) errors.push(`pdf media ${String((m as MediaRef).id)}: not an image file`);
  }
  const pdf = p.pdf;
  if (!pdf) {
    errors.push("pdf project has no pdf block");
    return errors;
  }
  const sources = new Map<string, PdfSource>();
  for (const s of pdf.sources) {
    if (sources.has(s.id)) errors.push(`source ${s.id}: duplicate id`);
    // only a valid source can vouch for the pages that name it
    if (sanitizePdfSource(s) === null) errors.push(`source ${String(s.id)}: invalid`);
    else if (!sources.has(s.id)) sources.set(s.id, s);
  }
  if (pdf.pages.length < 1) errors.push("pdf project has no pages");
  if (pdf.pages.length > PDF_MAX_PAGES) errors.push(`more than ${PDF_MAX_PAGES} pages`);
  const pageIds = new Set<string>();
  for (const pg of pdf.pages) {
    const clean = sanitizePdfPage(pg, sources);
    if (clean === null || clean.rotate !== pg.rotate) errors.push(`page ${String(pg.id)}: invalid`);
    if (pageIds.has(pg.id)) errors.push(`page ${pg.id}: duplicate id`);
    pageIds.add(pg.id);
  }
  const imageMedia = new Set(p.media.filter((m) => m.kind === "image").map((m) => m.id));
  const annotIds = new Set<string>();
  for (const key of Object.keys(pdf.annots)) {
    if (!pageIds.has(key)) errors.push(`annots keyed by unknown page ${key}`);
    const list: unknown = pdf.annots[key];
    if (!Array.isArray(list)) {
      errors.push(`annots of page ${key}: not a list`);
      continue;
    }
    if (list.length > PDF_MAX_ANNOTS_PER_PAGE) errors.push(`page ${key}: too many marks`);
    for (const a of list as PdfAnnot[]) {
      const clean = sanitizePdfAnnot(a, imageMedia);
      if (clean === null) errors.push(`mark ${String(a.id)}: invalid`);
      else if (a.t === "text" && clean.t === "text") {
        // the optional parts are dropped alone, not with the box
        const lost = (["bg", "border", "edit"] as const).filter((k) => k in a && !(k in clean));
        if (lost.length) errors.push(`mark ${String(a.id)}: invalid ${lost.join(", ")}`);
      }
      if (annotIds.has(a.id)) errors.push(`mark ${a.id}: duplicate id`);
      annotIds.add(a.id);
    }
  }
  for (const key of Object.keys(pdf.forms)) {
    if (!sources.has(key)) errors.push(`forms keyed by unknown source ${key}`);
    const rec: unknown = pdf.forms[key];
    if (!isRecord(rec)) {
      errors.push(`forms of source ${key}: not a record`);
      continue;
    }
    for (const field of Object.keys(rec)) {
      if (!isPdfFieldId(field)) errors.push(`form field ${field}: invalid id`);
      else if (sanitizePdfFormValue(rec[field]) === null)
        errors.push(`form field ${field}: invalid value`);
    }
  }
  return errors;
}

registerPdfProjectHooks({ sanitize: sanitizePdfProject, check: checkPdfInvariants });
