import { describe, expect, it } from "vitest";
import { computeTransform } from "./transforms";
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
});
