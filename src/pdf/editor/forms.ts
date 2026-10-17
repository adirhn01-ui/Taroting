// Fill forms mode: the "Fill forms" switch in the top bar, the detection that
// decides whether it shows (ctx.hasForms), and Clear form.
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

import "./forms.css";
import type { PdfMeta, ProjectFile } from "../../core/types";
import { settingsStore } from "../../core/session";
import { imgIcon } from "../../image/icons";
import { toast } from "../../ui/toast";
import type { PdfDoc, PdfEditorCtx, PdfEditorHosts, PdfEditorPart } from "../types";

export const FILL_FORMS_LABEL = "Fill forms";
export const FORMS_HINT = "Click a field to type. Tab moves to the next field.";
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

/** "Fill forms (F)", or just the label when the action has no chord. */
function titled(label: string, chord: string | undefined): string {
  return chord ? `${label} (${chord})` : label;
}

/** The forms hint is shown once per app session, not once per editor mount. */
let hintShown = false;
/** Documents (pdf.js proxies) already reported as XFA-only: one toast each,
 *  ever, even across remounts. */
const xfaToasted = new WeakSet<object>();
/** Detection results by pdf.js proxy — a document is asked once. */
const detected = new WeakMap<object, Promise<FormsKind>>();

/** Test hook: forget the once-per-session hint. */
export function resetFormsSessionState(): void {
  hintShown = false;
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

export const formsPart: PdfEditorPart = (ctx: PdfEditorCtx, hosts: PdfEditorHosts) => {
  let disposed = false;
  const cleanups: (() => void)[] = [];

  /* ---------------- UI ---------------- */

  const wrap = document.createElement("div");
  wrap.className = "pdfed-forms";
  wrap.hidden = true;
  wrap.innerHTML = `
    <label class="pdfed-forms__switch">
      <input class="switch" type="checkbox" id="pdfed-fill-forms" />
      <span>${FILL_FORMS_LABEL}</span>
    </label>
    <button class="btn btn--ghost btn--icon btn--sm" id="pdfed-clear-form" hidden></button>
  `;
  hosts.topbar.appendChild(wrap);
  const label = wrap.querySelector<HTMLElement>(".pdfed-forms__switch")!;
  const input = wrap.querySelector<HTMLInputElement>("#pdfed-fill-forms")!;
  const clearBtn = wrap.querySelector<HTMLButtonElement>("#pdfed-clear-form")!;
  input.setAttribute("aria-label", FILL_FORMS_LABEL);
  clearBtn.innerHTML = imgIcon("eraser", 14);
  clearBtn.title = CLEAR_FORM_LABEL;
  clearBtn.setAttribute("aria-label", CLEAR_FORM_LABEL);

  let shownTitle = "";
  function paintTitle(): void {
    const t = titled(FILL_FORMS_LABEL, settingsStore.get().shortcuts?.pdfFillForms);
    if (t === shownTitle) return;
    shownTitle = t;
    label.title = t;
  }

  /** The switch, the clear button and the view's forms layer follow the mode. */
  let appliedOn: boolean | null = null;
  function applyMode(): void {
    const on = ctx.mode.get() === "forms";
    input.checked = on;
    clearBtn.hidden = !on;
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
      if (!hintShown) {
        hintShown = true;
        toast.info(FORMS_HINT);
      }
    }
    ctx.mode.set(on ? "forms" : "annotate");
    applyMode();
  }

  const onChange = (): void => setMode(input.checked);
  input.addEventListener("change", onChange);
  // Same as the inspector's switches: a mouse click must not leave the switch
  // focused, or a later Space would flip it.
  const onClick = (e: Event): void => {
    if ((e as MouseEvent).detail > 0) input.blur();
  };
  input.addEventListener("click", onClick);

  const onClear = (): void => {
    const before = ctx.session.project;
    ctx.session.commit(clearAllFormValues);
    const after = ctx.session.project;
    if (after === before) return;
    // The forms bridge re-seeds on render and drops the values the project
    // no longer has; every page with a widget must render again.
    for (const pg of after.pdf?.pages ?? []) ctx.view.invalidate(pg.id);
  };
  clearBtn.addEventListener("click", onClear);
  cleanups.push(() => {
    input.removeEventListener("change", onChange);
    input.removeEventListener("click", onClick);
    clearBtn.removeEventListener("click", onClear);
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
      wrap.hidden = !has;
      if (!has && ctx.mode.get() === "forms") setMode(false);
    }),
  );
  let lastShortcuts = settingsStore.get().shortcuts;
  cleanups.push(
    settingsStore.subscribe((st) => {
      if (st.shortcuts === lastShortcuts) return;
      lastShortcuts = st.shortcuts;
      paintTitle();
    }),
  );

  // Off every time the editor opens (transient).
  ctx.mode.set("annotate");
  wrap.hidden = !ctx.hasForms.get();
  paintTitle();
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
      wrap.remove();
    },
  };
};
