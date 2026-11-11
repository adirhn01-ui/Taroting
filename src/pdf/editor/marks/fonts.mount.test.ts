// PDF text boxes with a non-legacy font (0.9.4 font library): the inspector's
// shared picker writes the fields per the seam, Bold / Italic follow the
// family's real faces, and the preview names the runtime's alias first with
// the legacy font after it. The font runtime (src/fonts) is faked: its real
// body belongs to another package.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFaceInfo, FontFamily, FontId, PdfAnnot } from "../../../core/types";
import { DEFAULT_SETTINGS } from "../../../core/types";
import { pageAnnots } from "../../model";
import { FakeElement, FakeEvent, makeKit, project, showPages, type Kit } from "./testkit.test-util";

type Pick = { legacy: FontFamily; fontId?: FontId };
const f = vi.hoisted(() => ({
  ready: true,
  missing: false,
  faces: null as FontFaceInfo[] | null,
  pickers: [] as { host: unknown; value(): Pick; onPick(v: Pick): void }[],
  faceCalls: 0,
  ensureCalls: [] as unknown[],
  release: null as null | (() => void),
}));
vi.mock("../../../fonts", () => ({
  ensureFonts: (reqs: unknown) => {
    f.ensureCalls.push(reqs);
    return new Promise<void>((r) => {
      f.release = () => {
        f.ready = true;
        r();
      };
      if (f.ready) r();
    });
  },
  fontsReady: () => f.ready,
  fontFace: (legacy: string, _id: string, bold: boolean, italic: boolean) => {
    f.faceCalls++;
    return f.missing ? { family: legacy, bold, italic, missing: true } : { family: "tf-alias", bold, italic: false, missing: false };
  },
  facesOf: () => f.faces,
  onFontsChanged: () => () => {},
  mountFontPicker: (host: unknown, opts: { value(): Pick; onPick(v: Pick): void }) => {
    f.pickers.push({ host, ...opts });
    return { refresh() {}, dispose() {} };
  },
}));
vi.mock("../../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {} } }));
vi.mock("../../../core/session", async (orig) => {
  const real = await orig<typeof import("../../../core/session")>();
  return { ...real, updateSettings: vi.fn(async () => {}) };
});

const { settingsStore } = await import("../../../core/session");
const { toolsPart, toolStyleOf } = await import("../tools");
const { inspectorPart } = await import("../inspector");
const { styleTextBox, textNode, setTextMeasurer } = await import("./render");

type Text = Extract<PdfAnnot, { t: "text" }>;
const text = (extra: Partial<Text> = {}): PdfAnnot => ({
  id: "t", t: "text", x: 100, y: 100, w: 120, h: 30, text: "hello", font: "Arial", size: 12, c: "#000000", bold: false, italic: false, align: "left", ...extra,
});

let kit: Kit;
let parts: { dispose(): void }[] = [];
async function mount(p = project()): Promise<void> {
  kit = makeKit(p);
  parts = [toolsPart(kit.ctx, kit.hosts), inspectorPart(kit.ctx, kit.hosts)];
  showPages(kit);
  await kit.flush();
}
const marks = (): readonly PdfAnnot[] => pageAnnots(kit.session.project, "P1");
const insp = (): FakeElement => kit.hosts.inspector as unknown as FakeElement;
/** the picker the inspector shows now */
const picker = () => f.pickers[f.pickers.length - 1]!;
const button = (label: string): FakeElement => insp().querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label)!;

beforeEach(() => {
  f.ready = true;
  f.missing = false;
  f.faces = null;
  f.pickers.length = 0;
  f.faceCalls = 0;
  f.ensureCalls.length = 0;
  settingsStore.set({ ...DEFAULT_SETTINGS, inkColors: [], pdfToolStyle: {} });
});
afterEach(() => {
  for (const p of parts.splice(0)) p.dispose();
  vi.unstubAllGlobals();
});

describe("the inspector's font picker", () => {
  it("a new box: a library pick writes fontId over Segoe UI; a legacy pick takes fontId off; the Text tool follows", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    kit.pointer("pointerdown", 100, 100);
    await kit.flush();
    expect(kit.ctx.textEdit.get()?.draft).toBeTruthy();
    picker().onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    expect(kit.ctx.textEdit.get()!.draft).toMatchObject({ font: "Segoe UI", fontId: "lib:Inter" });
    expect(kit.ctx.tools.get()).toMatchObject({ font: "Segoe UI", fontId: "lib:Inter" });
    expect(picker().value()).toStrictEqual({ legacy: "Segoe UI", fontId: "lib:Inter" });
    picker().onPick({ legacy: "Georgia" });
    const d = kit.ctx.textEdit.get()!.draft!;
    expect(d.font).toBe("Georgia");
    expect("fontId" in d).toBe(false);
    expect("fontId" in kit.ctx.tools.get()).toBe(false);
    expect(kit.ctx.tools.get().font).toBe("Georgia");
  });

  it("the Text tool's own picker: fontId in the tool state and in what Settings remembers", async () => {
    await mount();
    kit.ctx.tools.update((s) => ({ ...s, tool: "text" }));
    await kit.flush();
    picker().onPick({ legacy: "Segoe UI", fontId: "Consolas" });
    expect(kit.ctx.tools.get()).toMatchObject({ font: "Segoe UI", fontId: "Consolas" });
    expect(toolStyleOf(kit.ctx.tools.get())).toMatchObject({ font: "Segoe UI", fontId: "Consolas" });
    picker().onPick({ legacy: "Impact" });
    expect(kit.ctx.tools.get().font).toBe("Impact");
    expect("fontId" in kit.ctx.tools.get()).toBe(false);
    expect("fontId" in toolStyleOf(kit.ctx.tools.get())).toBe(false);
  });

  it("a selected box that has a fontId: another library pick lands as one step", async () => {
    await mount(project({ P1: [text({ font: "Segoe UI", fontId: "lib:Inter" })] }));
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    expect(picker().value()).toStrictEqual({ legacy: "Segoe UI", fontId: "lib:Inter" });
    picker().onPick({ legacy: "Segoe UI", fontId: "lib:Lato" });
    expect(marks()[0]).toMatchObject({ font: "Segoe UI", fontId: "lib:Lato" });
    expect(kit.session.steps).toBe(1);
    // a legacy pick lands its font and takes the fontId key off the mark
    picker().onPick({ legacy: "Georgia" });
    expect(marks()[0]).toMatchObject({ font: "Georgia" });
    expect("fontId" in marks()[0]!).toBe(false);
  });
});

describe("Bold / Italic follow the family's real faces", () => {
  it("a family without a bold face: Bold off and disabled, Italic usable", async () => {
    f.faces = [
      { bold: false, italic: false, weight: 400, style: "Regular", embed: "full" },
      { bold: false, italic: true, weight: 400, style: "Italic", embed: "full" },
    ];
    await mount(project({ P1: [text({ font: "Segoe UI", fontId: "lib:Thin", bold: true })] }));
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    expect(button("Bold").disabled).toBe(true);
    expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
    expect(button("Italic").disabled).toBe(false);
    button("Bold").dispatchEvent(new FakeEvent("click"));
    expect(kit.session.steps).toBe(0);
  });

  it("faces not known yet: the legacy rule (a Segoe UI fallback allows both)", async () => {
    f.faces = null;
    await mount(project({ P1: [text({ font: "Segoe UI", fontId: "lib:Thin" })] }));
    kit.ctx.selection.set([{ key: "P1", id: "t" }]);
    await kit.flush();
    expect(button("Bold").disabled).toBe(false);
    expect(button("Italic").disabled).toBe(false);
  });
});

describe("the preview's font", () => {
  const el = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;

  it("a legacy box: exactly the 0.9.3 family, no runtime call (I1)", () => {
    const e = el();
    styleTextBox(e, text({ font: "Impact", bold: true }) as Text);
    expect(e.style.fontFamily).toBe('"Impact"');
    expect(e.style.fontWeight).toBe("normal");
    expect(f.faceCalls).toBe(0);
    expect(f.ensureCalls).toEqual([]);
  });

  it("a fontId box: the alias first, the legacy font after it, the resolved face", () => {
    const e = el();
    styleTextBox(e, text({ font: "Segoe UI", fontId: "lib:Inter", bold: true, italic: true }) as Text);
    expect(e.style.fontFamily).toBe('tf-alias, "Segoe UI"');
    expect(e.style.fontWeight).toBe("bold");
    expect(e.style.fontStyle).toBe("normal");
  });

  it("a font missing on this PC: the legacy font alone", () => {
    f.missing = true;
    const e = el();
    styleTextBox(e, text({ font: "Georgia", fontId: "lib:Inter" }) as Text);
    expect(e.style.fontFamily).toBe('"Georgia"');
  });

  it("a box whose font is still loading is laid out again once it lands", async () => {
    await mount();
    const seen: string[] = [];
    setTextMeasurer({ width: (font, s) => (seen.push(font), [...s].length * 6) });
    f.ready = false;
    const fo = textNode(text({ font: "Segoe UI", fontId: "lib:Inter", text: "one two" }) as Text) as unknown as FakeElement;
    // on the page, as the layer puts it: a node no longer there is left alone
    new FakeElement("g").appendChild(fo);
    const box = fo.children[0]!;
    const first = box.children[0];
    expect(f.ensureCalls.length).toBeGreaterThan(0);
    f.release!();
    await kit.flush();
    expect(box.children[0]).not.toBe(first);
    expect(seen.every((s) => s.includes('tf-alias, "Segoe UI"'))).toBe(true);
    setTextMeasurer(null);
  });
});
