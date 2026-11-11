// The remembered PDF tool style (Settings → pdfToolStyle) and its optional
// `fontId` (0.9.4 font library): sanitized on load like every other field.

import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "./session";

const style = (o: Record<string, unknown>) => sanitizeSettings({ pdfToolStyle: o }).pdfToolStyle;

describe("pdfToolStyle.fontId on load", () => {
  it("keeps a well-shaped fontId beside the legacy font", () => {
    expect(style({ font: "Arial", fontId: "lib:Inter" })).toStrictEqual({ font: "Arial", fontId: "lib:Inter" });
  });

  it("drops an ill-shaped fontId and keeps the legacy font", () => {
    for (const bad of ["", "lib:", "Inter ", "a\u0000b", 7, null]) {
      const out = style({ font: "Georgia", fontId: bad });
      expect(out).toStrictEqual({ font: "Georgia" });
    }
  });

  it("absent stays absent; the legacy font rule is unchanged", () => {
    expect("fontId" in style({ font: "Impact" })).toBe(false);
    expect(style({ font: "Consolas" })).toStrictEqual({});
  });
});
