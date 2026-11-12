import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankCover, coverPictureMatrix, type CoverPicture, type CoverPictureLoader } from "./save";

// The Home card of a PDF project whose first page is a picture page (0.9.5):
// the picture is decoded through the injected loader (the app's: fetch →
// createImageBitmap, never an <img> that would taint the canvas), at the
// card's size, and drawn turned with the page.

type Matrix = [number, number, number, number, number, number];
interface Drawn {
  matrix: Matrix;
  args: [unknown, number, number, number, number];
}

let drawn: Drawn[];
let canvases: { width: number; height: number }[];

beforeEach(() => {
  drawn = [];
  canvases = [];
  vi.stubGlobal("document", {
    createElement: () => {
      let matrix: Matrix = [1, 0, 0, 1, 0, 0];
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: "",
          fillRect: () => {},
          save: () => {},
          restore: () => {
            matrix = [1, 0, 0, 1, 0, 0];
          },
          setTransform: (...m: Matrix) => {
            matrix = m;
          },
          drawImage: (img: unknown, x: number, y: number, w: number, h: number) => {
            drawn.push({ matrix, args: [img, x, y, w, h] });
          },
        }),
        toBlob: (cb: (b: Blob | null) => void) => {
          // the size it was encoded at (the cover zeroes it afterwards)
          canvases.push({ width: c.width, height: c.height });
          cb(new Blob(["jpeg"]));
        },
      };
      return c;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A drawn box's corners through its matrix: the axis-aligned rect it covers. */
function landed(d: Drawn): { left: number; top: number; width: number; height: number } {
  const [a, b, c, dd, e, f] = d.matrix;
  const [, x, y, w, h] = d.args;
  const pts = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ].map(([px, py]) => [a * px! + c * py! + e, b * px! + dd * py! + f] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { left: r(Math.min(...xs)), top: r(Math.min(...ys)), width: r(Math.max(...xs) - Math.min(...xs)), height: r(Math.max(...ys) - Math.min(...ys)) };
}

function fakeLoader() {
  const calls: { url: string; size: { w: number; h: number }; orientation: ImageOrientation }[] = [];
  const bmp = { close: vi.fn() };
  const load: CoverPictureLoader = async (url, size, orientation) => {
    calls.push({ url, size, orientation });
    return bmp as unknown as ImageBitmap;
  };
  return { calls, bmp, load };
}

// a 600×300 page (points), the picture NOT the whole page: x 50, y 40, 200×100
const pic = (rotate: number, patch: Partial<CoverPicture> = {}): CoverPicture => ({
  url: "asset://C:/scan-01.jpg",
  box: [50, 40, 200, 100],
  pageW: 600,
  pageH: 300,
  rotate,
  ...patch,
});

describe("a picture page's Home cover", () => {
  it("unturned: the box scaled into a 240-px-wide card, decoded at that size", async () => {
    const l = fakeLoader();
    await blankCover(600, 300, 240, pic(0), l.load);
    expect(canvases[0]).toMatchObject({ width: 240, height: 120 });
    expect(drawn).toHaveLength(1);
    expect(landed(drawn[0]!)).toEqual({ left: 20, top: 16, width: 80, height: 40 });
    expect(l.calls).toEqual([{ url: "asset://C:/scan-01.jpg", size: { w: 80, h: 40 }, orientation: "from-image" }]);
    expect(drawn[0]!.args[0]).toBe(l.bmp);
    expect(l.bmp.close).toHaveBeenCalledTimes(1);
  });

  it("turned 90°: the card is the turned page and the box turns with it", async () => {
    const l = fakeLoader();
    // the shell passes the TURNED size: 300 wide × 600 tall
    await blankCover(300, 600, 240, pic(90), l.load);
    expect(canvases[0]).toMatchObject({ width: 120, height: 240 });
    // (x, y) → (H − y, x) at 0.4 px/pt: x 64..104, y 20..100
    expect(landed(drawn[0]!)).toEqual({ left: 64, top: 20, width: 40, height: 80 });
    // decoded upright at the box's own size (the turn is the canvas's)
    expect(l.calls[0]!.size).toEqual({ w: 80, h: 40 });
  });

  it("turned 180° and 270°", async () => {
    let l = fakeLoader();
    await blankCover(600, 300, 240, pic(180), l.load);
    // (x, y) → (W − x, H − y) at 0.4: x 140..220, y 64..104
    expect(landed(drawn[0]!)).toEqual({ left: 140, top: 64, width: 80, height: 40 });
    drawn = [];
    l = fakeLoader();
    await blankCover(300, 600, 240, pic(270), l.load);
    // (x, y) → (y, W − x) at 0.4: x 16..56, y 140..220
    expect(landed(drawn[0]!)).toEqual({ left: 16, top: 140, width: 40, height: 80 });
  });

  it("a file the WebView leaves unturned is decoded unturned; a missing file leaves the card white", async () => {
    const l = fakeLoader();
    await blankCover(600, 300, 240, pic(0, { noAutorotate: true }), l.load);
    expect(l.calls[0]!.orientation).toBe("none");
    drawn = [];
    const blob = await blankCover(600, 300, 240, pic(0), async () => null);
    expect(blob.size).toBeGreaterThan(0);
    expect(drawn).toEqual([]);
    const thrown = await blankCover(600, 300, 240, pic(0), async () => {
      throw new Error("decode");
    });
    expect(thrown.size).toBeGreaterThan(0);
  });

  it("the matrix maps the page's corners onto the card's corners for every turn", () => {
    for (const rotate of [0, 90, 180, 270]) {
      const side = rotate % 180 !== 0;
      const coverW = side ? 150 : 300;
      const { m } = coverPictureMatrix({ pageW: 600, pageH: 300, rotate }, coverW);
      const ys = [0, 600]
        .flatMap((x) => [0, 300].map((y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]))
        .map(([px, py]) => [Math.round(px! * 1e6) / 1e6 + 0, Math.round(py! * 1e6) / 1e6 + 0]);
      const W = Math.max(...ys.map((p) => p[0]!));
      const H = Math.max(...ys.map((p) => p[1]!));
      expect([Math.min(...ys.map((p) => p[0]!)), Math.min(...ys.map((p) => p[1]!)), W, H], `rotate ${rotate}`).toEqual(
        side ? [0, 0, 150, 300] : [0, 0, 300, 150],
      );
    }
  });
});
