import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stroke } from "../../core/types";
import { encodePoints } from "../strokes";
import { GRAIN_ALPHA_MAX, GRAIN_ALPHA_MIN, grainAlpha } from "./grain";
import { ARROW_HEAD_DEG, ARROW_HEAD_WIDTHS, createScratch, paintLiveMark, paintStroke, strokeBounds } from "./paint";

/** [x, y, pressure]* → the stored `p`. */
const pts = (...xyp: number[]): string => encodePoints(new Float32Array(xyp));

// Three points whose extremes come from different points on each axis:
// x 10..40, y -5..60.
const P = pts(10, 20, 0.5, 40, -5, 1, 25, 60, 0.25);

describe("strokeBounds", () => {
  it("pads an ink or erase stroke by half its width", () => {
    for (const s of [
      { t: "pen", c: "#112233", w: 6, o: 1, p: P },
      { t: "marker", c: "#ffd400", w: 6, o: 0.4, p: P },
      { t: "erase", w: 6, p: P },
    ] as Stroke[]) {
      expect(strokeBounds(s), s.t).toEqual({ x: 7, y: -8, w: 36, h: 71 });
    }
  });

  it("pads a pencil by its widest mark, 1.5 widths", () => {
    const s: Stroke = { t: "pencil", c: "#3a3a3a", w: 6, o: 0.65, p: P };
    expect(strokeBounds(s)).toEqual({ x: 5.5, y: -9.5, w: 39, h: 74 });
  });

  it("bounds a shape by its endpoints, whichever way it was drawn", () => {
    for (const t of ["line", "rect", "ellipse"] as const) {
      const s: Stroke = { t, c: "#e5484d", w: 4, a: [100, 50], b: [-20, 5] };
      expect(strokeBounds(s), t).toEqual({ x: -22, y: 3, w: 124, h: 49 });
    }
  });

  it("reaches both arrow-head wings, which can stick out past the endpoints", () => {
    // Pointing straight down the page: the shaft has no width in x, so only
    // the wings (and the half-width) give the box any.
    const w = 2;
    const s: Stroke = { t: "arrow", c: "#e5484d", w, a: [50, 100], b: [50, 0] };
    const head = ARROW_HEAD_WIDTHS * w;
    const rad = (ARROW_HEAD_DEG * Math.PI) / 180;
    const spread = head * Math.sin(rad);
    const b = strokeBounds(s);
    expect(b.x).toBeCloseTo(50 - spread - w / 2, 9);
    expect(b.w).toBeCloseTo(2 * spread + w, 9);
    expect(b.y).toBeCloseTo(0 - w / 2, 9);
    expect(b.h).toBeCloseTo(100 + w, 9);
    // The same arrow as a plain line is exactly the shaft.
    expect(strokeBounds({ ...s, t: "line" }).w).toBe(w);
  });

  it("caches per stroke object, and a stroke with nothing decodable is an empty box", () => {
    const s: Stroke = { t: "pen", c: "#112233", w: 6, o: 1, p: P };
    expect(strokeBounds(s)).toBe(strokeBounds(s));
    expect(strokeBounds({ t: "pen", c: "#112233", w: 6, o: 1, p: "not base64!" })).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});

/* ---------------- painting, against a recording context ---------------- */

/** Records every path op, so a test can see what one stroke became. */
class FakePath {
  ops: string[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(`M${x},${y}`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`L${x},${y}`);
  }
  arc(): void {
    this.ops.push("A");
  }
  ellipse(): void {
    this.ops.push("E");
  }
  closePath(): void {
    this.ops.push("Z");
  }
}

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  gco: string;
  fill: unknown;
  stroke: unknown;
  lineWidth: number;
  lineCap: string;
}

/** A 2D context double: state is real (a save/restore stack), draws are logged
 *  with the state they ran under. Transform scale 2, offset (10, 20) — so
 *  device px differ from layer px on both axes. */
function recorder(width = 400, height = 300) {
  const calls: Call[] = [];
  const stack: Record<string, unknown>[] = [];
  const st = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#123456" as unknown,
    strokeStyle: "#123456" as unknown,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    m: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 },
  };
  const log = (op: string, args: unknown[]): void => {
    calls.push({
      op,
      args,
      alpha: st.globalAlpha,
      gco: st.globalCompositeOperation,
      fill: st.fillStyle,
      stroke: st.strokeStyle,
      lineWidth: st.lineWidth,
      lineCap: st.lineCap,
    });
  };
  const ctx = {
    canvas: { width, height } as unknown,
    get globalAlpha() {
      return st.globalAlpha;
    },
    set globalAlpha(v: number) {
      st.globalAlpha = v;
    },
    get globalCompositeOperation() {
      return st.globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      st.globalCompositeOperation = v;
    },
    get fillStyle() {
      return st.fillStyle;
    },
    set fillStyle(v: unknown) {
      st.fillStyle = v;
    },
    get strokeStyle() {
      return st.strokeStyle;
    },
    set strokeStyle(v: unknown) {
      st.strokeStyle = v;
    },
    get lineWidth() {
      return st.lineWidth;
    },
    set lineWidth(v: number) {
      st.lineWidth = v;
    },
    get lineCap() {
      return st.lineCap;
    },
    set lineCap(v: string) {
      st.lineCap = v;
    },
    get lineJoin() {
      return st.lineJoin;
    },
    set lineJoin(v: string) {
      st.lineJoin = v;
    },
    save: () => stack.push({ ...st, m: { ...st.m } }),
    restore: () => Object.assign(st, stack.pop()),
    getTransform: () => ({ ...st.m }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      st.m = { a, b, c, d, e, f };
      log("setTransform", [a, b, c, d, e, f]);
    },
    fill: (...args: unknown[]) => log("fill", args),
    stroke: (...args: unknown[]) => log("stroke", args),
    fillRect: (...args: unknown[]) => log("fillRect", args),
    clearRect: (...args: unknown[]) => log("clearRect", args),
    drawImage: (...args: unknown[]) => log("drawImage", args),
    beginPath: () => log("beginPath", []),
    arc: (...args: unknown[]) => log("arc", args),
    createPattern: () => ({ pattern: true }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  };
  return { ctx, calls, depth: () => stack.length };
}

/** Every scratch context created, in order. */
let scratchCtxs: ReturnType<typeof recorder>[] = [];

beforeEach(() => {
  scratchCtxs = [];
  vi.stubGlobal("Path2D", FakePath);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      private rec: ReturnType<typeof recorder> | null = null;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        if (!this.rec) {
          this.rec = recorder(this.width, this.height);
          this.rec.ctx.canvas = this;
          scratchCtxs.push(this.rec);
        }
        return this.rec.ctx;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type PaintCtx = Parameters<typeof paintStroke>[0];
const as = (c: unknown): PaintCtx => c as PaintCtx;

describe("paintStroke", () => {
  it("fills a pen stroke that loops over itself ONCE, nonzero, at its opacity", () => {
    // A loop that crosses itself: evenodd would punch a hole at the crossing,
    // and a fill per segment would paint the overlap twice.
    const loop = pts(10, 10, 1, 60, 10, 1, 60, 60, 1, 30, 60, 0.5, 30, 0, 0.5, 40, -10, 1);
    const r = recorder();
    r.ctx.globalAlpha = 0.8;
    paintStroke(as(r.ctx), { t: "pen", c: "#aB1122", w: 6, o: 0.5, p: loop }, createScratch());
    const fills = r.calls.filter((c) => c.op === "fill");
    expect(fills).toHaveLength(1);
    // no fill-rule argument = nonzero
    expect(fills[0]!.args).toHaveLength(1);
    expect(fills[0]!.args[0]).toBeInstanceOf(FakePath);
    // multiplies the context's own alpha
    expect(fills[0]!.alpha).toBeCloseTo(0.4, 9);
    expect(fills[0]!.fill).toBe("#ab1122");
    expect(fills[0]!.gco).toBe("source-over");
    expect(r.depth()).toBe(0);
    expect(r.ctx.globalAlpha).toBe(0.8);
  });

  it("strokes a marker once, under the ink (destination-over), at 0.4", () => {
    const r = recorder();
    paintStroke(as(r.ctx), { t: "marker", c: "#ffd400", w: 18, o: 0.4, p: P }, createScratch());
    const strokes = r.calls.filter((c) => c.op === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({
      gco: "destination-over",
      alpha: 0.4,
      lineWidth: 18,
      lineCap: "round",
      stroke: "#ffd400",
    });
    expect(r.calls.some((c) => c.op === "fill")).toBe(false);
  });

  it("paints the LIVE marks exactly as they commit (the renderer isolates the layer)", () => {
    const live = new Float32Array([10, 20, 1, 40, -5, 1]);
    const r = recorder();
    paintLiveMark(as(r.ctx), { t: "marker", c: "#ffd400", w: 18, o: 0.4, pts: live, count: 2 }, createScratch());
    expect(r.calls.filter((c) => c.op === "stroke").map((c) => [c.gco, c.alpha])).toEqual([["destination-over", 0.4]]);
    // the pixel eraser's live path cuts, at full strength
    const e = recorder();
    e.ctx.globalAlpha = 0.5;
    paintLiveMark(as(e.ctx), { t: "erase", c: "#000000", w: 12, o: 1, pts: live, count: 2 }, createScratch());
    expect(e.calls.filter((c) => c.op === "stroke").map((c) => [c.gco, c.alpha, c.lineWidth])).toEqual([
      ["destination-out", 1, 12],
    ]);
  });

  it("erases with destination-out at full alpha, whatever alpha was set", () => {
    const r = recorder();
    r.ctx.globalAlpha = 0.3;
    paintStroke(as(r.ctx), { t: "erase", w: 9, p: P }, createScratch());
    const s = r.calls.filter((c) => c.op === "stroke");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ gco: "destination-out", alpha: 1, lineWidth: 9 });
    expect(r.ctx.globalCompositeOperation).toBe("source-over");
    expect(r.ctx.globalAlpha).toBe(0.3);
  });

  it("taps (one point) with the marker and the eraser still leave a dot", () => {
    const one = pts(12, 34, 1);
    for (const s of [
      { t: "marker", c: "#ffd400", w: 10, o: 0.4, p: one },
      { t: "erase", w: 10, p: one },
    ] as Stroke[]) {
      const r = recorder();
      paintStroke(as(r.ctx), s, createScratch());
      const arc = r.calls.find((c) => c.op === "arc")!;
      expect(arc.args.slice(0, 3), s.t).toEqual([12, 34, 5]);
      expect(r.calls.filter((c) => c.op === "fill")).toHaveLength(1);
    }
  });

  it("cuts a pencil through the grain in a device-px scratch, then composites at o", () => {
    const r = recorder();
    const s: Stroke = { t: "pencil", c: "#3a3a3a", w: 4, o: 0.65, p: pts(20, 30, 0.5, 60, 50, 1) };
    paintStroke(as(r.ctx), s, createScratch());
    // The grain tile is built first (its own canvas); the scratch is the one
    // the stroke was filled into.
    const sc = scratchCtxs.find((c) => c.calls.some((k) => k.op === "fill"));
    expect(sc).toBeDefined();
    // bounds 17..63 × 27..53 (pad 1.5w/2 = 3) → device ×2 + (10, 20) =
    // 44..136 × 74..126, one pixel of margin → 43..137 × 73..127
    const setT = sc!.calls.find((c) => c.op === "setTransform" && c.args[0] === 2)!;
    expect(setT.args).toEqual([2, 0, 0, 2, 10 - 43, 20 - 73]);
    const ops = sc!.calls.filter((c) => c.op === "fill" || c.op === "fillRect").map((c) => [c.op, c.gco]);
    expect(ops).toEqual([
      ["fill", "source-over"],
      ["fillRect", "destination-in"],
    ]);
    expect(sc!.calls.find((c) => c.op === "fillRect")!.fill).toEqual({ pattern: true });
    const draw = r.calls.find((c) => c.op === "drawImage")!;
    expect(draw.args.slice(1)).toEqual([0, 0, 94, 54, 43, 73, 94, 54]);
    expect(draw.alpha).toBeCloseTo(0.65, 9);
    expect(draw.gco).toBe("source-over");
  });

  it("strokes an arrow's shaft and both wings in one path", () => {
    const r = recorder();
    paintStroke(as(r.ctx), { t: "arrow", c: "#e5484d", w: 3, a: [0, 0], b: [100, 0] }, createScratch());
    const s = r.calls.filter((c) => c.op === "stroke");
    expect(s).toHaveLength(1);
    const path = s[0]!.args[0] as FakePath;
    // shaft M,L then wing M,L(tip),L
    expect(path.ops.filter((o) => o.startsWith("M"))).toHaveLength(2);
    expect(path.ops.filter((o) => o === "L100,0")).toHaveLength(2);
    expect(s[0]).toMatchObject({ lineWidth: 3, lineCap: "round", stroke: "#e5484d" });
  });

  it("never lets an invalid colour keep the previous fillStyle", () => {
    const r = recorder();
    paintStroke(as(r.ctx), { t: "pen", c: "red; x", w: 3, o: 1, p: P }, createScratch());
    expect(r.calls.find((c) => c.op === "fill")!.fill).toBe("#000000");
  });
});

describe("pencil grain", () => {
  it("is deterministic, within 150..255, and not flat", () => {
    const a = grainAlpha();
    const b = grainAlpha();
    expect(a).toEqual(b);
    expect(a.length).toBe(64 * 64);
    let min = 255;
    let max = 0;
    for (const v of a) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(GRAIN_ALPHA_MIN);
    expect(max).toBeLessThanOrEqual(GRAIN_ALPHA_MAX);
    expect(max - min).toBeGreaterThan(90);
  });
});
