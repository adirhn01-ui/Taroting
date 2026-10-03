import { describe, expect, it } from "vitest";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";
import { draw, type RenderInput, type TimelineColors } from "./render";

// What the timeline writes on a clip. A generated element's MediaRef.path is
// the label stamped when it was created; the clip must be named from what it
// is NOW, and a label holding a dot must not be cut at it. The path below is
// "Text — www.site.com" while the text is "Hello", so the old reading
// ("Text — www.site") and the right one ("Text — Hello") cannot coincide.

/** A 2D context that records the text it is asked to draw and accepts every
 *  other call. */
function recordingContext(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[] = [];
  const target: Record<string | symbol, unknown> = {
    fillText: (s: string) => void texts.push(s),
  };
  const ctx = new Proxy(target, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => {
      o[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const colors = new Proxy({}, { get: () => "#000000" }) as TimelineColors;

function input(media: MediaRef[], clips: Clip[]): RenderInput {
  const project: ProjectFile = {
    schema: 2, app: "taroting", id: "p", name: "P", createdAt: "", modifiedAt: "", media,
    timeline: {
      fps: { num: 30, den: 1 }, width: 1920, height: 1080,
      tracks: [{ id: "v1", kind: "video", name: "Video", muted: false, clips }],
    },
    export: {} as ProjectFile["export"],
  };
  return {
    project, t0: 0, pxPerSec: 50, width: 1200, height: 200, playhead: 0, selectedClipId: null,
    drag: null, guideT: null, colors, waveforms: {}, mediaById: new Map(media.map((m) => [m.id, m])),
  };
}

const clip = (id: string, mediaId: string, at: number): Clip => ({
  id, mediaId, timelineStart: at, srcIn: 0, srcOut: 4, speed: 1,
  transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
  audio: { volume: 1, muted: false, fadeInSec: 0, fadeOutSec: 0, gainOffsetDb: 0, detached: false },
});

describe("timeline clip names", () => {
  it("names a generated clip from its generator and a file by its stem", () => {
    const text: MediaRef = {
      id: "t", path: "Text — www.site.com", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false,
      generator: { type: "text", text: "Hello", fontFamily: "Arial", sizePx: 40, color: "#ffffff", bold: false, italic: false },
    };
    const solid: MediaRef = {
      id: "s", path: "Solid #112233", size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false,
      generator: { type: "solid", color: "#445566" },
    };
    const file: MediaRef = {
      id: "f", path: "C:/media/beach.day.mp4", size: 1, mtimeMs: 1, kind: "video", duration: 10, hasAudio: false,
    };
    const { ctx, texts } = recordingContext();
    draw(ctx, input([text, solid, file], [clip("a", "t", 0), clip("b", "s", 5), clip("c", "f", 10)]));
    expect(texts).toContain("Text — Hello");
    expect(texts).toContain("Solid #445566");
    expect(texts).toContain("beach.day");
    expect(texts).not.toContain("Text — www.site");
  });
});
