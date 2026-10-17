// Form values between the project and pdf.js. pdf.js keeps typed values in the
// document's annotationStorage (keyed by widget annotation id, e.g. "12R") and
// paints them from there — the HTML widgets of the forms layer read it, and
// the canvas (AnnotationMode.ENABLE_STORAGE) draws it when the layer is off.
// So the bridge is two-way and small:
//   - seed: before a page renders, every widget the project has a value for
//     is written into storage (nothing is reported back for that write);
//   - report: a value pdf.js stores while a user input/change event is being
//     dispatched inside a forms layer goes to `forms.set`, normalised to
//     PdfFormValue (text → string, checkbox/radio → boolean, choice → the
//     selected export values).
// pdf.js's own render-time writes (a checkbox's "Off" turned into false) are
// not user edits and are never reported.

import type { PdfFormValue } from "../../core/types";
import type { PdfDoc } from "../types";

export interface FormsBackend {
  get(docId: string, annotId: string): PdfFormValue | undefined;
  set(docId: string, annotId: string, value: PdfFormValue): void;
}

/** The fields of a pdf.js widget annotation the bridge looks at. */
export interface WidgetLite {
  id: string;
  subtype?: string;
  fieldType?: string;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  multiSelect?: boolean;
}

interface StorageLike {
  setValue(key: string, value: object): void;
  getRawValue(key: string): unknown;
  remove(key: string): void;
}

type Kind = "text" | "toggle" | "choice";

export function widgetKind(a: WidgetLite): Kind | null {
  if (a.subtype !== "Widget") return null;
  if (a.fieldType === "Tx") return "text";
  if (a.fieldType === "Ch") return "choice";
  if (a.fieldType === "Btn" && !a.pushButton && (a.checkBox || a.radioButton)) return "toggle";
  return null;
}

/** pdf.js storage value → PdfFormValue (undefined = not a value we keep). */
export function fromStorage(kind: Kind, raw: unknown): PdfFormValue | undefined {
  if (kind === "toggle") return typeof raw === "boolean" ? raw : undefined;
  if (kind === "text") return typeof raw === "string" ? raw : raw == null ? "" : undefined;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw === "string") return [raw];
  return raw == null ? [] : undefined;
}

/** PdfFormValue → what pdf.js stores for that widget. */
export function toStorage(kind: Kind, v: PdfFormValue, multi: boolean): unknown {
  if (kind === "toggle") return v === true;
  if (kind === "text") return typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : "";
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return multi ? arr : (arr[0] ?? null);
}

interface Hook {
  storage: StorageLike;
  kinds: Map<string, Kind>;
  /** > 0 while a user input event is being dispatched in a forms layer */
  editing: number;
  /** > 0 while the bridge itself writes (seeding) */
  seeding: number;
  backend: FormsBackend | null;
  docId: string;
  last: Map<string, string>;
}

const hooks = new WeakMap<object, Hook>();

function sameValue(a: PdfFormValue | undefined, b: PdfFormValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The bridge for one document (installed once; the latest backend wins). */
export function formsBridge(doc: PdfDoc, backend: FormsBackend): {
  seed(widgets: readonly WidgetLite[]): void;
  /** wrap a user event dispatch: storage writes inside it are reported */
  userEvent(): void;
} {
  const proxy = doc.doc as { annotationStorage: StorageLike };
  let hook = hooks.get(proxy);
  if (!hook) {
    const storage = proxy.annotationStorage;
    const h: Hook = {
      storage,
      kinds: new Map(),
      editing: 0,
      seeding: 0,
      backend: null,
      docId: doc.id,
      last: new Map(),
    };
    const orig = storage.setValue.bind(storage);
    storage.setValue = (key: string, value: object): void => {
      orig(key, value);
      if (h.seeding > 0 || h.editing === 0 || !h.backend || !("value" in value)) return;
      const kind = h.kinds.get(key);
      if (!kind) return;
      const raw = (storage.getRawValue(key) as { value?: unknown } | undefined)?.value;
      const v = fromStorage(kind, raw);
      if (v === undefined) return;
      const before = h.backend.get(h.docId, key);
      h.last.set(key, JSON.stringify(v));
      if (sameValue(before, v)) return;
      h.backend.set(h.docId, key, v);
    };
    hooks.set(proxy, h);
    hook = h;
  }
  const h = hook;
  h.backend = backend;
  h.docId = doc.id;

  return {
    seed(widgets): void {
      h.seeding++;
      try {
        for (const w of widgets) {
          const kind = widgetKind(w);
          if (!kind) continue;
          h.kinds.set(w.id, kind);
          const v = backend.get(doc.id, w.id);
          if (v === undefined) {
            // the project dropped a value this bridge had written (undo):
            // back to the document's own
            if (h.last.delete(w.id)) h.storage.remove(w.id);
            continue;
          }
          const key = JSON.stringify(v);
          // only when it differs from what this bridge last wrote, so a value
          // the user just typed is not written back over itself on re-render
          if (h.last.get(w.id) === key && h.storage.getRawValue(w.id) !== undefined) continue;
          h.last.set(w.id, key);
          h.storage.setValue(w.id, { value: toStorage(kind, v, w.multiSelect === true) });
        }
      } finally {
        h.seeding--;
      }
    },
    userEvent(): void {
      // Closed on a TIMER, never a microtask: a real input event runs a
      // microtask checkpoint after every listener, so a microtask would close
      // the window before pdf.js's own listener (on the widget, after this
      // capture listener) writes the value.
      h.editing++;
      setTimeout(() => {
        h.editing--;
      }, 0);
    },
  };
}
