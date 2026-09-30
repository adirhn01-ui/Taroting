import { describe, expect, it } from "vitest";
import { edgeNear, normalizeAngle, projectToEdge, rulerAxes, snapAngle, tickSpacingCss } from "./ruler";

describe("ruler projection", () => {
  it("puts every point of a stroke on one line at 30° ((x,y)·n constant)", () => {
    const r = { cx: 311.5, cy: -47.25, angle: 30 };
    const { nx, ny } = rulerAxes(r.angle);
    const offset = 32 + 3.5;
    const wobbly: [number, number][] = [
      [100, 20],
      [180.3, 95.1],
      [260, 120],
      [333.7, 201.9],
      [-50, -300],
    ];
    const dots = wobbly.map(([x, y]) => {
      const [px, py] = projectToEdge(r, 1, offset, x, y);
      return px * nx + py * ny;
    });
    for (const d of dots) expect(Math.abs(d - dots[0]!)).toBeLessThan(1e-9);
    // …and that line is `offset` from the centre line, on the +n side
    expect(dots[0]! - (r.cx * nx + r.cy * ny)).toBeCloseTo(offset, 9);
    // the other side mirrors it
    const [qx, qy] = projectToEdge(r, -1, offset, 100, 20);
    expect(qx * nx + qy * ny - (r.cx * nx + r.cy * ny)).toBeCloseTo(-offset, 9);
  });

  it("moves a point only across the ruler, never along it", () => {
    const r = { cx: 0, cy: 0, angle: 30 };
    const { ux, uy } = rulerAxes(r.angle);
    const [px, py] = projectToEdge(r, -1, 10, 57, -23);
    expect(px * ux + py * uy).toBeCloseTo(57 * ux + -23 * uy, 9);
  });
});

describe("ruler snapping", () => {
  it("snaps within 1.5° of a multiple of 15°", () => {
    expect(snapAngle(14.6)).toBe(15);
    expect(snapAngle(13.4)).toBe(13.4);
    expect(snapAngle(-44)).toBe(-45);
    expect(snapAngle(91.4)).toBe(90);
    expect(snapAngle(88.4)).toBe(88.4);
  });

  it("keeps angles in (−180, 180]", () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(540)).toBe(180);
    expect(snapAngle(179.2)).toBe(180);
    expect(snapAngle(-179.2)).toBe(180);
  });
});

describe("ruler edge catch", () => {
  const r = { cx: 100, cy: 50, angle: 0 };
  it("catches a point near either long edge, on its own side", () => {
    // half thickness 32, reach 24: the +n (y down) edge is at y = 82
    expect(edgeNear(r, 140, 82 + 20, 32, 24, 1000)).toBe(1);
    expect(edgeNear(r, 140, 50 - 32 - 10, 32, 24, 1000)).toBe(-1);
    expect(edgeNear(r, 140, 82 + 30, 32, 24, 1000)).toBe(0);
    // past the ruler's end
    expect(edgeNear(r, 100 + 1001, 82, 32, 24, 1000)).toBe(0);
  });
});

describe("ruler ticks", () => {
  it("are 10 canvas px apart, thinned until at least 6 css px apart", () => {
    expect(tickSpacingCss(1)).toBe(10);
    expect(tickSpacingCss(0.9)).toBe(9);
    // 10 × 0.1 = 1 css px → ×5 → 5 → ×2 → 10
    expect(tickSpacingCss(0.1)).toBeCloseTo(10, 9);
    expect(tickSpacingCss(0.5)).toBe(25);
  });
});
