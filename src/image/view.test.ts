import { describe, expect, it } from "vitest";
import {
  FIT_MARGIN_CSS,
  ZOOM_FLOOR,
  ZOOM_MAX,
  canvasToStageCss,
  clampPan,
  clampZoom,
  fitView,
  fitZoom,
  rescaleForDpr,
  stageCssToCanvas,
  wheelPixels,
  wheelZoomFactor,
  zoomAbout,
  zoomBounds,
  zoomStep,
} from "./view";

describe("zoomAbout", () => {
  it("keeps the canvas point under the cursor fixed (zoom 0.37 ×1.6, client (211, 97), pan (13, −40))", () => {
    // dpr 1.25 so a mix-up between CSS and device px cannot cancel out.
    const dpr = 1.25;
    const v = { zoom: 0.37, panX: 13, panY: -40 };
    const before = stageCssToCanvas(v, dpr, 211, 97);
    const next = zoomAbout(v, 1.6, 211 * dpr, 97 * dpr, 0.01, 32);
    expect(next.zoom).toBeCloseTo(0.37 * 1.6, 12);
    const after = stageCssToCanvas(next, dpr, 211, 97);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-9);
    // …and the point actually moved relative to the pan (a no-op zoom would
    // pass the invariance trivially).
    expect(next.panX).not.toBeCloseTo(v.panX, 3);
    expect(next.panY).not.toBeCloseTo(v.panY, 3);
  });

  it("keeps the point fixed even when the zoom is clamped", () => {
    const v = { zoom: 30, panX: -700, panY: 55 };
    const next = zoomAbout(v, 4, 300, 170, 0.01, ZOOM_MAX);
    expect(next.zoom).toBe(ZOOM_MAX);
    const a = stageCssToCanvas(v, 1, 300, 170);
    const b = stageCssToCanvas(next, 1, 300, 170);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9);
  });

  it("treats a non-finite or non-positive factor as no zoom", () => {
    const v = { zoom: 0.8, panX: 3, panY: 4 };
    expect(zoomAbout(v, Number.NaN, 10, 10, 0.01, 32)).toEqual(v);
    expect(zoomAbout(v, 0, 10, 10, 0.01, 32)).toEqual(v);
  });
});

describe("zoom bounds", () => {
  it("clamps to [min(fit, 0.01), 32]", () => {
    expect(zoomBounds(0.5)).toEqual({ min: ZOOM_FLOOR, max: ZOOM_MAX });
    // A canvas so large that fitting it needs less than the floor lowers it.
    expect(zoomBounds(0.004)).toEqual({ min: 0.004, max: ZOOM_MAX });
    expect(clampZoom(40, 0.5)).toBe(32);
    expect(clampZoom(0.002, 0.5)).toBe(0.01);
    expect(clampZoom(0.002, 0.004)).toBe(0.004);
    expect(clampZoom(0.003, 0.002)).toBe(0.003);
    expect(clampZoom(1.7, 0.5)).toBe(1.7);
  });
});

describe("fit", () => {
  it("fits 641×361 in a 900×500 stage with a 24 px margin, centred", () => {
    // At dpr 1: available 852×452 → height-bound, zoom 452/361.
    const v = fitView(641, 361, 900, 500, 1);
    expect(FIT_MARGIN_CSS).toBe(24);
    expect(v.zoom).toBeCloseTo(452 / 361, 12);
    expect(v.panX).toBeCloseTo((900 - 641 * v.zoom) / 2, 9);
    expect(v.panY).toBeCloseTo(24, 9);
    // The whole canvas is inside the stage, margins honoured on the bound axis.
    expect(v.panX).toBeGreaterThanOrEqual(24);
    expect(v.panX + 641 * v.zoom).toBeLessThanOrEqual(900 - 24 + 1e-9);
  });

  it("measures the margin in CSS px at dpr 1.5 (stage in device px)", () => {
    // 900×500 CSS = 1350×750 device; margin 36 device px per side.
    const z = fitZoom(641, 361, 1350, 750, 1.5);
    expect(z).toBeCloseTo((750 - 72) / 361, 12);
    // Width-bound case: a wide canvas.
    expect(fitZoom(3000, 361, 1350, 750, 1.5)).toBeCloseTo((1350 - 72) / 3000, 12);
  });

  it("is always finite and positive", () => {
    expect(fitZoom(641, 361, 0, 0, 1)).toBeGreaterThan(0);
    expect(Number.isFinite(fitZoom(0, 0, 900, 500, 1))).toBe(true);
    expect(Number.isFinite(fitZoom(Number.NaN, 5, 900, 500, 1))).toBe(true);
  });
});

describe("conversions", () => {
  it("canvas → stage CSS → canvas round-trips", () => {
    const v = { zoom: 2.3, panX: -117, panY: 41 };
    const css = canvasToStageCss(v, 1.75, 83, 29);
    const back = stageCssToCanvas(v, 1.75, css.x, css.y);
    expect(back.x).toBeCloseTo(83, 9);
    expect(back.y).toBeCloseTo(29, 9);
    expect(css.x).toBeCloseTo((83 * 2.3 - 117) / 1.75, 9);
  });
});

describe("clampPan", () => {
  it("keeps some of the canvas on stage, per axis, and leaves a good view alone", () => {
    const ok = { zoom: 1, panX: 100, panY: 50 };
    expect(clampPan(ok, 641, 361, 900, 500, 48)).toBe(ok);
    // Flung far right/down: the canvas's left/top edge stops 48 px inside.
    const right = clampPan({ zoom: 1, panX: 5000, panY: 9000 }, 641, 361, 900, 500, 48);
    expect(right.panX).toBe(900 - 48);
    expect(right.panY).toBe(500 - 48);
    // Flung far left/up: its right/bottom edge stops 48 px inside.
    const left = clampPan({ zoom: 2, panX: -5000, panY: -9000 }, 641, 361, 900, 500, 48);
    expect(left.panX).toBe(48 - 641 * 2);
    expect(left.panY).toBe(48 - 361 * 2);
    // A canvas smaller than the keep stays fully visible.
    const tiny = clampPan({ zoom: 1, panX: -30, panY: 700 }, 20, 12, 900, 500, 48);
    expect(tiny.panX).toBe(0);
    expect(tiny.panY).toBe(500 - 12);
  });
});

describe("wheel", () => {
  it("zooms by 2^(−deltaY/300)", () => {
    expect(wheelZoomFactor(-300)).toBeCloseTo(2, 12);
    expect(wheelZoomFactor(150)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("normalises line and page deltas to px", () => {
    expect(wheelPixels(3, 0, 480)).toBe(3);
    expect(wheelPixels(3, 1, 480)).toBe(48);
    expect(wheelPixels(-1, 2, 480)).toBe(-480);
  });
});

describe("rescaleForDpr", () => {
  it("keeps a canvas point at the same CSS position across a DPR change", () => {
    const v = { zoom: 0.9, panX: 37, panY: -12 };
    const before = canvasToStageCss(v, 1, 210, 140);
    const after = canvasToStageCss(rescaleForDpr(v, 1.5), 1.5, 210, 140);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe("zoomStep", () => {
  it("steps to the neighbouring level, and from between levels to the nearest one", () => {
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1, -1)).toBe(0.6667);
    // Between steps (a wheel left it at 1.23): in → 1.5, out → 1.
    expect(zoomStep(1.23, 1)).toBe(1.5);
    expect(zoomStep(1.23, -1)).toBe(1);
    // Ends of the ladder hold.
    expect(zoomStep(32, 1)).toBe(32);
    expect(zoomStep(0.01, -1)).toBe(0.01);
    // A fit zoom below the floor steps up onto the ladder.
    expect(zoomStep(0.004, 1)).toBe(0.01);
  });
});
