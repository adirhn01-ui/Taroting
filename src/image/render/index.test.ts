// PreviewResources.setView hands the stage's device size to BOTH caches. The
// photo cache sizes a slider drag's proxy by it (photos-drag.test.ts covers
// what it does with the number); this pins that the preview actually tells
// it, rather than leaving the 1920×1080 default standing on a 4K stage.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlankImageProject } from "../../core/image-project";
import { DrawingRasters } from "./drawings";
import { PreviewResources } from "./index";
import { PhotoCache } from "./photos";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PreviewResources.setView", () => {
  it("passes the stage's device size to the photo cache and the drawing rasters", () => {
    const photos = vi.spyOn(PhotoCache.prototype, "setStage");
    const drawings = vi.spyOn(DrawingRasters.prototype, "setStage");
    const doc = createBlankImageProject("Stage", 640, 360, "transparent");
    const res = new PreviewResources(() => doc);
    // A 4K stage at 2x: neither the 1920×1080 default nor the canvas size,
    // and width ≠ height so a swapped pair would show.
    res.setView({ zoom: 2, panX: 11, panY: 7 }, { w: 3840, h: 2160 });
    expect(photos).toHaveBeenCalledTimes(1);
    expect(photos).toHaveBeenLastCalledWith(3840, 2160);
    expect(drawings).toHaveBeenLastCalledWith(3840, 2160);
    // A resize follows through to both.
    res.setView({ zoom: 1, panX: 0, panY: 0 }, { w: 1366, h: 768 });
    expect(photos).toHaveBeenLastCalledWith(1366, 768);
    expect(drawings).toHaveBeenLastCalledWith(1366, 768);
    res.dispose();
  });
});
