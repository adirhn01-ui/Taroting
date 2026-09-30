import { describe, expect, it } from "vitest";
import { icon } from "../ui/icons";
import { IMG_ICON_PATHS, imgIcon } from "./icons";
import type { ImgIconName } from "./icons";

// `icon()` with a name it does not know renders the bare wrapper, so the
// wrapper is whatever surrounds the path markup — taken from the real function,
// never restated here, so a change to either side fails this test.
const wrapper = (size: number): { open: string; close: string } => {
  const bare = icon("__no_such_icon__", size);
  const at = bare.indexOf("</svg>");
  return { open: bare.slice(0, at), close: bare.slice(at) };
};

const NAMES = Object.keys(IMG_ICON_PATHS) as ImgIconName[];

describe("imgIcon", () => {
  it("wraps every glyph exactly as ui/icons icon() does, at any size", () => {
    // Sizes that differ from the default and from each other, so a wrapper
    // that hard-codes 16 (or ignores the argument) cannot pass.
    for (const size of [16, 14, 23]) {
      const { open, close } = wrapper(size);
      for (const name of NAMES) {
        const svg = imgIcon(name, size);
        expect(svg.startsWith(open), `${name}@${size}`).toBe(true);
        expect(svg.endsWith(close), `${name}@${size}`).toBe(true);
        expect(svg.slice(open.length, svg.length - close.length)).toBe(IMG_ICON_PATHS[name]);
      }
    }
  });

  it("defaults to 16 like icon()", () => {
    expect(imgIcon("pen")).toBe(imgIcon("pen", 16));
    expect(imgIcon("pen").startsWith(wrapper(16).open)).toBe(true);
  });

  it("has a non-empty, distinct drawing for every locked name", () => {
    const locked: ImgIconName[] = [
      "select", "pen", "pencil", "marker", "eraser", "shapes", "ruler", "undo", "redo", "copy",
      "eye", "eyeOff", "layers", "crop", "canvas", "rotateLeft", "rotateRight", "flipH", "flipV", "fit",
      "drawing", "image", "text", "solid",
    ];
    expect(NAMES.sort()).toEqual([...locked].sort());
    const seen = new Set<string>();
    for (const name of locked) {
      const p = IMG_ICON_PATHS[name];
      expect(p.length, name).toBeGreaterThan(10);
      // Markup only the wrapper may carry: a glyph must never restyle itself.
      expect(p, name).not.toMatch(/<svg|style=|stroke-width/);
      expect(seen.has(p), `${name} duplicates another glyph`).toBe(false);
      seen.add(p);
    }
  });
});
