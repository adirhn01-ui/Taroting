import { describe, expect, it } from "vitest";
import type { PdfFormValue } from "../../core/types";
import type { PdfDoc } from "../types";
import { formsBridge, fromStorage, toStorage, widgetKind, type WidgetLite } from "./forms";
import { fixture, hasFixtures, testLoader } from "./fixtures.test-util";

/** pdf.js's AnnotationStorage, as far as the bridge uses it. */
class FakeStorage {
  map = new Map<string, Record<string, unknown>>();
  setValue(key: string, value: Record<string, unknown>): void {
    this.map.set(key, { ...(this.map.get(key) ?? {}), ...value });
  }
  getRawValue(key: string): unknown {
    return this.map.get(key);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

function backend(initial: Record<string, PdfFormValue> = {}) {
  const values = new Map(Object.entries(initial));
  const sets: [string, string, PdfFormValue][] = [];
  return {
    values,
    sets,
    get: (_d: string, id: string): PdfFormValue | undefined => values.get(id),
    set: (d: string, id: string, v: PdfFormValue): void => {
      sets.push([d, id, v]);
      values.set(id, v);
    },
  };
}

const W = (id: string, extra: Partial<WidgetLite>): WidgetLite => ({ id, subtype: "Widget", ...extra });
const widgets: WidgetLite[] = [
  W("1R", { fieldType: "Tx" }),
  W("2R", { fieldType: "Btn", checkBox: true }),
  W("3R", { fieldType: "Ch", multiSelect: false }),
  W("4R", { fieldType: "Btn", pushButton: true }),
  { id: "5R", subtype: "Link" },
];

const fakeDoc = (storage: FakeStorage): PdfDoc =>
  ({ id: "src1", path: "x.pdf", doc: { annotationStorage: storage }, numPages: 1 }) as unknown as PdfDoc;

describe("form value conversion", () => {
  it("classifies widgets", () => {
    expect(widgets.map(widgetKind)).toEqual(["text", "toggle", "choice", null, null]);
  });
  it("normalises pdf.js values to PdfFormValue and back", () => {
    expect(fromStorage("choice", "M")).toEqual(["M"]);
    expect(fromStorage("choice", null)).toEqual([]);
    expect(fromStorage("choice", ["a", "b"])).toEqual(["a", "b"]);
    expect(fromStorage("toggle", "Off")).toBeUndefined();
    expect(fromStorage("text", "hi")).toBe("hi");
    expect(toStorage("choice", ["M"], false)).toBe("M");
    expect(toStorage("choice", ["a", "b"], true)).toEqual(["a", "b"]);
    expect(toStorage("toggle", true, false)).toBe(true);
  });
});

describe("the forms bridge", () => {
  it("seeds storage from the project before render, without reporting it", () => {
    const storage = new FakeStorage();
    const b = backend({ "1R": "Ada", "2R": true, "3R": ["L"] });
    formsBridge(fakeDoc(storage), b).seed(widgets);
    expect(storage.map.get("1R")).toEqual({ value: "Ada" });
    expect(storage.map.get("2R")).toEqual({ value: true });
    expect(storage.map.get("3R")).toEqual({ value: "L" });
    expect(storage.map.has("4R")).toBe(false);
    expect(b.sets).toEqual([]);
  });

  it("reports values stored during a user event, normalised", async () => {
    const storage = new FakeStorage();
    const b = backend();
    const bridge = formsBridge(fakeDoc(storage), b);
    bridge.seed(widgets);
    bridge.userEvent();
    storage.setValue("1R", { value: "Grace" });
    storage.setValue("3R", { value: "S" });
    storage.setValue("2R", { value: true });
    storage.setValue("1R", { formattedValue: "x" }); // not a value change
    expect(b.sets).toEqual([
      ["src1", "1R", "Grace"],
      ["src1", "3R", ["S"]],
      ["src1", "2R", true],
    ]);
    // A real input event runs a microtask checkpoint between listeners: a
    // write by pdf.js's own widget listener, after microtasks have drained,
    // is still the user's edit (this was lost when the window closed on a
    // microtask — found by typing into a form in the browser).
    await Promise.resolve();
    await Promise.resolve();
    storage.setValue("2R", { value: false });
    expect(b.sets).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 0));
    // after the event's task (pdf.js's own render-time writes): not reported
    storage.setValue("2R", { value: true });
    expect(b.sets).toHaveLength(4);
  });

  it("doesn't report a value equal to the project's", () => {
    const storage = new FakeStorage();
    const b = backend({ "1R": "same" });
    const bridge = formsBridge(fakeDoc(storage), b);
    bridge.seed(widgets);
    bridge.userEvent();
    storage.setValue("1R", { value: "same" });
    expect(b.sets).toEqual([]);
  });

  it("an undone value goes back to the document's own", () => {
    const storage = new FakeStorage();
    const b = backend({ "1R": "typed" });
    const bridge = formsBridge(fakeDoc(storage), b);
    bridge.seed(widgets);
    b.values.delete("1R");
    bridge.seed(widgets);
    expect(storage.map.has("1R")).toBe(false);
  });
});

describe.skipIf(!hasFixtures)("the forms bridge on a real AcroForm", () => {
  it("seeds and reports through pdf.js's annotationStorage", async () => {
    const doc = await testLoader().openPdf("form", fixture("form_acro.pdf"));
    const page = await (doc.doc as { getPage(n: number): Promise<{ getAnnotations(): Promise<WidgetLite[]> }> }).getPage(1);
    const annots = await page.getAnnotations();
    const byName = new Map(annots.map((a) => [(a as { fieldName?: string }).fieldName, a.id]));
    const nameId = byName.get("name")!;
    const agreeId = byName.get("agree")!;
    const b = backend({ [nameId]: "Ada" });
    const bridge = formsBridge(doc, b);
    bridge.seed(annots);
    const storage = (doc.doc as { annotationStorage: { getRawValue(k: string): { value: unknown } | undefined; setValue(k: string, v: object): void } }).annotationStorage;
    expect(storage.getRawValue(nameId)?.value).toBe("Ada");
    bridge.userEvent();
    storage.setValue(agreeId, { value: true });
    expect(b.sets).toEqual([["form", agreeId, true]]);
    await doc.destroy();
  });
});
