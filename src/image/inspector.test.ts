import { describe, expect, it, vi } from "vitest";
import type { ClipTransform, ProjectFile } from "../core/types";
import { createBlankImageProject } from "../core/image-project";
import { layerToCanvas } from "./geom";
import { setBackground } from "./layers";

// The panel's UI neighbours are other modules' business; only the pure rules
// are under test here, so nothing they own can decide a result.
vi.mock("./canvas-size-dialog", () => ({ openCanvasSizeDialog: () => {} }));
vi.mock("../editor/inspector/generated", () => ({ buildGeneratedSection: () => null }));
vi.mock("./icons", () => ({ imgIcon: () => "" }));

const {
  BACKGROUND_CHOICES,
  backgroundChoiceOf,
  createGestures,
  fitScale,
  parseCrop,
  pickerCloseTarget,
  pinnedCrop,
  scaleFromPercent,
} = await import("./inspector");

const tf = (patch: Partial<ClipTransform>): ClipTransform => ({
  rotate: 0,
  flipH: false,
  flipV: false,
  scale: 1,
  x: 0,
  y: 0,
  opacity: 1,
  ...patch,
});

describe("scaleFromPercent", () => {
  it("reads 100 as actual pixels and has no 10-400 window", () => {
    expect(scaleFromPercent(250)).toBe(2.5);
    expect(scaleFromPercent(100)).toBe(1);
    expect(scaleFromPercent(3)).toBe(0.03); // below the video editor's 10 %
    expect(scaleFromPercent(1250)).toBe(12.5); // above its 400 %
  });

  it("refuses a size that is not one: 0, negative, not a number", () => {
    for (const v of [0, -0, -50, -0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(scaleFromPercent(v), String(v)).toBeNull();
    }
  });

  it("keeps a positive but absurd entry inside the crafted-file guard", () => {
    expect(scaleFromPercent(1e9)).toBe(1e4);
    expect(scaleFromPercent(1e-9)).toBe(1e-4);
  });
});

describe("the background buttons", () => {
  it("hand setBackground exactly the value each one names", () => {
    const base = createBlankImageProject("bg", 64, 48, "#3a7bd5");
    const got: Record<string, string | undefined> = {};
    for (const c of BACKGROUND_CHOICES) {
      if (c.value === null) continue; // "Color" opens the picker instead
      got[c.id] = setBackground(base, c.value).image?.background;
    }
    expect(got).toEqual({ transparent: "transparent", white: "#ffffff", black: "#000000" });
    expect(BACKGROUND_CHOICES.map((c) => c.id)).toEqual(["transparent", "white", "black", "color"]);
    expect(BACKGROUND_CHOICES.find((c) => c.id === "color")?.value).toBeNull();
  });

  it("light the button that matches what is stored, however it is spelled", () => {
    expect(backgroundChoiceOf(undefined)).toBe("transparent");
    expect(backgroundChoiceOf("transparent")).toBe("transparent");
    expect(backgroundChoiceOf("#FFF")).toBe("white");
    expect(backgroundChoiceOf("#FfFfFf")).toBe("white");
    expect(backgroundChoiceOf("#000")).toBe("black");
    expect(backgroundChoiceOf("#3a7bd5")).toBe("color");
    expect(backgroundChoiceOf("#fffffe")).toBe("color"); // one step off white is a colour
    // Unreadable is what the renderer draws for it: nothing.
    expect(backgroundChoiceOf("red; background: url(x)")).toBe("transparent");
    // Every button's own value lights that button.
    for (const c of BACKGROUND_CHOICES) {
      if (c.value !== null) expect(backgroundChoiceOf(c.value), c.id).toBe(c.id);
    }
  });
});

describe("fitScale", () => {
  it("fits the visible box inside the canvas, turned boxes swapped", () => {
    // 4000 × 3000 on 1920 × 1080: min(0.48, 0.36) = 0.36.
    expect(fitScale(tf({}), 4000, 3000, 1920, 1080)).toBeCloseTo(0.36, 12);
    // Turned a quarter it is 3000 wide by 4000 tall: min(0.64, 0.27) = 0.27.
    expect(fitScale(tf({ rotate: 90 }), 4000, 3000, 1920, 1080)).toBeCloseTo(0.27, 12);
    expect(fitScale(tf({ rotate: 270 }), 4000, 3000, 1920, 1080)).toBeCloseTo(0.27, 12);
    expect(fitScale(tf({ rotate: 180 }), 4000, 3000, 1920, 1080)).toBeCloseTo(0.36, 12);
  });

  it("uses the CROPPED box and enlarges a small one", () => {
    const crop = { x: 700, y: 900, w: 1000, h: 500 };
    // min(1920/1000, 1080/500) = min(1.92, 2.16)
    expect(fitScale(tf({ crop }), 4000, 3000, 1920, 1080)).toBeCloseTo(1.92, 12);
    // turned: 500 wide, 1000 tall → min(3.84, 1.08)
    expect(fitScale(tf({ crop, rotate: 90 }), 4000, 3000, 1920, 1080)).toBeCloseTo(1.08, 12);
  });
});

describe("parseCrop", () => {
  it("takes whole source px inside the source", () => {
    expect(parseCrop(10.4, 20.6, 300.2, 150, 640, 480)).toEqual({ x: 10, y: 21, w: 300, h: 150 });
    // one pixel is a legal crop on an image layer (the canvas allows it too)
    expect(parseCrop(639, 479, 1, 1, 640, 480)).toEqual({ x: 639, y: 479, w: 1, h: 1 });
  });

  it("stores the whole source as no crop", () => {
    expect(parseCrop(0, 0, 640, 480, 640, 480)).toBeUndefined();
  });

  it("refuses what does not fit, rather than moving it", () => {
    expect(parseCrop(600, 0, 41, 480, 640, 480)).toBeNull(); // x + w > W
    expect(parseCrop(0, 400, 640, 81, 640, 480)).toBeNull(); // y + h > H
    expect(parseCrop(-1, 0, 100, 100, 640, 480)).toBeNull();
    expect(parseCrop(0, 0, 0, 100, 640, 480)).toBeNull();
    expect(parseCrop(0, 0, 100, Number.NaN, 640, 480)).toBeNull();
  });
});

describe("pinnedCrop", () => {
  // Every axis differs: a non-square source, a canvas of another aspect, a
  // non-unit scale, an off-centre offset, and each turn and flip.
  const SRC_W = 900;
  const SRC_H = 500;
  const W = 1280;
  const H = 1024;
  const at = (t: ClipTransform, x: number, y: number): [number, number] => {
    const [a, b, c, d, e, f] = layerToCanvas(t, SRC_W, SRC_H, W, H);
    return [a * x + c * y + e, b * x + d * y + f];
  };

  const poses: ClipTransform[] = [];
  for (const rotate of [0, 90, 180, 270] as const) {
    for (const [flipH, flipV] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      poses.push(tf({ rotate, flipH, flipV, scale: 0.37, x: 41.5, y: -17, crop: { x: 30, y: 60, w: 400, h: 300 } }));
    }
  }

  it("keeps the pixels that stay visible exactly where they were", () => {
    const next = { x: 120, y: 90, w: 210, h: 170 };
    for (const t of poses) {
      const p = pinnedCrop(t, SRC_W, SRC_H, W, H, next);
      const after = { ...t, ...p };
      expect(after.crop).toEqual(next);
      // A source point inside the new window lands on the same canvas point.
      for (const [sx, sy] of [
        [150, 100],
        [300, 250],
      ] as const) {
        const [bx, by] = at(t, sx, sy);
        const [ax, ay] = at(after, sx, sy);
        expect(ax, `r${t.rotate} h${t.flipH} v${t.flipV}`).toBeCloseTo(bx, 9);
        expect(ay, `r${t.rotate} h${t.flipH} v${t.flipV}`).toBeCloseTo(by, 9);
      }
      // ...which takes a real move of the offset (the window's centre moved).
      expect(Math.hypot(p.x - t.x, p.y - t.y)).toBeGreaterThan(1);
    }
  });

  it("clearing the crop pins the source too", () => {
    for (const t of poses) {
      const p = pinnedCrop(t, SRC_W, SRC_H, W, H, undefined);
      expect(p.crop).toBeUndefined();
      const after = { ...t, ...p };
      delete after.crop;
      const [bx, by] = at(t, 200, 150);
      const [ax, ay] = at(after, 200, 150);
      expect(ax).toBeCloseTo(bx, 9);
      expect(ay).toBeCloseTo(by, 9);
    }
  });
});

describe("gestures: live edit → one undo step", () => {
  // Distinct objects stand in for projects: the rules compare identity only.
  const proj = (name: string): ProjectFile => ({ name }) as unknown as ProjectFile;
  const P0 = proj("P0");
  const P1 = proj("P1");
  const P2 = proj("P2");
  const P3 = proj("P3");

  /** A session that records what commitFrom pushed, with ProjectSession's
   *  own no-op rule (nothing changed → no step). */
  function rig() {
    const s = {
      project: P0,
      pushed: [] as ProjectFile[],
      commitFrom(before: ProjectFile) {
        if (s.project !== before) s.pushed.push(before);
      },
    };
    const holds = { taken: 0, released: 0 };
    const set = createGestures(s, () => {
      holds.taken++;
      return () => holds.released++;
    });
    return { s, holds, set };
  }

  it("a write then a commit lands ONE step back to where it began", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => (s.project = P1));
    g.write(() => (s.project = P2));
    expect(set.pending).toBe(1);
    g.commit();
    expect(s.pushed).toEqual([P0]);
    expect(set.pending).toBe(0);
  });

  it("another writer in between: the late commit is dropped, never pushed over its step", () => {
    // The canvas-drag case: typed P1, the select tool replaced it with P2.
    // Pushing P0 now would make a second undo resurrect P1.
    const { s, holds, set } = rig();
    const g = set.gesture();
    g.hold();
    g.write(() => (s.project = P1));
    s.project = P2;
    g.commit();
    expect(s.pushed).toEqual([]);
    expect(set.pending).toBe(0);
    expect(holds.released).toBe(1); // the hold goes whether or not the step lands
  });

  it("a press that never wrote does not push when someone else wrote", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.hold();
    s.project = P2;
    g.commit();
    expect(s.pushed).toEqual([]);
  });

  it("a write after an interruption re-bases on the project as it is now", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => (s.project = P1));
    s.project = P2;
    g.write(() => (s.project = P3));
    g.commit();
    expect(s.pushed).toEqual([P2]); // not P0: that would undo past the other step
  });

  it("the autosave hold is the pointer-down path only, taken once", () => {
    const { s, holds, set } = rig();
    const typed = set.gesture();
    typed.write(() => (s.project = P1));
    typed.write(() => (s.project = P2));
    typed.commit();
    expect(holds).toEqual({ taken: 0, released: 0 });

    // Typed into the twin, then grabbed the range: the grab still holds, once.
    const both = set.gesture();
    both.write(() => (s.project = P3));
    both.hold();
    both.hold();
    expect(holds.taken).toBe(1);
    both.commit();
    expect(holds).toEqual({ taken: 1, released: 1 });
  });

  // A save puts `{...p, modifiedAt}` in the store: new object, same edit.
  // Typed edits take no autosave hold, so one lands mid-typing.
  const restamp = (p: ProjectFile): ProjectFile => ({ ...p, modifiedAt: "2026-09-29T12:00:00.000Z" }) as ProjectFile;

  it("a save's restamp between the write and the commit still lands the step", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => (s.project = P1));
    s.project = restamp(P1);
    g.commit();
    expect(s.pushed).toEqual([P0]);
  });

  it("a restamp between two writes does not re-base onto the half-typed value", () => {
    // Typed "1", the save landed, typed "5": undo must reach P0, not "1".
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => (s.project = P1));
    s.project = restamp(P1);
    g.write(() => (s.project = P2));
    g.commit();
    expect(s.pushed).toEqual([P0]);
  });

  it("a write that changed nothing, then a restamp, lands no empty step", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => {});
    s.project = restamp(P0);
    g.commit();
    expect(s.pushed).toEqual([]);
  });

  it("a rename in between is still someone else's edit", () => {
    const { s, set } = rig();
    const g = set.gesture();
    g.write(() => (s.project = P1));
    s.project = { ...P1, name: "Renamed" } as ProjectFile;
    g.commit();
    expect(s.pushed).toEqual([]);
  });

  it("flush commits every pending gesture", () => {
    const { s, set } = rig();
    const a = set.gesture();
    const b = set.gesture();
    a.write(() => (s.project = P1));
    b.begin();
    set.flush();
    expect(set.pending).toBe(0);
    expect(s.pushed).toEqual([P0]); // b wrote nothing, so it adds no step
  });
});

describe("pickerCloseTarget", () => {
  // Three different colours, so each answer can only come from one input.
  const base = setBackground(createBlankImageProject("t", 64, 64, "#ffffff"), "#112233");
  const preview = "#abcdef";
  const openBg = "#445566";

  it("a pick lands on what the picker reports, Escape on what it opened on", () => {
    expect(pickerCloseTarget("pick", preview, openBg, base)).toBe(preview);
    expect(pickerCloseTarget("cancel", preview, openBg, base)).toBe(openBg);
  });

  it("closing the window drops only the preview in flight, back to the project before it", () => {
    expect(pickerCloseTarget("drop-preview", preview, openBg, base)).toBe("#112233");
    const clear = setBackground(base, "transparent");
    expect(pickerCloseTarget("drop-preview", preview, openBg, clear)).toBe("transparent");
  });
});
