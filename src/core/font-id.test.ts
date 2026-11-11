import { describe, expect, it } from "vitest";
import {
  chosenFont,
  DEFAULT_FONT,
  fontChoice,
  fontDisplayName,
  fontRequestOf,
  isFontId,
  isLegacyFont,
  LEGACY_FONTS,
  missingFontNotice,
} from "./font-id";

describe("fontRequestOf", () => {
  it("asks for the fontId's face, with the bold/italic as given", () => {
    expect(fontRequestOf("Georgia", "lib:Inter", true, false)).toStrictEqual({ id: "lib:Inter", bold: true, italic: false });
    expect(fontRequestOf("Impact", "Consolas", false, true)).toStrictEqual({ id: "Consolas", bold: false, italic: true });
  });

  it("is null when the legacy font is in force (no fontId, or an ill-shaped one)", () => {
    expect(fontRequestOf("Georgia", undefined, true, true)).toBeNull();
    expect(fontRequestOf("Georgia", "", true, true)).toBeNull();
    expect(fontRequestOf("Georgia", "lib:", false, false)).toBeNull();
    expect(fontRequestOf("Georgia", " Consolas", false, true)).toBeNull();
  });
});

describe("LEGACY_FONTS", () => {
  it("is the six, in the menus' order, and frozen", () => {
    expect(LEGACY_FONTS).toEqual(["Segoe UI", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact"]);
    expect(Object.isFrozen(LEGACY_FONTS)).toBe(true);
    expect(DEFAULT_FONT).toBe("Segoe UI");
  });
});

describe("isLegacyFont", () => {
  it("knows exactly the six, case-sensitively", () => {
    for (const f of LEGACY_FONTS) expect(isLegacyFont(f)).toBe(true);
    for (const v of ["segoe ui", "Arial ", "Consolas", "lib:Arial", "", null, undefined, 1, {}]) {
      expect(isLegacyFont(v), String(v)).toBe(false);
    }
  });
});

describe("isFontId", () => {
  it("accepts installed and library ids, and the legacy names", () => {
    for (const v of ["Consolas", "Segoe UI Light", "lib:Inter", "lib:x", "A", "Arial", "x".repeat(96), "lib: Inter"]) {
      expect(isFontId(v), v).toBe(true);
    }
  });

  it("refuses non-strings, the empty string and anything over 96 units", () => {
    for (const v of [undefined, null, 0, true, {}, ["Arial"], "", "x".repeat(97)]) {
      expect(isFontId(v), String(v)).toBe(false);
    }
    // 96 units of a surrogate pair is 48 characters: the cap counts UTF-16 units.
    expect(isFontId("\u{1F600}".repeat(48))).toBe(true);
    expect(isFontId("\u{1F600}".repeat(48) + "x")).toBe(false);
  });

  it("refuses control characters anywhere", () => {
    for (const c of ["\u0000", "\u0009", "\u000a", "\u001f", "\u007f"]) {
      expect(isFontId(`Ari${c}al`), JSON.stringify(c)).toBe(false);
    }
    // just outside both ranges
    expect(isFontId("Ari al")).toBe(true);
    expect(isFontId("Ari\u0080al")).toBe(true);
  });

  it("refuses leading or trailing whitespace", () => {
    for (const v of [" Arial", "Arial ", " Consolas", "Consolas　", " "]) {
      expect(isFontId(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("refuses a bare lib: prefix", () => {
    expect(isFontId("lib:")).toBe(false);
    expect(isFontId("lib:I")).toBe(true);
    expect(isFontId("Lib:")).toBe(true); // matching is case-sensitive: not the prefix
  });
});

describe("fontChoice", () => {
  it("stores a legacy pick in the legacy field, with no fontId key at all", () => {
    for (const f of LEGACY_FONTS) {
      const c = fontChoice(f);
      expect(c).toStrictEqual({ legacy: f });
      expect("fontId" in c).toBe(false);
    }
  });

  it("stores any other pick as fontId over the default legacy font", () => {
    expect(fontChoice("Consolas")).toStrictEqual({ legacy: "Segoe UI", fontId: "Consolas" });
    expect(fontChoice("lib:Inter")).toStrictEqual({ legacy: "Segoe UI", fontId: "lib:Inter" });
    // case-sensitive: not a legacy name
    expect(fontChoice("arial")).toStrictEqual({ legacy: "Segoe UI", fontId: "arial" });
  });
});

describe("chosenFont", () => {
  it("is the fontId when well-shaped, else the legacy font", () => {
    expect(chosenFont("Georgia", "lib:Inter")).toBe("lib:Inter");
    expect(chosenFont("Georgia", undefined)).toBe("Georgia");
    expect(chosenFont("Impact", "")).toBe("Impact");
    expect(chosenFont("Impact", " Consolas")).toBe("Impact");
    expect(chosenFont("Arial", "lib:")).toBe("Arial");
  });
});

describe("fontDisplayName", () => {
  it("drops the lib: prefix of a library id and leaves anything else as is", () => {
    expect(fontDisplayName("lib:Inter")).toBe("Inter");
    expect(fontDisplayName("lib:lib:X")).toBe("lib:X");
    expect(fontDisplayName("Consolas")).toBe("Consolas");
    expect(fontDisplayName("Lib:Inter")).toBe("Lib:Inter"); // case-sensitive
    expect(fontDisplayName("Segoe UI")).toBe("Segoe UI");
  });
});

describe("missingFontNotice", () => {
  const ONE = "isn't on this PC. Showing Segoe UI. Import it in Settings, or pick another font.";
  const MANY = "aren't on this PC. Showing Segoe UI. Import them in Settings, or pick other fonts.";

  it("an empty list says nothing", () => {
    expect(missingFontNotice([])).toBe("");
  });

  it("one font, a library id named without lib:", () => {
    expect(missingFontNotice(["Consolas"])).toBe(`Font Consolas ${ONE}`);
    expect(missingFontNotice(["lib:Inter"])).toBe(`Font Inter ${ONE}`);
  });

  it("two fonts: joined with and", () => {
    expect(missingFontNotice(["lib:A", "B"])).toBe(`Fonts A and B ${MANY}`);
  });

  it("three fonts: commas and a final and", () => {
    expect(missingFontNotice(["A", "lib:B", "C"])).toBe(`Fonts A, B and C ${MANY}`);
  });

  it("duplicates are named once, in first-seen order", () => {
    expect(missingFontNotice(["lib:Inter", "lib:Inter"])).toBe(`Font Inter ${ONE}`);
    expect(missingFontNotice(["C", "A", "C", "lib:B", "A"])).toBe(`Fonts C, A and B ${MANY}`);
    // the same name reached two ways is still one name to a person
    expect(missingFontNotice(["lib:Inter", "Inter"])).toBe(`Font Inter ${ONE}`);
  });
});
