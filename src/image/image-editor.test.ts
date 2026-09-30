import { describe, expect, it } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import type { MediaInfo, ProjectFile } from "../core/types";
import { IMG_ICON_PATHS } from "./icons";
import { SIZE_LADDER, canvasMenuButton, dropRefusal, exportSourceHint, stepSize } from "./image-editor";
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

describe("dropRefusal", () => {
  const CROP = "Finish the crop first, then drop the images again.";
  const DIALOG = "Close the dialog first, then drop the images again.";
  const PICKER = "Close the open menu or picker first, then drop the images again.";

  it("takes a drop only when nothing is open", () => {
    expect(dropRefusal("idle", false, false)).toBeNull();
  });

  it("refuses behind an open picker or menu (they hold the keyboard, not a dialog)", () => {
    // A colour picker survives the trip to File Explorer (it is not closed on
    // blur), and a layer added under its preview would record that colour.
    expect(dropRefusal("idle", false, true)).toBe(PICKER);
  });

  it("names the crop first, though a crop holds the keyboard too", () => {
    expect(dropRefusal("crop-layer", false, true)).toBe(CROP);
    expect(dropRefusal("crop-image", true, true)).toBe(CROP);
    expect(dropRefusal("idle", true, true)).toBe(DIALOG);
  });
});

describe("the tool row's Canvas button", () => {
  // The owner read the old "Image" button with the crop glyph as "crop the
  // layer I selected"; it acts on the whole canvas, and now says so.
  const html = canvasMenuButton();

  it("is named Canvas and says what it acts on", () => {
    expect(html).toMatch(/>Canvas<\/button>$/);
    expect(html).toContain('title="Canvas: crop, resize, rotate or flip the whole picture"');
    expect(html).not.toMatch(/>Image</);
  });

  it("wears the artboard glyph, never the crop one", () => {
    expect(html).toContain(IMG_ICON_PATHS.canvas);
    expect(html).not.toContain(IMG_ICON_PATHS.crop);
  });

  it("keeps the id and the menu role the shell and the E2E find it by", () => {
    expect(html).toContain('id="imged-menu"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
