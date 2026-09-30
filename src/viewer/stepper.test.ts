import { describe, expect, it } from "vitest";
import type { SiblingWindow } from "../core/ipc";
import {
  DWELL_MS,
  WINDOW_RADIUS,
  canStep,
  counterText,
  elementFor,
  fromWindow,
  nearEdge,
  step,
} from "./stepper";
import type { StepState } from "./stepper";

/** A stand-in for list_siblings: the files are already in stepping order, and
 *  the window is at most `radius` on each side of `path` (nearest LAST before,
 *  nearest FIRST after), exactly as the backend contract states. */
function fakeWindow(files: string[], path: string, radius: number): SiblingWindow {
  const i = files.indexOf(path);
  if (i < 0) throw new Error(`fixture: ${path} not listed`);
  return {
    before: files.slice(Math.max(0, i - radius), i),
    after: files.slice(i + 1, i + 1 + radius),
    index: i + 1,
    total: files.length,
    family: "visual",
  };
}

const TEN = Array.from({ length: 10 }, (_, k) => `C:\\p\\f${k + 1}.jpg`);
const cur = (s: StepState): string => s.list[s.pos]!;
/** Absolute 1-based index of the shown file (the counter's number). */
const abs = (s: StepState): number | null => (s.firstIndex === null ? null : s.firstIndex + s.pos);

describe("fromWindow", () => {
  it("lays the window out around the current file with its absolute offset", () => {
    // index 5 with 2 before: firstIndex must be 3 — neither the index itself
    // nor the list position, which are the two values a slip would return.
    const s = fromWindow("C:\\p\\f5.jpg", fakeWindow(TEN, "C:\\p\\f5.jpg", 2));
    expect(s.list).toEqual(["C:\\p\\f3.jpg", "C:\\p\\f4.jpg", "C:\\p\\f5.jpg", "C:\\p\\f6.jpg", "C:\\p\\f7.jpg"]);
    expect(s.pos).toBe(2);
    expect(s.firstIndex).toBe(3);
    expect(s.total).toBe(10);
    expect(s.family).toBe("visual");
  });

  it("keeps the caller's own spelling of the current file", () => {
    const w = fakeWindow(TEN, "C:\\p\\f2.jpg", 3);
    const s = fromWindow("c:/P/F2.JPG", w);
    expect(cur(s)).toBe("c:/P/F2.JPG");
  });
});

describe("step across a window refill", () => {
  it("radius 3, 10 files: six steps from index 2 need exactly one refill and land on 8", () => {
    let s = fromWindow(TEN[1]!, fakeWindow(TEN, TEN[1]!, 3));
    expect(abs(s)).toBe(2);
    let refills = 0;
    for (let k = 0; k < 6; k++) {
      expect(canStep(s, 1)).toBe(true);
      let next = step(s, 1);
      if (next === null) {
        // The window's edge, not the folder's: refill around the shown file.
        refills++;
        s = fromWindow(cur(s), fakeWindow(TEN, cur(s), 3));
        next = step(s, 1);
      }
      expect(next).not.toBeNull();
      s = next!;
    }
    expect(refills).toBe(1);
    expect(abs(s)).toBe(8);
    expect(cur(s)).toBe(TEN[7]);
    expect(counterText(s)).toBe("8 / 10");
  });

  it("step returns null only past the list, and never mutates its input", () => {
    const s = fromWindow(TEN[4]!, fakeWindow(TEN, TEN[4]!, 1));
    expect(s.list.length).toBe(3);
    const back = step(s, -1)!;
    expect(cur(back)).toBe(TEN[3]);
    expect(s.pos).toBe(1);
    expect(step(back, -1)).toBeNull();
    expect(step(step(s, 1)!, 1)).toBeNull();
  });
});

describe("canStep", () => {
  it("is false at index 1 and at total, even though both sit on a window edge", () => {
    // The shown file is list[0] / list[last] in both cases, so the in-list
    // check alone says "no" for a WINDOW edge too — the absolute answer must
    // come from firstIndex/total, which the next test proves is consulted.
    const first = fromWindow(TEN[0]!, fakeWindow(TEN, TEN[0]!, 3));
    expect(first.pos).toBe(0);
    expect(canStep(first, -1)).toBe(false);
    expect(canStep(first, 1)).toBe(true);

    const last = fromWindow(TEN[9]!, fakeWindow(TEN, TEN[9]!, 3));
    expect(last.pos).toBe(last.list.length - 1);
    expect(canStep(last, 1)).toBe(false);
    expect(canStep(last, -1)).toBe(true);
  });

  it("is true at a window edge that is not the folder's end", () => {
    // Stepped to the last listed neighbour of a radius-2 window around 5:
    // nothing more in the list, but 8 of 10 is not the end.
    let s = fromWindow(TEN[4]!, fakeWindow(TEN, TEN[4]!, 2));
    s = step(step(s, 1)!, 1)!;
    expect(abs(s)).toBe(7);
    expect(step(s, 1)).toBeNull();
    expect(canStep(s, 1)).toBe(true);
    s = step(step(step(step(s, -1)!, -1)!, -1)!, -1)!;
    expect(abs(s)).toBe(3);
    expect(step(s, -1)).toBeNull();
    expect(canStep(s, -1)).toBe(true);
  });
});

describe("a vanished current file", () => {
  // The shown file was deleted: the backend lists its neighbours around the
  // insertion point, cannot give it an index, and does not count it.
  const seven = ["C:\\v\\a.png", "C:\\v\\b.png", "C:\\v\\c.png", "C:\\v\\e.png", "C:\\v\\f.png", "C:\\v\\g.png", "C:\\v\\h.png"];
  const gone: SiblingWindow = {
    before: seven.slice(0, 3),
    after: seven.slice(3),
    index: null,
    total: 7,
    family: "visual",
  };

  it("counts as unknown", () => {
    const s = fromWindow("C:\\v\\d.png", gone);
    expect(s.firstIndex).toBeNull();
    expect(cur(s)).toBe("C:\\v\\d.png");
    expect(counterText(s)).toBe("– / 7");
  });

  it("still steps from the insertion point in both directions", () => {
    const s = fromWindow("C:\\v\\d.png", gone);
    expect(canStep(s, 1)).toBe(true);
    expect(cur(step(s, 1)!)).toBe("C:\\v\\e.png");
    expect(canStep(s, -1)).toBe(true);
    expect(cur(step(s, -1)!)).toBe("C:\\v\\c.png");
  });

  it("treats the window's edges as the folder's when it lists every file", () => {
    // 7 real files + the vanished slot = the whole folder: no refill to ask for.
    let s = fromWindow("C:\\v\\d.png", gone);
    for (let k = 0; k < 4; k++) s = step(s, 1)!;
    expect(cur(s)).toBe("C:\\v\\h.png");
    expect(canStep(s, 1)).toBe(false);
    expect(nearEdge(s, 1, 3)).toBe(false);
  });

  it("assumes more beyond a partial window (a refill decides)", () => {
    const partial: SiblingWindow = { ...gone, before: seven.slice(1, 3), after: seven.slice(3, 5), total: 7 };
    const s = fromWindow("C:\\v\\d.png", partial);
    const edge = step(step(s, 1)!, 1)!;
    expect(step(edge, 1)).toBeNull();
    expect(canStep(edge, 1)).toBe(true);
  });
});

describe("nearEdge", () => {
  it("fires within the margin only while more folder lies beyond", () => {
    const s = fromWindow(TEN[4]!, fakeWindow(TEN, TEN[4]!, 4)); // list f1..f9, shown f5
    expect(s.list.length).toBe(9);
    expect(nearEdge(s, 1, 3)).toBe(false); // 4 left before the edge
    const s6 = step(s, 1)!;
    expect(nearEdge(s6, 1, 3)).toBe(true); // 3 left, f10 beyond
    // Toward the start the window already reaches file 1: the edge IS the end.
    expect(nearEdge(step(step(s, -1)!, -1)!, -1, 3)).toBe(false);
  });
});

describe("counterText", () => {
  it("is empty for a folder of one", () => {
    expect(counterText(fromWindow("C:\\one.mp4", { before: [], after: [], index: 1, total: 1, family: "visual" }))).toBe("");
  });

  it("reads firstIndex + pos over total", () => {
    const s = step(fromWindow(TEN[5]!, fakeWindow(TEN, TEN[5]!, 2)), -1)!;
    expect(counterText(s)).toBe("5 / 10");
  });
});

describe("elementFor", () => {
  it.each([
    ["jpg", "img"],
    ["gif", "img"],
    ["webp", "img"],
    ["mp4", "video"],
    ["mts", "video"],
    ["mp3", "video"],
    ["txt", null],
    ["trt", null],
    ["", null],
  ] as const)("%s → %s", (ext, want) => {
    expect(elementFor(ext)).toBe(want);
  });
});

describe("constants", () => {
  it("pins the window radius and the dwell times", () => {
    expect(WINDOW_RADIUS).toBe(16);
    expect(DWELL_MS).toEqual({ image: 0, media: 250, repeat: 150 });
  });
});
