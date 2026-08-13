import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../core/ipc";
import {
  addMedia,
  createProject,
  defaultTransform,
  findClip,
  insertClip,
  makeClip,
} from "../../core/project";
import { ProjectSession, settingsStore } from "../../core/session";
import { Store } from "../../core/store";
import { DEFAULT_SETTINGS } from "../../core/types";
import type { MediaRef, ProjectFile } from "../../core/types";
import type { PlaybackEngine } from "../playback/engine";
import type { Scheduler } from "../playback/scheduler";
import { mountCanvasOverlay } from "./overlay";
import type { Stage } from "./preview";

/*
 * The overlay's gesture state machine, exercised head-on: what a cancel does to
 * the project, to history, and to the pointer it captured.
 *
 * Both gesture kinds edit the project through `session.replace()` — history-free
 * — and only push an undo entry on pointerup. Every way OUT of a gesture that is
 * not a pointerup therefore has to put the project back itself, or the edit is
 * stranded: present in the project and in the next autosave, unreachable by
 * Ctrl+Z. That is the invariant the whole file below is about.
 *
 * The suite runs in the "node" environment, so the DOM is stubbed rather than
 * emulated (same approach as transforms.test.ts, one storey up: whole elements
 * instead of a bare `{ style }`). Two things are deliberately REAL:
 *
 *   - `ProjectSession`, so `replace` / `commitFrom` / `history.canUndo` mean
 *     what they mean in the app rather than what a hand-written double says.
 *   - element geometry: getBoundingClientRect is derived from the very `style`
 *     the overlay's own `place()` wrote, so the crop hit-test reads back real
 *     numbers instead of ones a fixture chose.
 */

/* ------------------------------------------------------------------ */
/* Fixture geometry — every axis a different number                     */
/* ------------------------------------------------------------------ */

/* No two of these may coincide. A canvas that matched the media size, an origin
 * at 0,0 or a stage scale of 1 would each let a dropped conversion still produce
 * the expected answer — the coinciding-values trap that has hidden real bugs in
 * this project before. With these, client px, project px and source px are three
 * distinct spaces and a mix-up cannot survive. */
const PROJ_W = 1280;
const PROJ_H = 720;
const MEDIA_W = 800;
const MEDIA_H = 500;
const STAGE_SCALE = 0.5;
const CANVAS_LEFT = 37;
const CANVAS_TOP = 19;

/** Start pose of the clip under test: non-zero, unequal, opposite signs. */
const START_X = 12;
const START_Y = -7;
const START_SCALE = 0.75;

const CLIP_START = 3;
const PLAYHEAD = 4.25;
/** Distinct from 0 and 1, so releasing "some" pointer cannot pass for releasing
 *  the one the gesture actually captured. */
const POINTER_ID = 7;

/** client px → project px, the conversion the overlay does through the canvas
 *  rect. Written out here so the test states its own expectations rather than
 *  borrowing the implementation's. */
const toClientX = (projX: number): number => projX * STAGE_SCALE + CANVAS_LEFT;
const toClientY = (projY: number): number => projY * STAGE_SCALE + CANVAS_TOP;

/* The clip's display rect, by hand: fit(800,500 → 1280,720) = 1.44, times the
 * 0.75 user scale = 1.08; so 864x540 centred at (640+12, 360-7). A point at its
 * centre is what every gesture below starts from. */
const CENTER_PROJ_X = PROJ_W / 2 + START_X;
const CENTER_PROJ_Y = PROJ_H / 2 + START_Y;

/* ------------------------------------------------------------------ */
/* Minimal DOM                                                          */
/* ------------------------------------------------------------------ */

interface FakeEl {
  tagName: string;
  className: string;
  tabIndex: number;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  parent: FakeEl | null;
  /** pointers this element currently holds capture for */
  captured: Set<number>;
  focusCount: number;
  listeners: Map<string, ((e: unknown) => void)[]>;
  appendChild(c: FakeEl): FakeEl;
  append(...cs: FakeEl[]): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  remove(): void;
  focus(): void;
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  getBoundingClientRect(): DOMRect;
  /** deliver an event to every listener registered for `type`, in order */
  fire(type: string, e: unknown): void;
}

const pxOf = (v: string | undefined): number => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

function makeEl(tagName: string): FakeEl {
  const el: FakeEl = {
    tagName,
    className: "",
    tabIndex: 0,
    dataset: {},
    style: {},
    textContent: "",
    children: [],
    parent: null,
    captured: new Set<number>(),
    focusCount: 0,
    listeners: new Map(),
    appendChild(c: FakeEl): FakeEl {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    append(...cs: FakeEl[]): void {
      for (const c of cs) el.appendChild(c);
    },
    addEventListener(type: string, fn: (e: unknown) => void): void {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (e: unknown) => void): void {
      const list = el.listeners.get(type);
      if (list) el.listeners.set(type, list.filter((f) => f !== fn));
    },
    remove(): void {
      const p = el.parent;
      if (!p) return;
      p.children = p.children.filter((c) => c !== el);
      el.parent = null;
    },
    focus(): void {
      el.focusCount++;
    },
    setPointerCapture(id: number): void {
      el.captured.add(id);
    },
    // Throws for a pointer it does not hold, exactly as the real one does for an
    // InvalidPointerId. The overlay wraps every release in try/catch; if it ever
    // stopped, a double-release would surface here instead of passing silently.
    releasePointerCapture(id: number): void {
      if (!el.captured.has(id)) throw new Error(`no capture for pointer ${id}`);
      el.captured.delete(id);
    },
    // Derived from the element's OWN style box, offset by the canvas origin —
    // the overlay's children are absolutely positioned inside the canvas, and
    // `place()` writes exactly these four properties.
    getBoundingClientRect(): DOMRect {
      const left = CANVAS_LEFT + pxOf(el.style.left);
      const top = CANVAS_TOP + pxOf(el.style.top);
      const width = pxOf(el.style.width);
      const height = pxOf(el.style.height);
      return {
        left, top, width, height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
    fire(type: string, e: unknown): void {
      for (const fn of [...(el.listeners.get(type) ?? [])]) fn(e);
    },
  };
  return el;
}

/** Depth-first search for the first descendant carrying `dataset[key] === value`. */
function findByData(root: FakeEl, key: string, value: string): FakeEl {
  const stack = [...root.children];
  while (stack.length) {
    const el = stack.shift()!;
    if (el.dataset[key] === value) return el;
    stack.push(...el.children);
  }
  throw new Error(`no element with data-${key}="${value}"`);
}

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

interface Harness {
  session: ProjectSession;
  selection: Store<string | null>;
  overlay: FakeEl;
  clipId: string;
  media: MediaRef;
  engineTime: { value: number };
  paused: () => number;
  refreshes: () => number;
  dispose(): void;
  /** the clip as it stands in the project right now */
  clip(): { transform: NonNullable<ReturnType<typeof clipTransform>> };
}

function clipTransform(p: ProjectFile, clipId: string) {
  return findClip(p, clipId)!.clip.transform!;
}

/** A text generator, on purpose: it is the one media kind whose crop ghost is
 *  built without `mediaUrl()`, so crop mode can be exercised without dragging
 *  the Tauri asset protocol into a node test. Its 800x500 "measured text box"
 *  differs from the 1280x720 canvas, which is the shape issue #1 lived in. */
function buildFixture(): { project: ProjectFile; clipId: string; media: MediaRef } {
  let p = createProject("canvas gestures");
  p = { ...p, timeline: { ...p.timeline, width: PROJ_W, height: PROJ_H } };
  const added = addMedia(p, {
    path: "text: cancel me",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 6,
    hasAudio: false,
    width: MEDIA_W,
    height: MEDIA_H,
    generator: {
      type: "text",
      text: "cancel me",
      fontFamily: "Segoe UI",
      sizePx: 64,
      color: "#ffffff",
      bold: false,
      italic: false,
    },
  });
  p = added.project;
  const clip = makeClip(added.media, CLIP_START);
  clip.transform = { ...defaultTransform(), x: START_X, y: START_Y, scale: START_SCALE };
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  return { project: p, clipId: clip.id, media: added.media };
}

function mount(): Harness {
  const { project, clipId, media } = buildFixture();
  const session = new ProjectSession("C:\\Users\\adirh\\Videos\\Taroting\\cut.trt", project);
  const selection = new Store<string | null>(null);
  const engineTime = { value: PLAYHEAD };
  let pauses = 0;
  let refreshes = 0;

  const canvas = makeEl("div");
  canvas.style.width = `${PROJ_W * STAGE_SCALE}px`;
  canvas.style.height = `${PROJ_H * STAGE_SCALE}px`;

  const stage = { canvas, scale: STAGE_SCALE } as unknown as Stage;

  // Reads the clip back out of the LIVE project every call, the way the real
  // scheduler does. A captured snapshot would freeze the pose at mount and hide
  // every mid-gesture write from the overlay's own re-reads.
  const scheduler = {
    visibleClipsAt: () => {
      const found = findClip(session.project, clipId);
      if (!found) return [];
      return [{ clip: found.clip, track: found.track, media }];
    },
  } as unknown as Scheduler;

  const engine = {
    get time(): number {
      return engineTime.value;
    },
    pause: () => {
      pauses++;
    },
    onTick: () => () => {},
  } as unknown as PlaybackEngine;

  const handle = mountCanvasOverlay({
    stage,
    scheduler,
    engine,
    session,
    selection,
    refresh: () => {
      refreshes++;
    },
  });

  const overlay = canvas.children[0]!;
  return {
    session,
    selection,
    overlay,
    clipId,
    media,
    engineTime,
    paused: () => pauses,
    refreshes: () => refreshes,
    dispose: () => handle.dispose(),
    clip: () => ({ transform: clipTransform(session.project, clipId) }),
  };
}

/* ------------------------------------------------------------------ */
/* Event helpers                                                        */
/* ------------------------------------------------------------------ */

interface KeyResult {
  prevented: boolean;
  stopped: boolean;
}

function pointer(h: Harness, type: string, clientX: number, clientY: number, target?: FakeEl): void {
  h.overlay.fire(type, {
    button: 0,
    pointerId: POINTER_ID,
    clientX,
    clientY,
    target: target ?? h.overlay,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

function key(h: Harness, k: string): KeyResult {
  const out: KeyResult = { prevented: false, stopped: false };
  h.overlay.fire("keydown", {
    key: k,
    preventDefault: () => {
      out.prevented = true;
    },
    stopPropagation: () => {
      out.stopped = true;
    },
  });
  return out;
}

/** Press at the clip's centre and drag to the given PROJECT point, arming the
 *  gesture (the travel is far past the 4px client dead-zone). */
function dragTo(h: Harness, projX: number, projY: number): void {
  pointer(h, "pointerdown", toClientX(CENTER_PROJ_X), toClientY(CENTER_PROJ_Y));
  pointer(h, "pointermove", toClientX(projX), toClientY(projY));
}

/* ------------------------------------------------------------------ */

function installGlobalStubs(): void {
  vi.stubGlobal("document", { createElement: (tag: string) => makeEl(tag) });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  });
  // destroyGhostMedia narrows with `instanceof HTMLVideoElement`; without the
  // global that is a ReferenceError, not a false.
  vi.stubGlobal("HTMLVideoElement", class {});
}

beforeEach(() => {
  installGlobalStubs();
  settingsStore.set(DEFAULT_SETTINGS);
  // Only the timers: Store's notifications ride the microtask queue and must
  // keep running (same reasoning as session.test.ts).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(ipc, "saveProject").mockResolvedValue({ modifiedAt: new Date().toISOString() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Escape mid-gesture                                                   */
/* ------------------------------------------------------------------ */

describe("Escape during a canvas drag or scale", () => {
  it("puts the project back exactly as it was and invents no history entry", () => {
    const h = mount();
    const before = h.session.project;

    // 60 project px right, 36 down — well clear of the 16px centre-snap zone at
    // this stage scale, so the landing position is the drag's own arithmetic.
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);

    // The drag REALLY edited: without this the revert below could pass on a
    // gesture that never wrote anything.
    expect(h.clip().transform.x).toBe(START_X + 60);
    expect(h.clip().transform.y).toBe(START_Y + 36);
    expect(h.session.project).not.toBe(before);
    expect(h.session.history.canUndo).toBe(false); // live edits are replace()d

    key(h, "Escape");

    // Reference identity: not "a project that looks the same", the same one.
    expect(h.session.project).toBe(before);
    expect(h.clip().transform.x).toBe(START_X);
    expect(h.clip().transform.y).toBe(START_Y);
    // The cancelled drag left nothing for Ctrl+Z to land on, and did not stash
    // an entry that would make the NEXT undo skip a step.
    expect(h.session.history.canUndo).toBe(false);
    expect(h.session.history.canRedo).toBe(false);
  });

  it("consumes the key and releases the pointer it captured", () => {
    const h = mount();
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    expect(h.overlay.captured.has(POINTER_ID)).toBe(true);

    const res = key(h, "Escape");

    expect(res.prevented).toBe(true);
    expect(res.stopped).toBe(true); // must not also reach the global shortcuts
    expect(h.overlay.captured.size).toBe(0);
  });

  it("keeps the clip selected, the way leaving crop mode does", () => {
    const h = mount();
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    expect(h.selection.get()).toBe(h.clipId);

    key(h, "Escape");

    // Deliberate, and matched to crop: exitCrop reverts the drag and never
    // touches selection.set. Cancelling an edit is not deselecting; the clip
    // stays live so the drag can simply be retried.
    expect(h.selection.get()).toBe(h.clipId);
  });

  it("leaves a dead gesture: a later move or release cannot resume or commit it", () => {
    const h = mount();
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    key(h, "Escape");
    const reverted = h.session.project;

    // The button is still down: the pointer keeps moving, then lifts.
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 300), toClientY(CENTER_PROJ_Y - 120));
    pointer(h, "pointerup", toClientX(CENTER_PROJ_X + 300), toClientY(CENTER_PROJ_Y - 120));

    expect(h.session.project).toBe(reverted);
    expect(h.clip().transform.x).toBe(START_X);
    expect(h.session.history.canUndo).toBe(false);
  });

  it("reverts a corner-handle scale the same way", () => {
    const h = mount();
    h.selection.set(h.clipId); // the scale branch needs an existing selection
    const before = h.session.project;
    const handle = findByData(h.overlay, "handle", "se");

    // Down on the SE handle, out along the diagonal: the drag distance from the
    // rect centre grows, so the scale grows with it.
    pointer(h, "pointerdown", toClientX(CENTER_PROJ_X + 432), toClientY(CENTER_PROJ_Y + 270), handle);
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 600), toClientY(CENTER_PROJ_Y + 375), handle);

    expect(h.clip().transform.scale).toBeGreaterThan(START_SCALE);

    key(h, "Escape");

    expect(h.session.project).toBe(before);
    expect(h.clip().transform.scale).toBe(START_SCALE);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.overlay.captured.size).toBe(0);
  });

  it("drops the centre-snap guides it lit on the way down", () => {
    const h = mount();
    const guideV = h.overlay.children.find((c) => c.className.includes("guide--v"))!;
    const guideH = h.overlay.children.find((c) => c.className.includes("guide--h"))!;

    // Land the clip on the canvas centre so BOTH guides light up — a drag that
    // never snapped would make the assertion below vacuous.
    dragTo(h, PROJ_W / 2, PROJ_H / 2);
    expect(guideV.style.display).toBe("block");
    expect(guideH.style.display).toBe("block");

    key(h, "Escape");

    expect(guideV.style.display).toBe("none");
    expect(guideH.style.display).toBe("none");
  });

  it("cancels a gesture still inside the dead-zone without touching anything", () => {
    const h = mount();
    const before = h.session.project;

    pointer(h, "pointerdown", toClientX(CENTER_PROJ_X), toClientY(CENTER_PROJ_Y));
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X) + 2, toClientY(CENTER_PROJ_Y) + 1);
    expect(h.session.project).toBe(before); // never armed, never wrote

    key(h, "Escape");

    expect(h.session.project).toBe(before);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.overlay.captured.size).toBe(0); // still a clean end
  });

  it("still clears the selection when no gesture is in flight", () => {
    const h = mount();
    h.selection.set(h.clipId);

    const res = key(h, "Escape");

    expect(h.selection.get()).toBeNull();
    expect(res.prevented).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* pointercancel mid-gesture                                            */
/* ------------------------------------------------------------------ */

describe("a cancelled pointer during a gesture", () => {
  // The OS withdrawing the pointer (alt-tab, a system gesture, the pen leaving
  // range) is not the user finishing the drag. It used to be wired straight to
  // onPointerUp, which committed the half-drag wherever the interruption left
  // it — the same bug the timeline's cancelGesture already fixed.
  it("cancels a move drag: reverts, commits nothing, releases the capture", () => {
    const h = mount();
    const before = h.session.project;
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    expect(h.clip().transform.x).toBe(START_X + 60); // the drag really edited
    expect(h.overlay.captured.has(POINTER_ID)).toBe(true);

    pointer(h, "pointercancel", toClientX(CENTER_PROJ_X + 60), toClientY(CENTER_PROJ_Y + 36));

    expect(h.session.project).toBe(before);
    expect(h.clip().transform.x).toBe(START_X);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.session.history.canRedo).toBe(false);
    expect(h.overlay.captured.size).toBe(0);
  });

  it("cancels a crop drag the same way", () => {
    const h = mount();
    const before = h.session.project;
    startCropDrag(h);
    expect(h.clip().transform.crop!.w).toBeLessThan(MEDIA_W); // really re-cropped

    pointer(h, "pointercancel", toClientX(CENTER_PROJ_X + 432 - 24), toClientY(CENTER_PROJ_Y));

    expect(h.session.project).toBe(before);
    expect(h.clip().transform.crop).toBeUndefined();
    expect(h.session.history.canUndo).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* dispose() mid-gesture                                                */
/* ------------------------------------------------------------------ */

/** Enter crop mode and start dragging the east window handle INWARD, which
 *  narrows the crop. Outward would run straight into the clamp at the source
 *  width and write nothing — a gesture that changes nothing cannot show whether
 *  a revert happened. */
function startCropDrag(h: Harness): void {
  h.overlay.fire("dblclick", {
    clientX: toClientX(CENTER_PROJ_X),
    clientY: toClientY(CENTER_PROJ_Y),
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  const handle = findByData(h.overlay, "crophandle", "e");
  const startX = toClientX(CENTER_PROJ_X + 432);
  const startY = toClientY(CENTER_PROJ_Y);
  pointer(h, "pointerdown", startX, startY, handle);
  pointer(h, "pointermove", startX - 24, startY, handle);
}

describe("disposing the overlay mid-gesture", () => {
  it("reverts a live crop drag instead of stranding it in the project", () => {
    const h = mount();
    const before = h.session.project;
    startCropDrag(h);

    expect(h.paused()).toBe(1); // crop mode really opened
    const dragged = h.clip().transform.crop!;
    expect(dragged.w).toBeLessThan(MEDIA_W); // the drag really re-cropped
    expect(h.session.history.canUndo).toBe(false); // …through replace(), as designed

    h.dispose();

    // Without the revert this is where the half-finished crop would sit: in the
    // project, in the save editor.ts is about to await, and out of Ctrl+Z's reach.
    expect(h.session.project).toBe(before);
    expect(h.clip().transform.crop).toBeUndefined();
    expect(h.session.history.canUndo).toBe(false);
  });

  it("reverts a live move drag too", () => {
    const h = mount();
    const before = h.session.project;
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    expect(h.clip().transform.x).toBe(START_X + 60);

    h.dispose();

    expect(h.session.project).toBe(before);
    expect(h.clip().transform.x).toBe(START_X);
    expect(h.session.history.canUndo).toBe(false);
  });

  it("does not revert a second time when Escape already cancelled the crop drag", () => {
    const h = mount();
    startCropDrag(h);
    key(h, "Escape"); // exits crop AND reverts the drag

    // A committed edit AFTER the cancel. If dispose re-ran the stale revert it
    // would roll this away too — silently, and with its undo entry still on the
    // stack pointing at a state the project no longer holds.
    //
    // The crop cancel is protected TWICE over, which is worth knowing before
    // trusting this block: dropping `cropGesture = null` alone does not move it,
    // because exitCrop has by then also cleared `cropClipId` and the second
    // guard catches the re-entry. It goes red when BOTH are removed (verified).
    // The move-drag twin below has only the one guard and fails on it alone.
    h.session.commit((p) => ({ ...p, name: "renamed after the cancel" }));
    const committed = h.session.project;

    h.dispose();

    expect(h.session.project).toBe(committed);
    expect(h.session.project.name).toBe("renamed after the cancel");
    expect(h.session.history.canUndo).toBe(true);
  });

  it("does not revert a second time when Escape already cancelled the move drag", () => {
    const h = mount();
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    key(h, "Escape");

    h.session.commit((p) => ({ ...p, name: "renamed after the cancel" }));
    const committed = h.session.project;

    h.dispose();

    expect(h.session.project).toBe(committed);
    expect(h.session.history.canUndo).toBe(true);
  });

  it("does not revert a drag the pointer already committed", () => {
    const h = mount();
    dragTo(h, CENTER_PROJ_X + 60, CENTER_PROJ_Y + 36);
    pointer(h, "pointerup", toClientX(CENTER_PROJ_X + 60), toClientY(CENTER_PROJ_Y + 36));
    const committed = h.session.project;
    expect(h.session.history.canUndo).toBe(true); // pointerup pushed the entry

    h.dispose();

    // A finished drag is the user's edit, not a stranded one.
    expect(h.session.project).toBe(committed);
    expect(h.clip().transform.x).toBe(START_X + 60);
    expect(h.session.history.canUndo).toBe(true);
  });

  it("leaves an idle overlay's project entirely alone", () => {
    const h = mount();
    const before = h.session.project;

    h.dispose();

    expect(h.session.project).toBe(before);
    expect(h.session.history.canUndo).toBe(false);
  });
});
