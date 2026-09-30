import { describe, expect, it } from "vitest";
import type { MediaRef, ProjectFile } from "../core/types";
import { DEFAULT_EXPORT_PRESET } from "../core/types";
import { isProjectSource } from "../editor/export/export-dialog";
import {
  defaultFileName,
  defaultFolder,
  customSizeFits,
  defaultImagePreset,
  exportSources,
  extForImageFormat,
  lockedSide,
  planOutput,
  qualityReadout,
  sanitizeImagePreset,
} from "./export-dialog";

function media(id: string, path: string, extra: Partial<MediaRef> = {}): MediaRef {
  return { id, path, size: 10, mtimeMs: 1, kind: "image", duration: 0, hasAudio: false, width: 64, height: 36, ...extra };
}

function project(over: Partial<ProjectFile> = {}): ProjectFile {
  return {
    schema: 3,
    kind: "image",
    app: "taroting",
    id: "p1",
    name: "Harbour at dusk",
    createdAt: "",
    modifiedAt: "",
    media: [media("m1", "D:\\Photos\\Trip\\IMG_0042.JPG"), media("m2", "Text", { generator: { type: "solid", color: "#112233" } })],
    timeline: { fps: { num: 30, den: 1 }, width: 641, height: 361, tracks: [] },
    export: DEFAULT_EXPORT_PRESET,
    image: { background: "transparent" },
    ...over,
  };
}

describe("image export dialog helpers", () => {
  it("gates WebP at 16383 px a side: 16383 is allowed, 16384 is not (on either axis)", () => {
    expect(planOutput({ w: 16383, h: 900 }, 16383, 900).webpOk).toBe(true);
    expect(planOutput({ w: 16384, h: 900 }, 16384, 900).webpOk).toBe(false);
    expect(planOutput({ w: 700, h: 16384 }, 700, 16384).webpOk).toBe(false);
  });

  it("works a percentage out on the canvas: 50% of 641×361 is 321×181, 25% is 160×90", () => {
    expect(planOutput(50, 641, 361).out).toEqual({ w: 321, h: 181 });
    expect(planOutput(25, 641, 361).out).toEqual({ w: 160, h: 90 });
    expect(planOutput(100, 641, 361)).toMatchObject({ out: { w: 641, h: 361 }, reduced: false, large: false });
  });

  it("reports a reduced render and a large export", () => {
    const p = planOutput(100, 40000, 1000);
    expect(p.reduced).toBe(true);
    expect(p.out).toEqual({ w: 32767, h: 819 });
    expect(planOutput(100, 8000, 6251).large).toBe(true);
    expect(planOutput(100, 8000, 6250).large).toBe(false);
  });

  it("says Lossless only for WebP at 100", () => {
    expect(qualityReadout("webp", 100)).toBe("Lossless");
    expect(qualityReadout("webp", 99)).toBe("99");
    expect(qualityReadout("jpeg", 100)).toBe("100");
  });

  it("opens on the source's format and an (edited) name", () => {
    const p = project();
    expect(defaultImagePreset(p, { stem: "IMG_0042", ext: "jpg" })).toEqual({ format: "jpeg", quality: 92, size: 100 });
    expect(defaultImagePreset(p, { stem: "scan", ext: "png" }).format).toBe("png");
    expect(defaultImagePreset(p, { stem: "", ext: null }).format).toBe("png");
    expect(defaultFileName(p, { stem: "IMG_0042", ext: "jpg" })).toBe("IMG_0042 (edited)");
    expect(defaultFileName(p, { stem: "", ext: null })).toBe("Harbour at dusk");
    expect(extForImageFormat("jpeg")).toBe("jpg");
  });

  it("prefers the project's last preset over the source's format", () => {
    const p = project({ image: { background: "#000000", export: { format: "webp", quality: 71, size: 25 } } });
    expect(defaultImagePreset(p, { stem: "IMG_0042", ext: "jpg" })).toEqual({ format: "webp", quality: 71, size: 25 });
  });

  it("keeps a remembered custom size only while the canvas still has its shape", () => {
    const saved = { format: "jpeg" as const, quality: 80, size: { w: 1920, h: 1080 } };
    const at = (width: number, height: number) =>
      defaultImagePreset(project({ image: { background: "transparent", export: saved }, timeline: { fps: { num: 30, den: 1 }, width, height, tracks: [] } }), {
        stem: "IMG_0042",
        ext: "jpg",
      });
    // the landscape canvas it was chosen on (3840×2160): kept as it is
    expect(at(3840, 2160)).toEqual(saved);
    // rotated to portrait, or cropped square: 100%, never a stretched 1920×1080
    expect(at(2160, 3840)).toEqual({ format: "jpeg", quality: 80, size: 100 });
    expect(at(2000, 2000)).toEqual({ format: "jpeg", quality: 80, size: 100 });
    // a pixel of rounding either way is still the same shape
    expect(at(3841, 2161)).toEqual(saved);
  });

  it("a custom size fits when either side was the one typed", () => {
    // typed h = 2 on a 10×1000 canvas → w = round(0.02), clamped to 1; re-deriving
    // h from that w gives 100, so only the h→w direction recognises the pair
    expect(customSizeFits({ w: 1, h: 2 }, 10, 1000)).toBe(true);
    expect(customSizeFits({ w: 1, h: 300 }, 10, 1000)).toBe(false);
    expect(customSizeFits({ w: 100, h: 50 }, 0, 1000)).toBe(false);
  });

  it("whitelists a crafted persisted preset", () => {
    expect(sanitizeImagePreset({ format: "gif", quality: 50, size: 100 })).toBeNull();
    expect(sanitizeImagePreset({ format: "jpeg", quality: 400.6, size: 33 })).toEqual({ format: "jpeg", quality: 100, size: 100 });
    expect(sanitizeImagePreset({ format: "png", quality: -3, size: { w: 12.4, h: 0 } })).toEqual({ format: "png", quality: 1, size: 100 });
    expect(sanitizeImagePreset({ format: "png", quality: 7, size: { w: 12.4, h: 9.6 } })).toEqual({ format: "png", quality: 7, size: { w: 12, h: 10 } });
  });

  it("flags the original under another spelling (case, separators) before any overwrite prompt", () => {
    const target = "C:\\A\\b.JPG";
    expect(isProjectSource(target, [media("x", "c:/a/B.jpg")])).toBe(true);
    expect(isProjectSource(target, [media("x", "c:/a/B (edited).jpg")])).toBe(false);
  });

  it("builds sources from the project's files only (no generators)", () => {
    expect(exportSources(project())).toEqual(["D:\\Photos\\Trip\\IMG_0042.JPG"]);
  });

  it("picks the folder: last export, else default, else the first photo's folder", () => {
    const p = project();
    expect(defaultFolder({ lastExportDir: "E:\\Out", defaultExportDir: "F:\\Def" }, p)).toBe("E:\\Out");
    expect(defaultFolder({ lastExportDir: null, defaultExportDir: "F:\\Def" }, p)).toBe("F:\\Def");
    expect(defaultFolder({ lastExportDir: null, defaultExportDir: null }, p)).toBe("D:\\Photos\\Trip");
    expect(defaultFolder({ lastExportDir: null, defaultExportDir: null }, project({ media: [] }))).toBe("");
  });

  it("keeps a custom size on the canvas aspect", () => {
    expect(lockedSide(1282, 641, 361)).toBe(722);
    expect(lockedSide(90, 361, 641)).toBe(160);
    expect(lockedSide(0, 641, 361)).toBe(1);
  });
});
