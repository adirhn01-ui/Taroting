import { describe, expect, it } from "vitest";
import { applyIntrinsicScale, computeTransform } from "./transforms";
import { defaultTransform } from "../../core/project";

const project = { width: 1920, height: 1080 };

describe("computeTransform", () => {
  it("identity: same-size media fills the canvas", () => {
    const c = computeTransform(undefined, { width: 1920, height: 1080 }, project);
    expect(c.mediaW).toBe(1920);
    expect(c.mediaH).toBe(1080);
    expect(c.cropW).toBe(1920);
    expect(c.cropH).toBe(1080);
    expect(c.offX).toBe(0);
    expect(c.opacity).toBe(1);
  });

  it("smaller media scales up to fit (like export scale=…:decrease + pad)", () => {
    const c = computeTransform(undefined, { width: 960, height: 540 }, project);
    expect(c.mediaW).toBe(1920); // 2x fit
    expect(c.cropH).toBe(1080);
  });

  it("portrait media letterboxes by height", () => {
    const c = computeTransform(undefined, { width: 1080, height: 1920 }, project);
    expect(c.mediaH).toBe(1080);
    expect(c.mediaW).toBeCloseTo(607.5, 6);
  });

  it("rotation 90 fits the rotated bounding box", () => {
    const t = { ...defaultTransform(), rotate: 90 as const };
    const c = computeTransform(t, { width: 1920, height: 1080 }, project);
    // rotated: 1080 wide, 1920 tall → fit = min(1920/1080, 1080/1920) = 0.5625
    expect(c.cropW).toBeCloseTo(1920 * 0.5625, 6);
    expect(c.cropH).toBeCloseTo(1080 * 0.5625, 6);
  });

  it("crop region is fitted, media shifts to expose it", () => {
    const t = { ...defaultTransform(), crop: { x: 480, y: 270, w: 960, h: 540 } };
    const c = computeTransform(t, { width: 1920, height: 1080 }, project);
    expect(c.cropW).toBe(1920); // 960 crop fits 2x
    expect(c.mediaW).toBe(3840); // whole frame scales with it
    expect(c.offX).toBe(-960); // shifted so the crop window shows
    expect(c.offY).toBe(-540);
  });

  it("user scale multiplies on top of fit", () => {
    const t = { ...defaultTransform(), scale: 0.5 };
    const c = computeTransform(t, { width: 1920, height: 1080 }, project);
    expect(c.cropW).toBe(960);
  });

  it("position and opacity pass through", () => {
    const t = { ...defaultTransform(), x: 25, y: -40, opacity: 0.4 };
    const c = computeTransform(t, { width: 1920, height: 1080 }, project);
    expect(c.posX).toBe(25);
    expect(c.posY).toBe(-40);
    expect(c.opacity).toBe(0.4);
  });

  // Issue #1's exact numbers: a Text generator measured at 270x114 on a 398x934
  // canvas. Every axis differs, so nothing can coincide and hide a mix-up (the
  // E2E that missed this bug used 640x360 for BOTH). The export builder must
  // synthesize the generator at 270x114 and fit it to these extents; pinning
  // them here pins the invariant the Rust side mirrors.
  it("fits a text-sized generator into a mismatched canvas", () => {
    const c = computeTransform(undefined, { width: 270, height: 114 }, { width: 398, height: 934 });
    expect(c.cropW).toBe(398); // width-bound: 398/270 < 934/114
    expect(c.cropH).toBeCloseTo(168.0444444, 6);
    expect(c.k).toBeCloseTo(398 / 270, 12);
    // mediaW/mediaH agree with the crop box when there is no crop
    expect(c.mediaW).toBe(c.cropW);
    expect(c.mediaH).toBe(c.cropH);
  });

  it("exposes k as the magnitude factor behind cropW/mediaW", () => {
    const t = { ...defaultTransform(), scale: 0.5 };
    const c = computeTransform(t, { width: 960, height: 540 }, project);
    expect(c.k).toBeCloseTo(1, 12); // fit 2x * userScale 0.5
    expect(c.cropW).toBeCloseTo(960 * c.k, 9);
    expect(c.mediaH).toBeCloseTo(540 * c.k, 9);
  });
});

/* The crop a crafted .trt can carry past clampCrop: the preview must draw what
 * the export builder hands ffmpeg. Every row below is a row of builder.rs's
 * own tests (`a_crop_side_under_the_preview_floor_exports_at_the_floor`,
 * `a_crop_hanging_off_the_media_is_clamped_inside_it`, same 1280x720 canvas),
 * read back in source px the way export-parity.test.ts does. */
describe("computeTransform: a crop past clampCrop previews as it exports", () => {
  const canvas = { width: 1280, height: 720 };
  const src = (crop: { x: number; y: number; w: number; h: number }, media: { width: number; height: number }) => {
    const c = computeTransform({ ...defaultTransform(), crop }, media, canvas);
    return {
      w: Math.round(c.cropW / c.k),
      h: Math.round(c.cropH / c.k),
      x: Math.round(-c.offX / c.k) + 0,
      y: Math.round(-c.offY / c.k) + 0,
    };
  };

  it("a side under 8 px previews at the 8 px floor, not as a sliver", () => {
    const hd = { width: 1920, height: 1080 };
    expect(src({ x: 100, y: 60, w: 1, h: 1 }, hd)).toEqual({ w: 8, h: 8, x: 100, y: 60 });
    expect(src({ x: 100, y: 60, w: 1, h: 500 }, hd)).toEqual({ w: 8, h: 500, x: 100, y: 60 });
    expect(src({ x: 100, y: 60, w: 700, h: 1 }, hd)).toEqual({ w: 700, h: 8, x: 100, y: 60 });
    // a 5x3 media cannot hold an 8 px side: the floor stops at its size,
    // which is the whole frame
    expect(src({ x: 2, y: 1, w: 1, h: 1 }, { width: 5, height: 3 })).toEqual({ w: 5, h: 3, x: 0, y: 0 });
  });

  it("a crop hanging off the media is drawn clamped inside it", () => {
    const portrait = { width: 1080, height: 1920 };
    expect(src({ x: 1200, y: 100, w: 500, h: 800 }, portrait)).toEqual({ w: 8, h: 800, x: 1072, y: 100 });
    expect(src({ x: 100, y: 2000, w: 300, h: 400 }, portrait)).toEqual({ w: 300, h: 8, x: 100, y: 1912 });
    // an in-frame origin with an overhanging size keeps its origin and shrinks
    expect(src({ x: 100, y: 0, w: 1080, h: 1920 }, portrait)).toEqual({ w: 980, h: 1920, x: 100, y: 0 });
  });
});

/* applyIntrinsicScale — the generated-media path. The suite runs in the "node"
 * environment (no DOM), and the function only ever writes three style strings,
 * so a bare { style: {} } stands in for the element. */

interface StubEl {
  style: { width?: string; height?: string; transform?: string };
}
const stubEl = (): StubEl => ({ style: {} });
const asEl = (s: StubEl): HTMLElement => s as unknown as HTMLElement;

describe("applyIntrinsicScale", () => {
  it("keeps the box at source size and scales by exactly k * stageScale", () => {
    const c = computeTransform(undefined, { width: 270, height: 114 }, { width: 398, height: 934 });
    const el = stubEl();
    applyIntrinsicScale(asEl(el), c, 270, 114, 0.5);

    // the BOX stays intrinsic — a <div>'s width says nothing about its glyphs
    expect(el.style.width).toBe("270px");
    expect(el.style.height).toBe("114px");

    const m = /scale\(([-\d.e+]+)\)$/.exec(el.style.transform!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(c.k * 0.5);
  });

  it("lands the box exactly where applyTransform would have sized it", () => {
    // crop offset + user scale, so offX/offY and k are all non-trivial
    const t = { ...defaultTransform(), scale: 1.5, crop: { x: 40, y: 20, w: 200, h: 90 } };
    const c = computeTransform(t, { width: 270, height: 114 }, { width: 398, height: 934 });
    const s = 0.8;
    const el = stubEl();
    applyIntrinsicScale(asEl(el), c, 270, 114, s);

    // translate() must match applyTransform's media translate verbatim...
    expect(el.style.transform).toBe(
      `translate(${c.offX * s}px, ${c.offY * s}px) scale(${c.k * s})`,
    );
    // ...and the resulting on-screen extent must equal applyTransform's
    // width/height, so geometry is unchanged and only the glyphs get scaled.
    expect(270 * (c.k * s)).toBeCloseTo(c.mediaW * s, 9);
    expect(114 * (c.k * s)).toBeCloseTo(c.mediaH * s, 9);
  });

  it("scales a 1:1 layer by the stage scale alone", () => {
    const c = computeTransform(undefined, { width: 1920, height: 1080 }, project);
    const el = stubEl();
    applyIntrinsicScale(asEl(el), c, 1920, 1080, 0.25);
    expect(c.k).toBe(1);
    expect(el.style.transform).toBe("translate(0px, 0px) scale(0.25)");
  });
});

describe("one crop floor everywhere", () => {
  it("Fit/Fill uses the preview's CROP_MIN", async () => {
    const { VISIBLE_CROP_MIN, fitFillScale } = await import("../../core/project");
    const { CROP_MIN } = await import("./canvas-math");
    expect(VISIBLE_CROP_MIN).toBe(CROP_MIN);
    // A 1 px wide crop on 64x36 media fits as the 8 px the preview draws. On a
    // 16x36 canvas, fill = (16/8) / (36/36) = 2; the old 1 px floor gave
    // 16 / 1 = 16 → clamped to MAX_SCALE 4, so the two floors differ.
    expect(fitFillScale(64, 36, { x: 10, y: 0, w: 1, h: 36 }, 16, 36, "fill")).toBeCloseTo(2, 9);
    // The origin is clamped into the frame first: a crop starting past the
    // right edge is the last 8 px, not a 1 px sliver.
    expect(fitFillScale(64, 36, { x: 70, y: 0, w: 1, h: 36 }, 16, 36, "fill")).toBeCloseTo(2, 9);
  });
});
