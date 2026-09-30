import { describe, expect, it } from "vitest";
import type { MediaInfo } from "./types";
import { DEFAULT_EXPORT_PRESET } from "./types";
import {
  createBlankImageProject,
  createPhotoImageProject,
  IMAGE_BLANK_PRESETS,
  isImageProject,
} from "./image-project";
import { checkInvariants, createProject } from "./project";

const still = (patch: Partial<MediaInfo> = {}): MediaInfo => ({
  path: "C:\\Users\\me\\Pictures\\Beach day.jpeg",
  size: 98765,
  mtimeMs: 1234,
  kind: "image",
  duration: 0,
  width: 36,
  height: 64,
  hasAudio: false,
  oriented: true,
  ...patch,
});

describe("createBlankImageProject", () => {
  it("is a schema-3 image project with one empty video track and the canvas as given", () => {
    const p = createBlankImageProject("Poster", 641, 361, "#ffffff");
    expect(p).toMatchObject({ schema: 3, kind: "image", app: "taroting", name: "Poster", media: [] });
    expect(p.timeline).toMatchObject({ width: 641, height: 361, fps: { num: 30, den: 1 } });
    expect(p.timeline.tracks).toHaveLength(1);
    expect(p.timeline.tracks[0]).toMatchObject({ kind: "video", clips: [] });
    expect(p.image).toEqual({ background: "#ffffff" });
    expect(p.export).toEqual(DEFAULT_EXPORT_PRESET);
    expect(p.export).not.toBe(DEFAULT_EXPORT_PRESET);
    expect(isImageProject(p)).toBe(true);
    expect(checkInvariants(p)).toEqual([]);
  });

  it("guards the canvas with the image rule, not the video one", () => {
    const side = (w: number, h: number): number[] => {
      const t = createBlankImageProject("x", w, h, "transparent").timeline;
      return [t.width, t.height];
    };
    expect(side(70000, 0)).toEqual([65535, 1]);
    expect(side(NaN, 2480.6)).toEqual([1, 2481]);
    expect(side(9000, 7)).toEqual([9000, 7]); // above 8192, odd: both fine here
  });

  it("normalizes the background, and an unreadable one is transparent", () => {
    const bg = (b: string): string => createBlankImageProject("x", 10, 10, b).image!.background;
    expect(bg("#ABC")).toBe("#aabbcc");
    expect(bg("000000")).toBe("#000000");
    expect(bg("transparent")).toBe("transparent");
    expect(bg("red")).toBe("transparent");
  });

  it("offers the presets Home lists", () => {
    expect(IMAGE_BLANK_PRESETS.map((p) => `${p.w}x${p.h}`)).toContain("2480x3508");
  });
});

describe("createPhotoImageProject", () => {
  it("makes the canvas the photo's size with the photo as its one layer at scale 1", () => {
    const p = createPhotoImageProject("Beach day", still());
    expect(p).toMatchObject({ schema: 3, kind: "image", name: "Beach day" });
    expect(p.image).toEqual({ background: "transparent" });
    expect([p.timeline.width, p.timeline.height]).toEqual([36, 64]);
    expect(p.media).toHaveLength(1);
    const m = p.media[0]!;
    expect(m).toEqual({ id: m.id, ...still() });
    expect(p.timeline.tracks).toHaveLength(1);
    const track = p.timeline.tracks[0]!;
    expect(track).toMatchObject({ kind: "video", name: "Beach day", muted: false });
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]).toMatchObject({
      mediaId: m.id,
      timelineStart: 0,
      srcIn: 0,
      srcOut: 1,
      speed: 1,
      transform: { scale: 1, x: 0, y: 0, rotate: 0, flipH: false, flipV: false, opacity: 1 },
    });
    expect(checkInvariants(p)).toEqual([]);
  });

  it("keeps an odd, wide photo's exact size and its orientation flags", () => {
    const p = createPhotoImageProject("Pano", still({ width: 12001, height: 641, noAutorotate: true }));
    expect([p.timeline.width, p.timeline.height]).toEqual([12001, 641]);
    expect(p.media[0]).toMatchObject({ noAutorotate: true, oriented: true });
  });

  it("refuses anything that is not a still with a size", () => {
    expect(() => createPhotoImageProject("x", still({ kind: "video" }))).toThrow();
    expect(() => createPhotoImageProject("x", still({ generator: { type: "solid", color: "#000000" } }))).toThrow();
    expect(() => createPhotoImageProject("x", still({ width: 0 }))).toThrow();
    expect(() => createPhotoImageProject("x", still({ height: undefined }))).toThrow();
  });
});

describe("isImageProject", () => {
  it("is false for a video project", () => {
    expect(isImageProject(createProject("Video"))).toBe(false);
  });
});
