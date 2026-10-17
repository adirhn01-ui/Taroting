import { describe, expect, it } from "vitest";
import type { PdfRotation } from "../../core/types";
import {
  anchoredScroll,
  backingSize,
  boxRectToPage,
  boxSize,
  boxToPage,
  buildPageText,
  clampZoom,
  contentToPage,
  currentSlot,
  displayRotation,
  findAll,
  fitZoom,
  itemSliceRect,
  layoutStrip,
  matchRects,
  mergeLineRects,
  nextSelection,
  nextToRender,
  normRotation,
  pageRectToBox,
  pageToBox,
  pageToContent,
  pickEvictions,
  renderWindow,
  reorderKeys,
  slotAtPoint,
  slotAtY,
  slotsInRange,
  ZOOM_MAX,
  ZOOM_MIN,
  type Rect4,
  type SlotDims,
} from "./math";

const ROTS: PdfRotation[] = [0, 90, 180, 270];
const A4 = { w: 595.28, h: 841.89 };

describe("rotation", () => {
  it("normalises any angle to a quarter turn", () => {
    expect(normRotation(0)).toBe(0);
    expect(normRotation(360)).toBe(0);
    expect(normRotation(450)).toBe(90);
    expect(normRotation(-90)).toBe(270);
    expect(normRotation(540)).toBe(180);
    expect(normRotation(NaN)).toBe(0);
  });
  it("display rotation = source /Rotate + slot rotate, mod 360", () => {
    expect(displayRotation(90, 0)).toBe(90);
    expect(displayRotation(90, 270)).toBe(0);
    expect(displayRotation(270, 180)).toBe(90);
    expect(displayRotation(0, 180)).toBe(180);
  });
});

describe("page space ↔ box", () => {
  it("box size swaps sides on a quarter turn", () => {
    expect(boxSize(100, 200, 0, 2)).toEqual({ W: 200, H: 400 });
    expect(boxSize(100, 200, 90, 2)).toEqual({ W: 400, H: 200 });
    expect(boxSize(100, 200, 180, 2)).toEqual({ W: 200, H: 400 });
    expect(boxSize(100, 200, 270, 2)).toEqual({ W: 400, H: 200 });
  });

  it("turns clockwise: the page's top-left corner lands where /Rotate puts it", () => {
    const { w, h } = { w: 100, h: 200 };
    expect(pageToBox(0, 0, w, h, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(pageToBox(0, 0, w, h, 90, 1)).toEqual({ x: 200, y: 0 }); // top-right
    expect(pageToBox(0, 0, w, h, 180, 1)).toEqual({ x: 100, y: 200 }); // bottom-right
    expect(pageToBox(0, 0, w, h, 270, 1)).toEqual({ x: 0, y: 100 }); // bottom-left
  });

  it("box ↔ page are exact inverses for all four rotations and any zoom", () => {
    const pts = [
      [0, 0],
      [A4.w, A4.h],
      [12.5, 700.25],
      [300, 10],
      [-40, 900], // outside the page (a drag) still round-trips
    ];
    for (const rot of ROTS) {
      for (const zoom of [0.1, 1, 96 / 72, 3.7, 8]) {
        for (const [x, y] of pts) {
          const b = pageToBox(x!, y!, A4.w, A4.h, rot, zoom);
          const p = boxToPage(b.x, b.y, A4.w, A4.h, rot, zoom);
          expect(p.x).toBeCloseTo(x!, 9);
          expect(p.y).toBeCloseTo(y!, 9);
          const p2 = boxToPage(x!, y!, A4.w, A4.h, rot, zoom);
          const b2 = pageToBox(p2.x, p2.y, A4.w, A4.h, rot, zoom);
          expect(b2.x).toBeCloseTo(x!, 9);
          expect(b2.y).toBeCloseTo(y!, 9);
        }
      }
    }
  });

  it("the page box maps exactly onto the turned box", () => {
    for (const rot of ROTS) {
      const r = pageRectToBox([0, 0, A4.w, A4.h], A4.w, A4.h, rot, 2);
      const s = boxSize(A4.w, A4.h, rot, 2);
      expect(r[0]).toBeCloseTo(0, 9);
      expect(r[1]).toBeCloseTo(0, 9);
      expect(r[2]).toBeCloseTo(s.W, 9);
      expect(r[3]).toBeCloseTo(s.H, 9);
    }
  });

  it("rects round-trip for all rotations", () => {
    const r: Rect4 = [50, 60, 120, 14];
    for (const rot of ROTS) {
      const back = boxRectToPage(pageRectToBox(r, A4.w, A4.h, rot, 1.7), A4.w, A4.h, rot, 1.7);
      back.forEach((v, i) => expect(v).toBeCloseTo(r[i]!, 9));
    }
  });
});

const slotsOf = (n: number, d: Partial<SlotDims> = {}): SlotDims[] =>
  Array.from({ length: n }, () => ({ w: 600, h: 800, rot: 0 as PdfRotation, ...d }));

describe("strip layout", () => {
  it("stacks pages with the gap above, between and below, centred", () => {
    const L = layoutStrip(slotsOf(3), 0.5, 16, 1000);
    expect(L.tops).toEqual([16, 16 + 400 + 16, 16 + 2 * (400 + 16)]);
    expect(L.height).toBe(16 + 3 * 400 + 3 * 16);
    expect(L.width).toBe(1000);
    expect(L.lefts).toEqual([350, 350, 350]);
  });

  it("grows wider than the viewport (horizontal scroll) when the page doesn't fit", () => {
    const L = layoutStrip(slotsOf(1), 2, 16, 500);
    expect(L.width).toBe(1200 + 32);
    expect(L.lefts[0]).toBe(16);
  });

  it("lays a turned page out landscape", () => {
    const L = layoutStrip([{ w: 600, h: 800, rot: 90 }], 1, 10, 2000);
    expect(L.W[0]).toBe(800);
    expect(L.H[0]).toBe(600);
  });

  it("slot ↔ content conversions are exact inverses, rotated or not", () => {
    const slots: SlotDims[] = [
      { w: 600, h: 800, rot: 0 },
      { w: 600, h: 800, rot: 90 },
      { w: 300, h: 500, rot: 180 },
      { w: 612, h: 792, rot: 270 },
    ];
    const L = layoutStrip(slots, 1.3, 16, 900);
    slots.forEach((_, i) => {
      for (const [x, y] of [
        [0, 0],
        [17.5, 33.25],
        [200, 400],
      ]) {
        const c = pageToContent(L, slots, i, x!, y!);
        const p = contentToPage(L, slots, i, c.x, c.y);
        expect(p.x).toBeCloseTo(x!, 9);
        expect(p.y).toBeCloseTo(y!, 9);
      }
    });
  });

  it("hit-tests slots and gaps", () => {
    const L = layoutStrip(slotsOf(3), 0.5, 16, 1000);
    expect(slotAtPoint(L, 500, 20)).toBe(0);
    expect(slotAtPoint(L, 500, 16 + 400 + 8)).toBe(-1); // gap
    expect(slotAtPoint(L, 10, 20)).toBe(-1); // beside the page
    expect(slotAtPoint(L, 500, 16 + 416 + 10)).toBe(1);
    expect(slotAtPoint(L, 500, 99999)).toBe(-1);
  });
});

describe("render window and current page", () => {
  const L = layoutStrip(slotsOf(20), 0.5, 16, 1000); // pages 400 tall, pitch 416

  it("finds the slots intersecting a range", () => {
    expect(slotsInRange(L, 0, 10)).toEqual([-1, -1]); // only the top gap
    expect(slotsInRange(L, 0, 17)).toEqual([0, 0]);
    expect(slotsInRange(L, 400, 900)).toEqual([0, 2]);
    expect(slotsInRange(L, 1e6, 2e6)).toEqual([-1, -1]);
    expect(slotsInRange(layoutStrip([], 1, 16, 100), 0, 100)).toEqual([-1, -1]);
  });

  it("the window is the visible slots plus a viewport above and below", () => {
    // viewport 600 tall at scrollTop 4160 (slot 10's top - 16)
    const [a, b] = renderWindow(L, 4160, 600, 600);
    expect(slotsInRange(L, 4160, 4760)).toEqual([10, 11]); // page 9 ends exactly at 4160
    expect(a).toBe(8);
    expect(b).toBe(12);
  });

  it("the current page owns the viewport centre line", () => {
    expect(currentSlot(L, 0, 600)).toBe(0); // centre at 300: inside page 0
    expect(currentSlot(L, 416 * 5, 600)).toBe(5);
    expect(currentSlot(L, 416 * 19 + 1000, 600)).toBe(19); // past the end
  });

  it("at the very top the first page is current, at the very bottom the last", () => {
    // 25%: pages 198 tall + 16 gap — the centre line at the top sits in page 2
    const Z = layoutStrip(slotsOf(20), 0.25, 16, 1000);
    expect(currentSlot(Z, 0, 600)).toBe(0);
    expect(currentSlot(Z, 1, 600)).toBe(1); // scrolled at all: the centre line again
    // at max scroll the centre line is ~1.5 pages above the end
    const max = Z.height - 600;
    expect(currentSlot(Z, max, 600)).toBe(19);
    expect(currentSlot(Z, max - 0.5, 600)).toBe(19); // fractional scrollTop
    expect(currentSlot(Z, max - 214, 600)).toBe(17);
    // a document that fits the viewport: page 1
    const S = layoutStrip(slotsOf(2), 0.25, 16, 1000);
    expect(currentSlot(S, 0, 600)).toBe(0);
    expect(currentSlot(layoutStrip([], 1, 16, 100), 0, 600)).toBe(-1);
  });

  it("in a gap, the nearer page owns the line", () => {
    const gapTop = L.tops[1]! - 16; // bottom of page 0
    expect(slotAtY(L, gapTop + 3)).toBe(0);
    expect(slotAtY(L, gapTop + 13)).toBe(1);
    expect(slotAtY(L, -50)).toBe(0);
  });
});

describe("zoom", () => {
  it("clamps to sensible bounds", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });

  it("fit width / fit page leave the gap on each side", () => {
    const d: SlotDims = { w: 600, h: 800, rot: 0 };
    // one pixel of slack on the width, so a rounded box never overflows
    expect(fitZoom("width", d, 1233, 500, 16)).toBeCloseTo(2, 9);
    expect(fitZoom("page", d, 1233, 432, 16)).toBeCloseTo(0.5, 9);
    expect(fitZoom("page", d, 333, 4000, 16)).toBeCloseTo(0.5, 9);
    // a turned page fits by its turned width
    expect(fitZoom("width", { w: 600, h: 800, rot: 90 }, 833, 500, 16)).toBeCloseTo(1, 9);
    // the fitted box (plus the gaps) is never wider than the strip
    for (const w of [500, 777, 982, 1233, 1919]) {
      expect(Math.round(600 * fitZoom("width", d, w, 500, 16)) + 32).toBeLessThanOrEqual(w);
    }
  });

  it("keeps the page point under the cursor fixed across a zoom", () => {
    const slots: SlotDims[] = [...slotsOf(5), { w: 600, h: 800, rot: 90 }, ...slotsOf(40)];
    const viewW = 900;
    const viewH = 700;
    for (const [z1, z2] of [
      [1, 2.5],
      [2.5, 0.4],
      [0.3, 0.31],
    ]) {
      const A = layoutStrip(slots, z1!, 16, viewW);
      const scroll = { left: Math.max(0, (A.width - viewW) / 2), top: A.tops[5]! + 100 };
      const off = { x: 437, y: 211 }; // the cursor, in viewport px
      const cy = scroll.top + off.y;
      const cx = scroll.left + off.x;
      const slot = slotAtY(A, cy);
      const p = contentToPage(A, slots, slot, cx, cy);
      const B = layoutStrip(slots, z2!, 16, viewW);
      const s = anchoredScroll(B, slots, { slot, x: p.x, y: p.y }, off.x, off.y, viewW, viewH);
      // the same page point is under the cursor afterwards (to the px rounding)
      // where that page point lands now, vs where the cursor is (content px);
      // x may be clamped when the zoomed strip is narrower than the viewport
      const c = pageToContent(B, slots, slot, p.x, p.y);
      expect(s.top).toBeGreaterThan(0);
      expect(s.top).toBeLessThan(B.height - viewH);
      expect(Math.abs(c.y - (s.top + off.y))).toBeLessThanOrEqual(0.5 + 1e-9);
      if (s.left > 0 && s.left < B.width - viewW) expect(Math.abs(c.x - (s.left + off.x))).toBeLessThanOrEqual(0.5 + 1e-9);
      else expect(B.width - viewW).toBeLessThanOrEqual(Math.max(0, c.x - off.x) + 0.5);
    }
  });

  it("anchored scroll is clamped to the scrollable range", () => {
    const slots = slotsOf(2);
    const L = layoutStrip(slots, 1, 16, 800);
    const s = anchoredScroll(L, slots, { slot: 0, x: 0, y: 0 }, 400, 400, 800, 600);
    expect(s.top).toBe(0);
    expect(s.left).toBe(0);
    const e = anchoredScroll(L, slots, { slot: 1, x: 600, y: 800 }, 0, 0, 800, 600);
    expect(e.top).toBe(L.height - 600);
  });
});

describe("backing store and the pixel budget", () => {
  it("renders at the device ratio when it fits", () => {
    expect(backingSize(500, 700, 2)).toEqual({ bw: 1000, bh: 1400, ratio: 2 });
  });
  it("clamps a canvas to the side and area limits", () => {
    const side = backingSize(10000, 100, 2);
    expect(side.bw).toBeLessThanOrEqual(8192);
    const area = backingSize(4000, 6000, 2);
    expect(area.bw * area.bh).toBeLessThanOrEqual(16_777_216);
    expect(area.ratio).toBeLessThan(1);
  });
  it("never sizes a canvas to 0", () => {
    expect(backingSize(0, 0, 2)).toEqual({ bw: 1, bh: 1, ratio: 2 });
    expect(backingSize(0.2, 0.2, 1).bw).toBe(1);
  });

  it("evicts nothing under the budget", () => {
    expect(pickEvictions([{ slot: 1, px: 10 }], 10, 100, 1, new Set())).toEqual([]);
  });
  it("evicts the farthest first, never a kept (visible) slot", () => {
    const rendered = [0, 1, 2, 3, 4, 5, 6].map((slot) => ({ slot, px: 10 }));
    // 70 + 10 incoming, budget 50: drop 3 — farthest from 3 not kept
    const out = pickEvictions(rendered, 10, 50, 3, new Set([2, 3, 4]));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(6);
    expect(out).toContain(0);
    expect(out).not.toContain(3);
    expect(out.every((s) => ![2, 3, 4].includes(s))).toBe(true);
  });
  it("gives up rather than drop a visible page", () => {
    const rendered = [{ slot: 1, px: 100 }];
    expect(pickEvictions(rendered, 100, 50, 1, new Set([1]))).toEqual([]);
  });

  it("renders visible slots first, nearest the centre first", () => {
    expect(nextToRender([0, 9, 5, 6], 5, 6, 6)).toBe(6);
    expect(nextToRender([0, 9, 4], 5, 6, 6)).toBe(4);
    expect(nextToRender([12, 2], 5, 6, 6)).toBe(2);
    expect(nextToRender([], 5, 6, 6)).toBe(-1);
  });
});

describe("rect merging", () => {
  it("merges touching runs on one line, keeps lines apart", () => {
    const out = mergeLineRects([
      [10, 100, 30, 12],
      [42, 100.5, 20, 11],
      [64, 100, 10, 12],
      [10, 120, 50, 12],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBe(10);
    expect(out[0]![2]).toBe(64);
    expect(out[1]).toEqual([10, 120, 50, 12]);
  });
  it("keeps far-apart words on one line separate and drops empty rects", () => {
    const out = mergeLineRects([
      [10, 100, 30, 12],
      [200, 100, 30, 12],
      [0, 0, 0, 10],
    ]);
    expect(out).toEqual([
      [10, 100, 30, 12],
      [200, 100, 30, 12],
    ]);
  });
});

describe("search maths", () => {
  const view = [0, 0, 600, 800];
  const items = [
    { str: "Hello ", transform: [10, 0, 0, 10, 100, 700], width: 30, hasEOL: false, fontName: "f" },
    { str: "World", transform: [10, 0, 0, 10, 130, 700], width: 25, hasEOL: true, fontName: "f" },
    { str: "next LINE", transform: [10, 0, 0, 10, 100, 680], width: 45, hasEOL: false, fontName: "f" },
  ];

  it("joins items, EOL as a space, with item offsets", () => {
    const pt = buildPageText(items);
    expect(pt.text).toBe("Hello World next LINE");
    expect(pt.starts).toEqual([0, 6, 12]);
    expect(pt.lower).toHaveLength(pt.text.length);
  });

  it("finds case-insensitively by default, exactly when asked", () => {
    const pt = buildPageText(items);
    expect(findAll(pt, "line", false)).toEqual([[17, 21]]);
    expect(findAll(pt, "line", true)).toEqual([]);
    expect(findAll(pt, "o", false)).toHaveLength(2);
    expect(findAll(pt, "", false)).toEqual([]);
  });

  it("keeps offsets valid when lower-casing would change a length", () => {
    const pt = buildPageText([{ str: "İstanbul needle" }]);
    expect(pt.lower).toHaveLength(pt.text.length);
    expect(findAll(pt, "NEEDLE", false)).toEqual([[9, 15]]);
  });

  it("maps a match to page space (y down) through the text matrix", () => {
    const pt = buildPageText(items);
    const [s, e] = findAll(pt, "world", false)[0]!;
    const rects = matchRects(items, pt, s!, e!, view, { f: { ascent: 0.8, descent: -0.2 } });
    expect(rects).toHaveLength(1);
    const [x, y, w, h] = rects[0]!;
    expect(x).toBeCloseTo(130, 9);
    expect(w).toBeCloseTo(25, 9);
    // baseline at user y 700 → page y 100; ascent 8 above, descent 2 below
    expect(y).toBeCloseTo(92, 9);
    expect(h).toBeCloseTo(10, 9);
  });

  it("slices a partly matched item by char fraction and merges per line", () => {
    const pt = buildPageText(items);
    const [s, e] = findAll(pt, "lo wor", false)[0]!;
    const rects = matchRects(items, pt, s!, e!, view);
    expect(rects).toHaveLength(1);
    expect(rects[0]![0]).toBeCloseTo(100 + 30 * (3 / 6), 9);
    expect(rects[0]![0] + rects[0]![2]).toBeCloseTo(130 + 25 * (3 / 5), 9);
  });

  it("a match across lines gives one rect per line", () => {
    const pt = buildPageText(items);
    const [s, e] = findAll(pt, "world next", false)[0]!;
    expect(matchRects(items, pt, s!, e!, view)).toHaveLength(2);
  });

  it("offsets by the crop box origin and mirrors RTL slices", () => {
    const it = { str: "abcd", transform: [10, 0, 0, 10, 150, 500], width: 40, dir: "rtl" };
    const r = itemSliceRect(it, 0, 0.25, [50, 0, 650, 800]);
    // first logical char of an RTL run sits at the right end
    expect(r[0]).toBeCloseTo(150 - 50 + 30, 9);
    expect(r[2]).toBeCloseTo(10, 9);
  });

  it("handles text turned by its matrix (vertical run)", () => {
    // 90° counter-clockwise text: advance goes up the page
    const it = { str: "ab", transform: [0, 10, -10, 0, 100, 100], width: 20 };
    const r = itemSliceRect(it, 0, 1, [0, 0, 600, 800], { ascent: 0.8, descent: -0.2 });
    // advance 20 upward from user y 100 → page y 680..700; height spans x 92..102
    expect(r[1]).toBeCloseTo(680, 9);
    expect(r[3]).toBeCloseTo(20, 9);
    expect(r[0]).toBeCloseTo(92, 9);
    expect(r[2]).toBeCloseTo(10, 9);
  });
});

describe("thumb rail maths", () => {
  const keys = ["a", "b", "c", "d", "e"];
  it("moves one page", () => {
    expect(reorderKeys(keys, [0], 3)).toEqual(["b", "c", "a", "d", "e"]);
    expect(reorderKeys(keys, [4], 0)).toEqual(["e", "a", "b", "c", "d"]);
    expect(reorderKeys(keys, [1], 5)).toEqual(["a", "c", "d", "e", "b"]);
  });
  it("moves a selection as a block, keeping its order", () => {
    expect(reorderKeys(keys, [0, 2], 5)).toEqual(["b", "d", "e", "a", "c"]);
    expect(reorderKeys(keys, [3, 1], 0)).toEqual(["b", "d", "a", "c", "e"]);
  });
  it("is null when nothing moves", () => {
    expect(reorderKeys(keys, [1], 1)).toBeNull();
    expect(reorderKeys(keys, [1], 2)).toBeNull();
    expect(reorderKeys(keys, [], 2)).toBeNull();
  });
  it("selects with Ctrl and Shift", () => {
    expect(nextSelection([1], 3, 1, { ctrl: false, shift: false })).toEqual([3]);
    expect(nextSelection([1], 3, 1, { ctrl: true, shift: false })).toEqual([1, 3]);
    expect(nextSelection([1, 3], 3, 1, { ctrl: true, shift: false })).toEqual([1]);
    expect(nextSelection([1], 4, 1, { ctrl: false, shift: true })).toEqual([1, 2, 3, 4]);
    expect(nextSelection([7], 2, 4, { ctrl: true, shift: true })).toEqual([2, 3, 4, 7]);
  });
});
