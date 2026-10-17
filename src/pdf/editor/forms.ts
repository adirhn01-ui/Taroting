// Fill forms mode: the mode itself, the detection that decides whether it can
// come on (ctx.hasForms), Clear form, and the F key. The SWITCH lives in the
// inspector (inspector.ts, "Document" — the image editor's switch field, as
// the owner asked); it calls setFillForms / clearForm here, so this module
// stays the one owner of what the mode does.
//
// The owner's words: "an option to turn on form filling, like a click slider
// with the option to turn on or off form filling … its like a mode in pdf
// editing". So it is a MODE (ctx.mode), not a tool: while it is on, pdf.js's
// form widgets own the pointer (the view's forms layer) and the annotation
// tools are disabled (the tools part reads ctx.mode). Typed values reach the
// project through the view's forms get/set, which the shell wires to the
// session — nothing here touches a value except Clear form.
//
// Zero cost at rest: detection runs once per document, lazily, after the
// first page has painted (or on idle), and caches its answer by document.
// No timer, no frame loop.

import type { PdfMeta, ProjectFile } from "../../core/types";
import { toast } from "../../ui/toast";
import type { PdfDoc, PdfEditorCtx, PdfEditorPart } from "../types";

export const FILL_FORMS_LABEL = "Fill forms";
/** The tip under the switch while the mode is on. */
export const FORMS_TIP = "Click a field to type. Tab moves to the next one.";
/** The note beside a disabled switch (so it is always findable). */
export const NO_FIELDS_NOTE = "This PDF has no fillable fields.";
export const XFA_TOAST = "This PDF uses an older form type (XFA) that Taroting can't fill.";
export const CLEAR_FORM_LABEL = "Clear form";

/** What a document offers for Fill forms. */
export type FormsKind = "fields" | "xfa" | "none";

/** The slice of pdf.js's PDFDocumentProxy detection reads. */
interface FormsProbeDoc {
  getFieldObjects?(): Promise<unknown>;
  isPureXfa?: boolean;
  getMetadata?(): Promise<{ info?: unknown }>;
}

/** Does pdf.js's getFieldObjects() answer name any field? (pdf.js 6 answers
 *  a Map; older builds a plain object; null = no AcroForm.) */
export function hasFieldObjects(fields: unknown): boolean {
  if (!fields || typeof fields !== "object") return false;
  if (fields instanceof Map) return fields.size > 0;
  return Object.keys(fields).length > 0;
}

/**
 * What a document's form is. Fillable AcroForm fields win (a hybrid
 * XFA + AcroForm document is filled through its AcroForm half). With no
 * fields, an XFA form is reported so the user hears why nothing is fillable:
 * the app opens documents with `enableXfa: false`, where pdf.js's
 * `isPureXfa` stays false, so the document info's IsXFAPresent is asked too.
 * Any failure reads as "none" — detection must never break the editor.
 */
export async function detectForms(doc: unknown): Promise<FormsKind> {
  const d = doc as FormsProbeDoc | null;
  if (!d) return "none";
  try {
    if (typeof d.getFieldObjects === "function" && hasFieldObjects(await d.getFieldObjects())) return "fields";
  } catch {
    // a broken AcroForm is not a fillable one
  }
  try {
    if (d.isPureXfa === true) return "xfa";
    if (typeof d.getMetadata === "function") {
      const info = (await d.getMetadata())?.info as { IsXFAPresent?: unknown } | undefined;
      if (info?.IsXFAPresent === true) return "xfa";
    }
  } catch {
    // no metadata: nothing to say
  }
  return "none";
}

/** Every form value of the project cleared, as ONE new project (one history
 *  step); the project itself when there is nothing to clear (no step). */
export function clearAllFormValues(p: ProjectFile): ProjectFile {
  if (p.kind !== "pdf" || !p.pdf) return p;
  const forms = p.pdf.forms;
  const any = Object.keys(forms).some((k) => Object.keys(forms[k] ?? {}).length > 0);
  if (!any) return p;
  const pdf: PdfMeta = { ...p.pdf, forms: Object.create(null) as PdfMeta["forms"] };
  return { ...p, pdf };
}

/** Documents (pdf.js proxies) already reported as XFA-only: one toast each,
 *  ever, even across remounts. */
const xfaToasted = new WeakSet<object>();
/** Detection results by pdf.js proxy — a document is asked once. */
const detected = new WeakMap<object, Promise<FormsKind>>();

/** Each mounted editor's mode controls (the inspector's switch calls them). */
const controls = new WeakMap<PdfEditorCtx, { setMode(on: boolean): void; clear(): void }>();

/** Turn Fill forms mode on or off (refused on while the PDF has no fields). */
export function setFillForms(ctx: PdfEditorCtx, on: boolean): void {
  controls.get(ctx)?.setMode(on);
}

/** Clear every form value: one history step, the pages re-rendered. */
export function clearForm(ctx: PdfEditorCtx): void {
  controls.get(ctx)?.clear();
}

type IdleHandle = { cancel(): void };

function onIdle(fn: () => void, timeout: number): IdleHandle {
  const w = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout });
    return { cancel: () => w.cancelIdleCallback?.(id) };
  }
  const id = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(id) };
}

export const formsPart: PdfEditorPart = (ctx: PdfEditorCtx) => {
  let disposed = false;
  const cleanups: (() => void)[] = [];

  /* ---------------- the mode ---------------- */

  /** The view's forms layer follows the mode. */
  let appliedOn: boolean | null = null;
  function applyMode(): void {
    const on = ctx.mode.get() === "forms";
    if (on === appliedOn) return;
    appliedOn = on;
    ctx.view.setFormsLayer(on);
  }

  function setMode(on: boolean): void {
    if (disposed) return;
    if (on && !ctx.hasForms.get()) on = false;
    const was = ctx.mode.get() === "forms";
    if (on === was) {
      applyMode();
      return;
    }
    if (on) {
      // End whatever the annotation tools were doing: a selection or a text
      // box being typed in must not survive into a mode where they can't act.
      ctx.selection.set([]);
      if (ctx.tools.get().tool !== "select") ctx.tools.update((s) => ({ ...s, tool: "select" }));
    }
    ctx.mode.set(on ? "forms" : "annotate");
    applyMode();
  }

  function clear(): void {
    if (disposed) return;
    const before = ctx.session.project;
    ctx.session.commit(clearAllFormValues);
    const after = ctx.session.project;
    if (after === before) return;
    // The forms bridge re-seeds on render and drops the values the project
    // no longer has; every page with a widget must render again.
    for (const pg of after.pdf?.pages ?? []) ctx.view.invalidate(pg.id);
  }

  controls.set(ctx, { setMode, clear });
  cleanups.push(() => {
    if (controls.get(ctx)?.setMode === setMode) controls.delete(ctx);
  });

  cleanups.push(
    ctx.bindKey("pdfFillForms", (e) => {
      if (ctx.isTyping(e.target)) return;
      if (!ctx.hasForms.get()) return;
      e.preventDefault();
      setMode(ctx.mode.get() !== "forms");
    }),
  );

  cleanups.push(ctx.mode.subscribe(() => applyMode()));
  cleanups.push(
    ctx.hasForms.subscribe((has) => {
      if (!has && ctx.mode.get() === "forms") setMode(false);
    }),
  );

  // Off every time the editor opens (transient).
  ctx.mode.set("annotate");
  applyMode();

  /* ---------------- detection ---------------- */

  const kinds = new Map<PdfDoc, FormsKind>();
  let idle: IdleHandle | null = null;
  let scanning = false;
  let rescan = false;

  function recompute(): void {
    let any = false;
    for (const doc of ctx.docs.values()) if (kinds.get(doc) === "fields") any = true;
    if (ctx.hasForms.get() !== any) ctx.hasForms.set(any);
  }

  async function scan(): Promise<void> {
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescan = false;
        for (const doc of [...ctx.docs.values()]) {
          if (disposed) return;
          if (kinds.has(doc)) continue;
          const proxy = doc.doc as object | null;
          let kind: FormsKind = "none";
          if (proxy && typeof proxy === "object") {
            let p = detected.get(proxy);
            if (!p) {
              p = detectForms(proxy);
              detected.set(proxy, p);
            }
            kind = await p;
          }
          if (disposed) return;
          kinds.set(doc, kind);
          if (kind === "xfa" && proxy && !xfaToasted.has(proxy)) {
            xfaToasted.add(proxy);
            toast.info(XFA_TOAST);
          }
        }
        // a document the shell closed is forgotten
        for (const doc of [...kinds.keys()]) {
          if (![...ctx.docs.values()].includes(doc)) kinds.delete(doc);
        }
        recompute();
      } while (rescan && !disposed);
    } finally {
      scanning = false;
    }
  }

  function scheduleScan(): void {
    if (disposed || idle) return;
    idle = onIdle(() => {
      idle = null;
      void scan();
    }, 1500);
  }

  // After the first page has painted — detection is never on the path to
  // the first picture.
  let firstPaint: (() => void) | null = ctx.view.on("pagerendered", () => {
    firstPaint?.();
    firstPaint = null;
    scheduleScan();
  });
  cleanups.push(() => {
    firstPaint?.();
    firstPaint = null;
  });

  // The shell may open more sources later (pages inserted from another PDF):
  // a sources change asks again; known documents answer from the cache.
  let lastSources = ctx.session.project.pdf?.sources;
  cleanups.push(
    ctx.session.store.subscribe((p) => {
      const s = p.pdf?.sources;
      if (s === lastSources) return;
      lastSources = s;
      if (!firstPaint) scheduleScan();
    }),
  );

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      idle?.cancel();
      idle = null;
      for (const c of cleanups.splice(0)) c();
      if (ctx.mode.get() === "forms") {
        ctx.mode.set("annotate");
        ctx.view.setFormsLayer(false);
      }
    },
  };
};
