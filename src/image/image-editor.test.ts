import { describe, expect, it } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import type { MediaInfo, ProjectFile } from "../core/types";
import { SIZE_LADDER, exportSourceHint, stepSize } from "./image-editor";
import { addPhotoLayer, layersOf } from "./layers";
import { SIZE_MAX, SIZE_MIN } from "./tool-state";

const photo = (path: string, w = 320, h = 180): MediaInfo => ({
  path,
  size: 1234,
  mtimeMs: 9,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
  oriented: true,
});

/** Photos added in order, each above the last: the FIRST one is bottom-most. */
function withPhotos(...paths: string[]): ProjectFile {
  let p = createBlankImageProject("Holiday card", 641, 361, "#ffffff");
  let top: string | null = null;
  for (const path of paths) {
    const r = addPhotoLayer(p, photo(path), { above: top });
    p = r.project;
    top = r.trackId;
  }
  return p;
}

describe("stepSize", () => {
  it("steps between rungs to the nearest rung in that direction", () => {
    // Off-ladder values (5, 7, 10, 150) so "next rung" cannot pass as "±1".
    expect(stepSize(5, 1)).toBe(6);
    expect(stepSize(5, -1)).toBe(4);
    expect(stepSize(7, 1)).toBe(8);
    expect(stepSize(7, -1)).toBe(6);
    expect(stepSize(10, 1)).toBe(12);
    expect(stepSize(150, -1)).toBe(128);
    expect(stepSize(150, 1)).toBe(200);
  });

  it("from a rung, moves one whole rung", () => {
    expect(stepSize(16, 1)).toBe(24);
    expect(stepSize(16, -1)).toBe(12);
  });

  it("stops at the tool range at both ends", () => {
    expect(stepSize(SIZE_MIN, -1)).toBe(SIZE_MIN);
    expect(stepSize(SIZE_MAX, 1)).toBe(SIZE_MAX);
    // Out-of-range stored values come back inside it.
    expect(stepSize(0.4, -1)).toBe(SIZE_MIN);
    expect(stepSize(0.4, 1)).toBe(1);
    expect(stepSize(900, 1)).toBe(SIZE_MAX);
    expect(stepSize(900, -1)).toBe(SIZE_MAX);
  });

  it("the ladder spans exactly the tool range", () => {
    expect(SIZE_LADDER[0]).toBe(SIZE_MIN);
    expect(SIZE_LADDER[SIZE_LADDER.length - 1]).toBe(SIZE_MAX);
  });
});

describe("exportSourceHint", () => {
  it("follows the bottom-most photo, not the top one or the project name", () => {
    const p = withPhotos("C:\\pics\\Beach Day.JPEG", "D:\\scans\\Overlay.webp");
    // Guard the fixture: two photos, and the first added is the last layer
    // (bottom of the stack).
    const photos = layersOf(p).filter((l) => l.kind === "photo");
    expect(photos.map((l) => l.name)).toEqual(["Overlay", "Beach Day"]);
    expect(exportSourceHint(p)).toEqual({ stem: "Beach Day", ext: "jpg" });
  });

  it("maps each exportable extension and refuses the rest", () => {
    expect(exportSourceHint(withPhotos("C:\\a\\Scan.png")).ext).toBe("png");
    expect(exportSourceHint(withPhotos("C:\\a\\Scan.jpg")).ext).toBe("jpg");
    expect(exportSourceHint(withPhotos("C:\\a\\Scan.WebP")).ext).toBe("webp");
    expect(exportSourceHint(withPhotos("C:\\a\\Old scan.bmp"))).toEqual({ stem: "Old scan", ext: null });
  });

  it("falls back to the project name with no photo", () => {
    expect(exportSourceHint(withPhotos())).toEqual({ stem: "Holiday card", ext: null });
  });
});
