// Video text with fonts from the library or this PC (0.9.4). The font runtime
// is faked (fonts-fake.test-util): these pin what generators.ts does with it —
// the six legacy fonts never touch it, a non-legacy font is drawn through its
// alias with the legacy name as the fallback, a box is measured only once its
// font is ready, and a project open names the missing fonts once.
//
// Fixture values differ on every axis: the legacy fallback (Segoe UI) is not
// the font picked, sizes differ between tests, and the ready font measures
// 30 px per character against the fallback's 10, so a box measured too early
// is a different number.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../../core/project";
import type { FontFamily, Generator } from "../../core/types";
import { alias, face, fakeDocument, flush, fontsState, type FakeEl } from "./fonts-fake.test-util";

vi.mock("../../fonts", async () => (await import("./fonts-fake.test-util")).fakeFonts);
const notices = vi.hoisted(() => ({ list: [] as string[], info: [] as string[], shared: [] as string[][] }));
// The shared wording (core/font-id), spied on but real: the editor's notice
// must come from it, not from a copy of its own.
vi.mock("../../core/font-id", async (orig) => {
  const real = await orig<typeof import("../../core/font-id")>();
  return {
    ...real,
    missingFontNotice: (ids: readonly string[]) => {
      notices.shared.push([...ids]);
      return real.missingFontNotice(ids);
    },
  };
});
vi.mock("../../ui/toast", () => ({
  toast: {
    info: (m: string) => void notices.info.push(m),
    error: () => {},
    notice: (m: string) => void notices.list.push(m),
  },
}));

const {
  cssFont,
  fontString,
  measureTextWhenReady,
  openGeneratorDialog,
  prepareProjectFonts,
  styleAvailability,
  textFontRequests,
  withFont,
} = await import("./generators");

type TextGen = Extract<Generator, { type: "text" }>;
const LEGACY: FontFamily[] = ["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"];

const gen = (over: Partial<TextGen> = {}): TextGen => ({
  type: "text",
  text: "Hello",
  fontFamily: "Segoe UI",
  sizePx: 40,
  color: "#00ff00",
  bold: true,
  italic: true,
  ...over,
});

beforeEach(() => {
  fontsState.reset();
  notices.list = [];
  notices.info = [];
  notices.shared = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("font strings", () => {
  it("the six keep their 0.9.3 strings byte for byte, with no runtime call", () => {
    for (const fontFamily of LEGACY) {
      for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        const g = gen({ fontFamily, bold, italic, sizePx: 33 });
        const s = italic ? "italic" : "normal";
        const w = bold ? "bold" : "normal";
        expect(cssFont(g)).toBe(`${s} ${w} 33px/1.25 ${fontFamily}`);
        expect(fontString(g)).toBe(`${s} ${w} 33px ${fontFamily}`);
      }
    }
    expect(fontsState.fontFaceCalls).toBe(0);
  });

  it("an ill-shaped fontId is ignored: the legacy string, no runtime call", () => {
    const g = gen({ fontFamily: "Georgia", fontId: " Consolas", bold: false, italic: false });
    expect(cssFont(g)).toBe("normal normal 40px/1.25 Georgia");
    expect(fontsState.fontFaceCalls).toBe(0);
  });

  it("a font still loading names its alias with the legacy fallback and the flags asked for", () => {
    const g = gen({ fontId: "lib:Inter" });
    expect(cssFont(g)).toBe(`italic bold 40px/1.25 ${alias("lib:Inter")}, "Segoe UI"`);
    expect(fontString(g)).toBe(`italic bold 40px ${alias("lib:Inter")}, "Segoe UI"`);
  });

  it("a ready font names its alias with the real face's flags", () => {
    fontsState.ready.add("Consolas");
    fontsState.faces.set("Consolas", [face(false, false), face(false, true)]);
    const g = gen({ fontId: "Consolas", sizePx: 24 });
    // Bold asked for, but Consolas here has no bold face: nothing is faked.
    expect(cssFont(g)).toBe(`italic normal 24px/1.25 ${alias("Consolas")}, "Segoe UI"`);
    expect(fontString(g)).toBe(`italic normal 24px ${alias("Consolas")}, "Segoe UI"`);
  });

  it("a font missing on this PC draws the legacy string exactly", () => {
    fontsState.missing.add("lib:Gone");
    const g = gen({ fontId: "lib:Gone", sizePx: 52 });
    expect(cssFont(g)).toBe("italic bold 52px/1.25 Segoe UI");
    expect(fontString(g)).toBe("italic bold 52px Segoe UI");
  });
});

describe("what a pick stores", () => {
  it("a legacy pick removes fontId entirely", () => {
    const next = withFont(gen({ fontId: "Consolas" }), { legacy: "Arial" });
    expect(next.fontFamily).toBe("Arial");
    expect("fontId" in next).toBe(false);
  });

  it("any other pick sets fontId and the default legacy fallback", () => {
    const next = withFont(gen({ fontFamily: "Impact" }), { legacy: "Segoe UI", fontId: "lib:Inter" });
    expect(next.fontFamily).toBe("Segoe UI");
    expect(next.fontId).toBe("lib:Inter");
  });
});

describe("style switches follow the font's faces", () => {
  it("keeps the Impact rule for the six", () => {
    expect(styleAvailability("Impact", undefined)).toEqual({ bold: false, italic: false });
    expect(styleAvailability("Georgia", undefined)).toEqual({ bold: true, italic: true });
  });

  it("turns Bold off for a family without a bold face, and leaves Italic", () => {
    fontsState.faces.set("Consolas", [face(false, false), face(false, true)]);
    expect(styleAvailability("Segoe UI", "Consolas")).toEqual({ bold: false, italic: true });
  });

  it("leaves both on while the faces are not known yet", () => {
    expect(styleAvailability("Segoe UI", "lib:Unknown")).toEqual({ bold: true, italic: true });
  });
});

describe("measuring waits for the font", () => {
  it("a legacy font measures at once, as the same object", () => {
    const g = gen({ text: "abcd" });
    const out = measureTextWhenReady(g);
    expect(out).not.toBeInstanceOf(Promise);
    expect((out as { gen: TextGen }).gen).toBe(g);
    expect(fontsState.ensureCalls).toEqual([]);
  });

  it("a font not ready yet is awaited, and switches it lacks are turned off", async () => {
    fontsState.late = true;
    fontsState.faces.set("Consolas", [face(false, false)]);
    const out = measureTextWhenReady(gen({ fontId: "Consolas", text: "abcd", bold: true, italic: false }));
    expect(out).toBeInstanceOf(Promise);
    expect(fontsState.ensureCalls).toEqual([[{ id: "Consolas", bold: true, italic: false }]]);
    fontsState.release();
    const done = await out;
    expect(done.gen.bold).toBe(false);
    expect(done.gen.fontId).toBe("Consolas");
  });
});

/* ---------------- the Add text dialog ---------------- */

function openText(onCreate = vi.fn()) {
  const { doc, backdrop } = fakeDocument();
  vi.stubGlobal("document", doc);
  openGeneratorDialog("text", { session: { project: createProject("t") } as never, onCreate });
  const b = backdrop();
  const body = b.querySelector(".gen-body");
  const picker = fontsState.pickers[fontsState.pickers.length - 1]!;
  const switches = (): FakeEl[] => {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => {
      if (e.tag === "input" && e.type === "checkbox") out.push(e);
      for (const c of e.children) walk(c);
    };
    walk(body);
    return out;
  };
  return { b, body, picker, onCreate, switches, add: () => b.querySelector(".gen-footer").button("Add text").fire("click") };
}

describe("the Add text dialog", () => {
  it("stores the box the READY font measures, not the fallback's", async () => {
    fontsState.late = true;
    const d = openText();
    d.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    d.add();
    // The font is still loading: nothing is created yet.
    expect(d.onCreate).not.toHaveBeenCalled();
    fontsState.release();
    await flush();
    expect(d.onCreate).toHaveBeenCalledTimes(1);
    const [g, w] = d.onCreate.mock.calls[0]!;
    // "Title" is 5 characters: 30 px each once Inter is ready (10 in the fallback).
    expect(w).toBe(150);
    expect(g).toMatchObject({ fontFamily: "Segoe UI", fontId: "lib:Inter" });
  });

  it("adds nothing when closed while the font loads", async () => {
    fontsState.late = true;
    const d = openText();
    d.picker.opts.onPick({ legacy: "Segoe UI", fontId: "lib:Inter" });
    d.add();
    d.b.querySelector("[data-close]").fire("click");
    fontsState.release();
    await flush();
    expect(d.onCreate).not.toHaveBeenCalled();
    expect(d.picker.disposed).toBe(true);
  });

  it("a legacy pick after another font stores no fontId", () => {
    const d = openText();
    d.picker.opts.onPick({ legacy: "Segoe UI", fontId: "Consolas" });
    d.picker.opts.onPick({ legacy: "Georgia" });
    d.add();
    const [g] = d.onCreate.mock.calls[0]!;
    expect(g.fontFamily).toBe("Georgia");
    expect("fontId" in g).toBe(false);
  });

  it("disables Bold for a family without a bold face", () => {
    fontsState.faces.set("Consolas", [face(false, false), face(false, true)]);
    const d = openText();
    const [bold, italic] = d.switches();
    bold!.checked = true;
    d.picker.opts.onPick({ legacy: "Segoe UI", fontId: "Consolas" });
    expect(bold!.disabled).toBe(true);
    expect(bold!.checked).toBe(false);
    expect(italic!.disabled).toBe(false);
  });
});

/* ---------------- project open ---------------- */

const media = (...gens: TextGen[]) => gens.map((generator) => ({ generator }));

describe("the missing-font notice on open", () => {
  it("names every missing font once, in one notice", async () => {
    fontsState.missing.add("lib:Inter");
    fontsState.missing.add("Consolas");
    await prepareProjectFonts(
      media(
        gen({ fontId: "lib:Inter" }),
        gen({ fontId: "lib:Inter", bold: false }),
        gen({ fontId: "Consolas" }),
        gen({ fontFamily: "Arial" }),
      ),
      () => false,
    );
    expect(notices.list).toEqual([
      "Fonts Inter and Consolas aren't on this PC. Showing Segoe UI. Import them in Settings, or pick other fonts.",
    ]);
    // Through the shared helper, once, and as a notice (amber), never info.
    expect(notices.shared).toHaveLength(1);
    expect(notices.info).toEqual([]);
  });

  it("says nothing, and calls nothing, for a project without fontId", async () => {
    await prepareProjectFonts(media(gen(), gen({ fontFamily: "Impact" })), () => false);
    expect(fontsState.ensureCalls).toEqual([]);
    expect(notices.list).toEqual([]);
  });

  it("says nothing when every font is here", async () => {
    await prepareProjectFonts(media(gen({ fontId: "Consolas" })), () => false);
    expect(fontsState.ensureCalls.length).toBe(1);
    expect(notices.list).toEqual([]);
  });

  it("says nothing once the editor is gone", async () => {
    fontsState.missing.add("Consolas");
    await prepareProjectFonts(media(gen({ fontId: "Consolas" })), () => true);
    expect(notices.list).toEqual([]);
  });

  it("asks once per distinct face", () => {
    const reqs = textFontRequests(media(gen({ fontId: "Consolas" }), gen({ fontId: "Consolas" }), gen({ fontId: "Consolas", bold: false })));
    expect(reqs).toEqual([
      { id: "Consolas", bold: true, italic: true },
      { id: "Consolas", bold: false, italic: true },
    ]);
  });
});
