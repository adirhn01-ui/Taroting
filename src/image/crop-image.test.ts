import { describe, expect, it, vi } from "vitest";

// crop-image.ts imports the A2 layer ops for Apply; the maths under test never
// calls them, and the stub throws, so it is mocked out of the way.
vi.mock("./layers", () => ({ cropImage: vi.fn() }));

import { aspectRect, dragCrop, roundCrop } from "./crop-image";
import { CANVAS_SIZE_TITLE, canvasSizeMarkup, keptSide, parseSide } from "./canvas-size-dialog";

// A canvas and a start rect that differ on every axis, so a swapped x/y or w/h
// (or a handle mapped to the wrong edge) cannot pass.
const W = 641;
const H = 361;
const start = { x: 100, y: 40, w: 300, h: 200 };

describe("dragCrop (free)", () => {
  it("moves exactly the edges each handle names", () => {
    expect(dragCrop(start, "e", 17, 999, null, W, H)).toEqual({ x: 100, y: 40, w: 317, h: 200 });
    expect(dragCrop(start, "w", -30, 999, null, W, H)).toEqual({ x: 70, y: 40, w: 330, h: 200 });
    expect(dragCrop(start, "n", 999, -11, null, W, H)).toEqual({ x: 100, y: 29, w: 300, h: 211 });
    expect(dragCrop(start, "s", 999, 23, null, W, H)).toEqual({ x: 100, y: 40, w: 300, h: 223 });
    expect(dragCrop(start, "nw", 13, 7, null, W, H)).toEqual({ x: 113, y: 47, w: 287, h: 193 });
    expect(dragCrop(start, "se", -50, 19, null, W, H)).toEqual({ x: 100, y: 40, w: 250, h: 219 });
  });

  it("stays inside the canvas and never turns inside out", () => {
    expect(dragCrop(start, "e", 5000, 0, null, W, H).w).toBe(W - 100);
    expect(dragCrop(start, "w", -5000, 0, null, W, H).x).toBe(0);
    const past = dragCrop(start, "e", -900, 0, null, W, H);
    expect(past.x).toBe(100);
    expect(past.w).toBe(1);
    const up = dragCrop(start, "n", 0, 900, null, W, H);
    expect(up.h).toBe(1);
    expect(up.y).toBe(239);
  });

  it("moves the whole window, clamped at the canvas edges", () => {
    expect(dragCrop(start, "move", 12, -9, null, W, H)).toEqual({ x: 112, y: 31, w: 300, h: 200 });
    expect(dragCrop(start, "move", 900, 900, null, W, H)).toEqual({ x: W - 300, y: H - 200, w: 300, h: 200 });
    expect(dragCrop(start, "move", -900, -900, null, W, H)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });
});

describe("dragCrop (move with a ratio)", () => {
  it("moves the window freely, keeping its size, clamped at the canvas edges", () => {
    // The ratio never reaches a move: the window keeps its shape as it is.
    const sq = { x: 140, y: 0, w: 361, h: 361 };
    for (const ratio of [1, 16 / 9, 9 / 16]) {
      expect(dragCrop(start, "move", 12, -9, ratio, W, H)).toEqual({ x: 112, y: 31, w: 300, h: 200 });
      expect(dragCrop(start, "move", 900, 900, ratio, W, H)).toEqual({ x: W - 300, y: H - 200, w: 300, h: 200 });
    }
    expect(dragCrop(sq, "move", -60, 25, 1, W, H)).toEqual({ x: 80, y: 0, w: 361, h: 361 });
    expect(dragCrop(sq, "move", 500, 0, 1, W, H)).toEqual({ x: W - 361, y: 0, w: 361, h: 361 });
  });

  it("the whole-canvas start has nowhere to move to", () => {
    // Why a fresh crop "can't move": it starts as the whole canvas.
    const whole = { x: 0, y: 0, w: W, h: H };
    expect(dragCrop(whole, "move", 40, 30, null, W, H)).toEqual(whole);
  });
});

describe("dragCrop (aspect)", () => {
  it("a corner pins the opposite corner and keeps the ratio", () => {
    const r = dragCrop(start, "se", 60, 5, 16 / 9, W, H);
    expect(r.x).toBe(100);
    expect(r.y).toBe(40);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 9);
    // The larger of the two proposals wins: 360 wide vs 205 tall × 16/9.
    expect(r.w).toBeCloseTo((205 * 16) / 9, 9);
    const nw = dragCrop(start, "nw", -20, -20, 1, W, H);
    expect(nw.x + nw.w).toBeCloseTo(400, 9);
    expect(nw.y + nw.h).toBeCloseTo(240, 9);
    expect(nw.w).toBeCloseTo(nw.h, 9);
  });

  it("a corner stops at the canvas on either axis", () => {
    const r = dragCrop(start, "se", 5000, 5000, 4 / 3, W, H);
    expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-9);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 9);
    // height-bound here: 321 px of room below y=40
    expect(r.h).toBeCloseTo(H - 40, 9);
  });

  it("an edge grows the other axis about the centre line", () => {
    const r = dragCrop(start, "e", 40, 0, 3 / 2, W, H);
    expect(r.x).toBe(100);
    expect(r.w).toBeCloseTo(340, 9);
    expect(r.h).toBeCloseTo(340 / 1.5, 9);
    expect(r.y + r.h / 2).toBeCloseTo(140, 9);
    const s = dragCrop(start, "s", 0, 30, 1, W, H);
    expect(s.y).toBe(40);
    expect(s.h).toBeCloseTo(230, 9);
    expect(s.x + s.w / 2).toBeCloseTo(250, 9);
  });
});

describe("aspectRect / roundCrop", () => {
  it("is the largest centred rect of the ratio, in whole px", () => {
    expect(aspectRect(1, W, H)).toEqual({ x: 140, y: 0, w: 361, h: 361 });
    const wide = aspectRect(16 / 9, W, H);
    expect(wide.w).toBe(641);
    expect(wide.h).toBe(361);
    const tall = aspectRect(9 / 16, W, H);
    expect(tall.h).toBe(361);
    expect(tall.w).toBe(203);
    expect(tall.x).toBe(219);
  });

  it("rounds to integers at least 1×1 inside the canvas", () => {
    expect(roundCrop({ x: -3.4, y: 400, w: 0.2, h: 12.6 }, W, H)).toEqual({ x: 0, y: 348, w: 1, h: 13 });
    expect(roundCrop({ x: 630.6, y: 1.5, w: 30, h: 999 }, W, H)).toEqual({ x: 611, y: 0, w: 30, h: 361 });
  });
});

describe("the Resize canvas dialog", () => {
  it("is titled for what it does, header and accessible name alike", () => {
    expect(CANVAS_SIZE_TITLE).toBe("Resize canvas");
    const html = canvasSizeMarkup("<svg></svg>");
    expect(html).toContain('<div class="modal__header"><span>Resize canvas</span>');
    expect(html).toContain('aria-label="Resize canvas"');
    expect(html).not.toContain("Canvas size");
  });

  it("says it pads or trims around the picture, and points scaling to Export", () => {
    // Keep aspect ticked reads as "scale my picture"; the note must say what
    // Apply really does (layers keep their pixel size) and where scaling lives.
    const html = canvasSizeMarkup("<svg></svg>");
    expect(html).toContain(
      "Adds or trims space around the picture — layers keep their size. To make the picture smaller, pick a size in Export.",
    );
    expect(html).not.toContain("Layers stay centred.");
    expect(html).toMatch(/id="imged-size-keep" type="checkbox" checked/);
  });
});

describe("canvas size input", () => {
  it("accepts whole pixels 1-65535 only", () => {
    expect(parseSide("641")).toBe(641);
    expect(parseSide(" 1 ")).toBe(1);
    expect(parseSide("65535")).toBe(65535);
    for (const bad of ["", "0", "65536", "12.5", "-3", "1e3", "abc", "1234567"]) {
      expect(parseSide(bad), bad).toBeNull();
    }
  });

  it("keeps the canvas's aspect from either side", () => {
    // 641×361: width 1282 → height 722; height 100 → width 178 (177.56 rounded).
    expect(keptSide(1282, 641, 361)).toBe(722);
    expect(keptSide(100, 361, 641)).toBe(178);
    expect(keptSide(1, 641, 361)).toBe(1);
    expect(keptSide(65535, 361, 641)).toBe(65535);
  });
});
