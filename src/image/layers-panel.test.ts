import { describe, expect, it, vi } from "vitest";
import type { Layer } from "./layers";

// maxRenderSize belongs to the renderer; the panel only words its answer.
vi.mock("./render/export", () => ({
  maxRenderSize: (w: number, h: number) =>
    w * h > 268_435_456
      ? { w: Math.floor(w / 2), h: Math.floor(h / 2), reduced: true }
      : { w, h, reduced: false },
}));

const { dropGap, dropIndex, layerSubLabel } = await import("./layers-panel");

function layer(kind: Layer["kind"], w: number, h: number): Layer {
  return {
    trackId: "t", clipId: "c", mediaId: "m", kind, name: "n", hidden: false, index: 0,
    clip: {} as Layer["clip"],
    media: { id: "m", path: "p", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: w, height: h },
    transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
  };
}

describe("row drag reorder", () => {
  // Four rows of uneven heights (midpoints 17, 58, 101, 139), so a gap test
  // cannot pass by dividing evenly.
  const mids = [17, 58, 101, 139];

  it("the gap is the number of rows whose midpoint is above the pointer", () => {
    expect(dropGap(mids, 3)).toBe(0);
    expect(dropGap(mids, 17.5)).toBe(1);
    expect(dropGap(mids, 100)).toBe(2);
    expect(dropGap(mids, 138)).toBe(3);
    expect(dropGap(mids, 400)).toBe(4);
  });

  it("maps a gap to the index the layer ends at (its own two gaps = stay)", () => {
    // dragging row 1 (second from the top)
    expect(dropIndex(1, 0)).toBe(0); // to the very top
    expect(dropIndex(1, 1)).toBe(1); // the gap above itself: no move
    expect(dropIndex(1, 2)).toBe(1); // the gap below itself: no move
    expect(dropIndex(1, 3)).toBe(2); // below the next row
    expect(dropIndex(1, 4)).toBe(3); // to the bottom
    // dragging the top row below the photo underneath it
    expect(dropIndex(0, 2)).toBe(1);
  });
});

describe("layer sub-label", () => {
  it("names the kind and a photo's pixel size", () => {
    expect(layerSubLabel(layer("photo", 4032, 3024), 0)).toBe("Photo · 4032×3024");
    expect(layerSubLabel(layer("solid", 641, 361), 0)).toBe("Solid color · 641×361");
    expect(layerSubLabel(layer("drawing", 641, 361), 1)).toBe("Drawing · 1 stroke");
    expect(layerSubLabel(layer("drawing", 641, 361), 12)).toBe("Drawing · 12 strokes");
  });

  it("says when a photo is too big to render at full size", () => {
    expect(layerSubLabel(layer("photo", 20000, 15000), 0)).toBe(
      "Photo · 20000×15000 · exports at 10000×7500",
    );
  });
});
