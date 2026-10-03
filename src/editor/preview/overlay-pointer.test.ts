import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mediaUrl is the original-file URL. Stubbed to a recognisable prefix so the
// crop ghost's source says WHICH url it was built from, without the Tauri
// asset protocol a node test cannot reach.
vi.mock("../../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/ipc")>();
  return { ...real, mediaUrl: (path: string) => `original:${path}` };
});

import { ipc } from "../../core/ipc";
import { addMedia, createProject, defaultTransform, findClip, insertClip, makeClip } from "../../core/project";
import { ProjectSession, settingsStore } from "../../core/session";
import { Store } from "../../core/store";
import { DEFAULT_SETTINGS } from "../../core/types";
import type { MediaRef, ProjectFile } from "../../core/types";
import type { PlaybackEngine } from "../playback/engine";
import type { Scheduler } from "../playback/scheduler";
import { mountCanvasOverlay, type CanvasOverlay, type OverlayCtx } from "./overlay";
import type { Stage } from "./preview";

/*
 * How a canvas drag ends when its pointerup never arrives — the button came up
 * over a surface that took the canvas away (theater), or the overlay lost the
 * pointer's capture — and which file the crop ghost decodes.
 *
 * overlay.test.ts owns the gesture state machine's other exits (Escape,
 * pointercancel, dispose); this file keeps its own lean copy of that harness
 * because it needs a second media kind (a real video, for the ghost) and real
 * `buttons` state on its events, which that harness does not model.
 *
 * Fixture numbers all differ (canvas vs media size, stage scale, canvas origin,
 * start pose), so client, project and source px cannot be confused.
 */

const PROJ_W = 1280;
const PROJ_H = 720;
const MEDIA_W = 800;
const MEDIA_H = 500;
const STAGE_SCALE = 0.5;
const CANVAS_LEFT = 37;
const CANVAS_TOP = 19;
const START_X = 12;
const START_Y = -7;
const START_SCALE = 0.75;
const CLIP_START = 3;
const PLAYHEAD = 4.25;
const POINTER_ID = 7;
const OTHER_POINTER_ID = 9;

const toClientX = (projX: number): number => projX * STAGE_SCALE + CANVAS_LEFT;
const toClientY = (projY: number): number => projY * STAGE_SCALE + CANVAS_TOP;
const CENTER_PROJ_X = PROJ_W / 2 + START_X;
const CENTER_PROJ_Y = PROJ_H / 2 + START_Y;

/* ---------------- minimal DOM ---------------- */

interface FakeEl {
  tagName: string;
  className: string;
  tabIndex: number;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  src: string;
  children: FakeEl[];
  parent: FakeEl | null;
  captured: Set<number>;
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
    src: "",
    children: [],
    parent: null,
    captured: new Set<number>(),
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
    focus(): void {},
    setPointerCapture(id: number): void {
      el.captured.add(id);
    },
    // Releasing a held capture fires lostpointercapture at the element, as the
    // real one does — so every end path's own release re-enters the overlay's
    // lostpointercapture handler, and a gesture that was not dropped first
    // would be cancelled a second time (and revert a committed drag).
    releasePointerCapture(id: number): void {
      if (!el.captured.has(id)) throw new Error(`no capture for pointer ${id}`);
      el.captured.delete(id);
      el.fire("lostpointercapture", { pointerId: id });
    },
    getBoundingClientRect(): DOMRect {
      const left = CANVAS_LEFT + pxOf(el.style.left);
      const top = CANVAS_TOP + pxOf(el.style.top);
      const width = pxOf(el.style.width);
      const height = pxOf(el.style.height);
      return {
        left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
    fire(type: string, e: unknown): void {
      for (const fn of [...(el.listeners.get(type) ?? [])]) fn(e);
    },
  };
  return el;
}

function findByData(root: FakeEl, key: string, value: string): FakeEl {
  const stack = [...root.children];
  while (stack.length) {
    const el = stack.shift()!;
    if (el.dataset[key] === value) return el;
    stack.push(...el.children);
  }
  throw new Error(`no element with data-${key}="${value}"`);
}

/* ---------------- harness ---------------- */

interface Harness {
  session: ProjectSession;
  selection: Store<string | null>;
  overlay: FakeEl;
  clipId: string;
  handle: CanvasOverlay;
  ends: number;
  clip(): NonNullable<ReturnType<typeof findClip>>["clip"];
}

function textMedia(): Parameters<typeof addMedia>[1] {
  return {
    path: "text: hold me",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 6,
    hasAudio: false,
    width: MEDIA_W,
    height: MEDIA_H,
    generator: {
      type: "text", text: "hold me", fontFamily: "Segoe UI", sizePx: 64,
      color: "#ffffff", bold: false, italic: false,
    },
  };
}

function videoMedia(): Parameters<typeof addMedia>[1] {
  return {
    path: "D:\\Footage\\interview.mov",
    size: 1234,
    mtimeMs: 5678,
    kind: "video",
    duration: 6,
    hasAudio: false,
    width: MEDIA_W,
    height: MEDIA_H,
  };
}

function mount(opts: {
  media?: Parameters<typeof addMedia>[1];
  playbackUrl?: OverlayCtx["playbackUrl"];
} = {}): Harness {
  let p: ProjectFile = createProject("lost pointers");
  p = { ...p, timeline: { ...p.timeline, width: PROJ_W, height: PROJ_H } };
  const added = addMedia(p, opts.media ?? textMedia());
  p = added.project;
  const media: MediaRef = added.media;
  const clip = makeClip(media, CLIP_START);
  clip.transform = { ...defaultTransform(), x: START_X, y: START_Y, scale: START_SCALE };
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  const clipId = clip.id;

  const session = new ProjectSession("C:\\Users\\adirh\\Videos\\Taroting\\lost.trt", p);
  const selection = new Store<string | null>(null);
  const canvas = makeEl("div");
  const stage = { canvas, scale: STAGE_SCALE } as unknown as Stage;
  const scheduler = {
    visibleClipsAt: () => {
      const found = findClip(session.project, clipId);
      return found ? [{ clip: found.clip, track: found.track, media }] : [];
    },
  } as unknown as Scheduler;
  const engine = {
    get time(): number {
      return PLAYHEAD;
    },
    pause: () => {},
    onTick: () => () => {},
  } as unknown as PlaybackEngine;

  const h = { session, selection, clipId, ends: 0 } as Harness;
  h.handle = mountCanvasOverlay({
    stage, scheduler, engine, session, selection,
    refresh: () => {},
    playbackUrl: opts.playbackUrl,
    onGestureEnd: () => {
      h.ends++;
    },
  });
  h.overlay = canvas.children[0]!;
  h.clip = () => findClip(session.project, clipId)!.clip;
  return h;
}

/** A pointer event. `buttons` is what a REAL pointer reports (1 while the
 *  primary is held, 0 once it is up); `undefined` models the in-app E2E's
 *  synthesized events, which set `button` and never `buttons`. */
function pointer(
  h: Harness,
  type: string,
  clientX: number,
  clientY: number,
  buttons: number | undefined,
  target?: FakeEl,
): void {
  h.overlay.fire(type, {
    button: 0,
    buttons,
    pointerId: POINTER_ID,
    clientX,
    clientY,
    target: target ?? h.overlay,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

/** Press at the clip's centre (button held) and drag 60/36 project px — past
 *  the dead-zone, clear of the centre snap. */
function startMoveDrag(h: Harness, real = true): void {
  // Not a defaulted `buttons` parameter: passing `undefined` to one would
  // silently fall back to the default and model a real pointer after all.
  const buttons = real ? 1 : undefined;
  pointer(h, "pointerdown", toClientX(CENTER_PROJ_X), toClientY(CENTER_PROJ_Y), buttons);
  pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 60), toClientY(CENTER_PROJ_Y + 36), buttons);
}

function enterCrop(h: Harness): void {
  h.overlay.fire("dblclick", {
    clientX: toClientX(CENTER_PROJ_X),
    clientY: toClientY(CENTER_PROJ_Y),
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

/** In crop mode, drag the east window handle 24 client px INWARD (an outward
 *  drag on an uncropped clip clamps at the frame and writes nothing). */
function startCropDrag(h: Harness): { x: number; y: number; handle: FakeEl } {
  enterCrop(h);
  const handle = findByData(h.overlay, "crophandle", "e");
  const x = toClientX(CENTER_PROJ_X + 432);
  const y = toClientY(CENTER_PROJ_Y);
  pointer(h, "pointerdown", x, y, 1, handle);
  pointer(h, "pointermove", x - 24, y, 1, handle);
  return { x, y, handle };
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => makeEl(tag) });
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  });
  vi.stubGlobal("HTMLVideoElement", class {});
  settingsStore.set(DEFAULT_SETTINGS);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(ipc, "saveProject").mockResolvedValue({ modifiedAt: new Date().toISOString() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A move with the button already up                                    */
/* ------------------------------------------------------------------ */

describe("a canvas drag whose button came up unseen", () => {
  it("reverts a move drag on the first move that reports no button held", () => {
    const h = mount();
    const before = h.session.project;
    startMoveDrag(h);
    // The drag really edited, through replace() — so the revert below is real.
    expect(h.clip().transform!.x).toBe(START_X + 60);
    expect(h.handle.gestureActive()).toBe(true);

    // The pointerup went elsewhere; the pointer now wanders with nothing held.
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 200), toClientY(CENTER_PROJ_Y + 90), 0);

    expect(h.session.project).toBe(before);
    expect(h.clip().transform!.x).toBe(START_X);
    expect(h.handle.gestureActive()).toBe(false);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.overlay.captured.size).toBe(0);
    expect(h.ends).toBe(1);
    // The selection survives: this is a lost drag, not a deselect.
    expect(h.selection.get()).toBe(h.clipId);

    // And the dead drag cannot resume: a later held move edits nothing.
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 300), toClientY(CENTER_PROJ_Y), 1);
    expect(h.session.project).toBe(before);
  });

  it("drops a press still inside the dead-zone, so it can never arm later", () => {
    const h = mount();
    const before = h.session.project;
    pointer(h, "pointerdown", toClientX(CENTER_PROJ_X), toClientY(CENTER_PROJ_Y), 1);
    // Released unseen, then the pointer travels far with nothing held.
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 200), toClientY(CENTER_PROJ_Y + 90), 0);
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 220), toClientY(CENTER_PROJ_Y + 95), 1);

    expect(h.session.project).toBe(before);
    expect(h.handle.gestureActive()).toBe(false);
    expect(h.ends).toBe(0); // never a live drag, so nothing to end
  });

  it("reverts a crop drag the same way, staying in crop mode", () => {
    const h = mount();
    const before = h.session.project;
    const { x, y, handle } = startCropDrag(h);
    expect(h.clip().transform!.crop!.w).toBeLessThan(MEDIA_W);

    pointer(h, "pointermove", x - 120, y, 0, handle);

    expect(h.session.project).toBe(before);
    expect(h.clip().transform!.crop).toBeUndefined();
    expect(h.handle.gestureActive()).toBe(false);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.ends).toBe(1);
    // Still in crop mode: the window handle is still a live target.
    pointer(h, "pointerdown", x, y, 1, handle);
    pointer(h, "pointermove", x - 24, y, 1, handle);
    expect(h.clip().transform!.crop!.w).toBeLessThan(MEDIA_W);
  });

  // The gate the in-app E2E depends on: its synthesized pointers carry
  // `button: 0` and no `buttons`, so `buttons` reads 0 on every event. An
  // unconditional "no button held → cancel" would kill canvas-overlay-drag on
  // its first move; a gesture whose press never reported a button is not judged.
  it("does not judge a pointer whose press never reported its buttons", () => {
    const h = mount();
    startMoveDrag(h, false);
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 80), toClientY(CENTER_PROJ_Y + 40), undefined);
    expect(h.clip().transform!.x).toBe(START_X + 80);
    expect(h.handle.gestureActive()).toBe(true);
    pointer(h, "pointerup", toClientX(CENTER_PROJ_X + 80), toClientY(CENTER_PROJ_Y + 40), undefined);
    expect(h.session.history.canUndo).toBe(true);
  });

  it("keeps a held drag going while the button stays down", () => {
    const h = mount();
    startMoveDrag(h);
    pointer(h, "pointermove", toClientX(CENTER_PROJ_X + 90), toClientY(CENTER_PROJ_Y + 50), 1);
    expect(h.clip().transform!.x).toBe(START_X + 90);
    pointer(h, "pointerup", toClientX(CENTER_PROJ_X + 90), toClientY(CENTER_PROJ_Y + 50), 0);
    expect(h.clip().transform!.x).toBe(START_X + 90);
    expect(h.session.history.canUndo).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* lostpointercapture                                                   */
/* ------------------------------------------------------------------ */

describe("losing the pointer capture mid-drag", () => {
  it("reverts a live move drag", () => {
    const h = mount();
    const before = h.session.project;
    startMoveDrag(h);
    expect(h.session.project).not.toBe(before);

    // The capture goes away out from under the gesture (not through any of
    // the overlay's own releases).
    h.overlay.captured.delete(POINTER_ID);
    h.overlay.fire("lostpointercapture", { pointerId: POINTER_ID });

    expect(h.session.project).toBe(before);
    expect(h.handle.gestureActive()).toBe(false);
    expect(h.session.history.canUndo).toBe(false);
    expect(h.ends).toBe(1);
  });

  it("reverts a live crop drag", () => {
    const h = mount();
    const before = h.session.project;
    startCropDrag(h);
    h.overlay.captured.delete(POINTER_ID);
    h.overlay.fire("lostpointercapture", { pointerId: POINTER_ID });
    expect(h.session.project).toBe(before);
    expect(h.handle.gestureActive()).toBe(false);
    expect(h.ends).toBe(1);
  });

  it("ignores a capture lost by a pointer that does not own the drag", () => {
    const h = mount();
    startMoveDrag(h);
    const live = h.session.project;
    h.overlay.fire("lostpointercapture", { pointerId: OTHER_POINTER_ID });
    expect(h.session.project).toBe(live);
    expect(h.handle.gestureActive()).toBe(true);
  });

  // The crop branch keeps its own pointer match; a crop drag must survive
  // another pointer's capture ending exactly as a move drag does.
  it("ignores a capture lost by another pointer during a crop drag", () => {
    const h = mount();
    const { x, y, handle } = startCropDrag(h);
    const live = h.session.project;
    const liveW = h.clip().transform!.crop!.w;
    expect(liveW).toBeLessThan(MEDIA_W);

    h.overlay.fire("lostpointercapture", { pointerId: OTHER_POINTER_ID });

    expect(h.session.project).toBe(live);
    expect(h.handle.gestureActive()).toBe(true);
    expect(h.ends).toBe(0);
    // Still the same live drag: it keeps editing, then commits on release.
    pointer(h, "pointermove", x - 150, y, 1, handle);
    expect(h.clip().transform!.crop!.w).toBeLessThan(liveW);
    pointer(h, "pointerup", x - 150, y, 0, handle);
    expect(h.session.history.canUndo).toBe(true);
    expect(h.ends).toBe(1);
  });

  // The fake's releasePointerCapture fires lostpointercapture, as the real one
  // does, so the pointerup's own release re-enters the handler. It must find
  // the gesture already gone, or it would revert the drag that just committed.
  it("leaves a committed drag committed when its own release fires the event", () => {
    const h = mount();
    startMoveDrag(h);
    pointer(h, "pointerup", toClientX(CENTER_PROJ_X + 60), toClientY(CENTER_PROJ_Y + 36), 0);
    expect(h.clip().transform!.x).toBe(START_X + 60);
    expect(h.session.history.canUndo).toBe(true);
    expect(h.ends).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The crop ghost's video source                                        */
/* ------------------------------------------------------------------ */

describe("the crop ghost of a video", () => {
  function ghostVideo(h: Harness): FakeEl {
    const ghost = h.overlay.children.find((c) => c.className.includes("stage-overlay__ghost"))!;
    const media = ghost.children[0];
    expect(media?.tagName).toBe("video");
    return media!;
  }

  it("decodes the url the stage plays (the proxy), not the original file", () => {
    const asked: string[] = [];
    const h = mount({
      media: videoMedia(),
      playbackUrl: (m) => {
        asked.push(m.path);
        return "proxy:interview-proxy.mp4";
      },
    });
    enterCrop(h);
    expect(ghostVideo(h).src).toBe("proxy:interview-proxy.mp4");
    // Asked about THIS clip's media, not some other.
    expect(asked).toEqual(["D:\\Footage\\interview.mov"]);
  });

  it("falls back to the original file while no playback plan is ready", () => {
    const h = mount({ media: videoMedia(), playbackUrl: () => null });
    enterCrop(h);
    expect(ghostVideo(h).src).toBe("original:D:\\Footage\\interview.mov");
  });

  it("falls back to the original file when no accessor is wired", () => {
    const h = mount({ media: videoMedia() });
    enterCrop(h);
    expect(ghostVideo(h).src).toBe("original:D:\\Footage\\interview.mov");
  });
});
