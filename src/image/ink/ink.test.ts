// mountInk end to end against a fake stage: pointer events in, ONE commit out.
//
// The layer model and the geometry belong to another module (layers.ts /
// geom.ts); they are mocked here with small reference implementations of their
// locked contracts, so these tests pin what THIS module does with them: where
// a mark is committed, in which layer's space, in how many undo steps, and what
// a cancelled gesture leaves behind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipTransform, ProjectFile, Stroke } from "../../core/types";
import { Store } from "../../core/store";
import { decodePoints } from "../strokes";
import { createToolStore, cssToSource, type ToolState } from "../tool-state";

const ref = vi.hoisted(() => {
  type T = { rotate: number; flipH: boolean; flipV: boolean; scale: number; x: number; y: number };
  /** The spec's native-pixel matrix: T(W/2+x, H/2+y)·R·F·S·T(−src/2). */
  const toCanvas = (t: T, sw: number, sh: number, W: number, H: number, u: number, v: number) => {
    const r = (t.rotate * Math.PI) / 180;
    let qx = (u - sw / 2) * t.scale * (t.flipH ? -1 : 1);
    let qy = (v - sh / 2) * t.scale * (t.flipV ? -1 : 1);
    [qx, qy] = [qx * Math.cos(r) - qy * Math.sin(r), qx * Math.sin(r) + qy * Math.cos(r)];
    return { x: qx + W / 2 + t.x, y: qy + H / 2 + t.y };
  };
  const toLayer = (t: T, sw: number, sh: number, W: number, H: number, px: number, py: number) => {
    const r = (t.rotate * Math.PI) / 180;
    const dx = px - W / 2 - t.x;
    const dy = py - H / 2 - t.y;
    let qx = dx * Math.cos(r) + dy * Math.sin(r);
    let qy = -dx * Math.sin(r) + dy * Math.cos(r);
    qx = (qx * (t.flipH ? -1 : 1)) / t.scale;
    qy = (qy * (t.flipV ? -1 : 1)) / t.scale;
    return { x: qx + sw / 2, y: qy + sh / 2 };
  };
  return { toCanvas, toLayer };
});

vi.mock("../geom", () => ({
  canvasToLayer: ref.toLayer,
}));

/** Makes the mocked appendStrokeTo refuse (return its input), as the real one
 *  does for a layer that is not a drawing. */
const appendRefuses = vi.hoisted(() => ({ on: false }));

vi.mock("../layers", () => {
  type P = ProjectFile;
  const layersOf = (p: P) =>
    p.timeline.tracks
      .filter((t) => t.kind === "video" && t.clips.length === 1)
      .map((t, index) => {
        const clip = t.clips[0]!;
        const media = p.media.find((m) => m.id === clip.mediaId)!;
        return {
          trackId: t.id,
          clipId: clip.id,
          mediaId: media.id,
          kind: media.generator?.type === "drawing" ? "drawing" : "photo",
          name: t.name,
          hidden: t.hidden === true,
          index,
          clip,
          media,
          transform: clip.transform!,
        };
      });
  const findLayer = (p: P, id: string) => layersOf(p).find((l) => l.trackId === id);
  let made = 0;
  return {
    layersOf,
    findLayer,
    drawingTarget: (p: P, sel: string | null) => {
      const ls = layersOf(p);
      const at = sel === null ? -1 : ls.findIndex((l) => l.trackId === sel);
      if (at < 0) {
        const top = ls.find((l) => l.kind === "drawing" && !l.hidden);
        return top ? { trackId: top.trackId } : { create: { above: null } };
      }
      for (let i = at; i >= 0; i--) {
        const l = ls[i]!;
        if (l.kind === "drawing" && !l.hidden) return { trackId: l.trackId };
      }
      return { create: { above: sel } };
    },
    addDrawingLayer: (p: P, opts?: { above?: string | null }) => {
      const id = `made-${++made}`;
      const track = {
        id,
        kind: "video" as const,
        name: "Drawing",
        muted: false,
        clips: [
          {
            id: `${id}-clip`,
            mediaId: `${id}-media`,
            timelineStart: 0,
            srcIn: 0,
            srcOut: 1,
            speed: 1,
            transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 } as ClipTransform,
            audio: {} as never,
          },
        ],
      };
      const tracks = [...p.timeline.tracks];
      const i = opts?.above ? tracks.findIndex((t) => t.id === opts.above) : 0;
      tracks.splice(Math.max(i, 0), 0, track);
      const media = {
        id: `${id}-media`,
        kind: "image",
        path: "Drawing",
        width: p.timeline.width,
        height: p.timeline.height,
        generator: { type: "drawing", chunks: [] },
      };
      return { project: { ...p, timeline: { ...p.timeline, tracks }, media: [...p.media, media] } as P, trackId: id };
    },
    appendStrokeTo: (p: P, id: string, s: Stroke) => {
      if (appendRefuses.on) return p;
      const l = findLayer(p, id)!;
      const gen = l.media.generator as { type: "drawing"; chunks: Stroke[][] };
      const media = p.media.map((m) =>
        m.id === l.mediaId ? { ...m, generator: { type: "drawing", chunks: [[...gen.chunks.flat(), s]] } } : m,
      );
      return { ...p, media } as P;
    },
    eraseStrokes: (p: P, hits: ReadonlyMap<string, ReadonlySet<Stroke>>) => {
      let q = p;
      for (const [id, doomed] of hits) {
        if (doomed.size === 0) continue;
        const l = findLayer(q, id)!;
        const gen = l.media.generator as { type: "drawing"; chunks: Stroke[][] };
        const left = gen.chunks.flat().filter((s) => !doomed.has(s));
        q = {
          ...q,
          media: q.media.map((m) => (m.id === l.mediaId ? { ...m, generator: { type: "drawing", chunks: left.length ? [left] : [] } } : m)),
        } as P;
      }
      return q;
    },
  };
});

/** What each live paint was asked to draw (the real painter still runs). */
const liveMarks = vi.hoisted(() => [] as { pts: Float32Array; count: number }[]);
vi.mock("./paint", async (orig) => {
  const real = await orig<typeof import("./paint")>();
  return {
    ...real,
    paintLiveMark: (c: unknown, m: { pts: Float32Array; count: number }, sc: unknown) => {
      liveMarks.push({ pts: m.pts.slice(0, m.count * 3), count: m.count });
      return real.paintLiveMark(c as never, m as never, sc as never);
    },
  };
});

/** Every toast the module shows, as "kind: message". */
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../ui/toast", () => ({
  toast: {
    info: (m: string) => void toasts.push(`info: ${m}`),
    error: (m: string) => void toasts.push(`error: ${m}`),
  },
}));

// Imported after the mocks.
const { mountInk } = await import("./ink");

/* ---------------- a fake DOM, just enough of it ---------------- */

type Handler = (e: unknown) => void;
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = "";
  hidden = false;
  tabIndex = 0;
  textContent = "";
  clientLeft = 0;
  clientTop = 0;
  style: Record<string, unknown> = { setProperty: () => {} };
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<Handler>>();
  classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(" ").includes(c);
      const want = on ?? !has;
      if (want && !has) this.className = `${this.className} ${c}`.trim();
      if (!want && has) this.className = this.className.split(" ").filter((x) => x !== c).join(" ");
      return want;
    },
  };
  constructor(readonly tagName: string) {}
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  /** Node.compareDocumentPosition, for siblings only (all this stage has). */
  compareDocumentPosition(other: El): number {
    const sib = this.parentNode?.children ?? [];
    const a = sib.indexOf(this);
    const b = sib.indexOf(other);
    if (a < 0 || b < 0 || other.parentNode !== this.parentNode) return 1;
    return b > a ? 4 : b < a ? 2 : 0;
  }
  insertBefore(c: El, before: El): El {
    c.remove();
    c.parentNode = this;
    const i = this.children.indexOf(before);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  remove(): void {
    if (!this.parentNode) return;
    const sib = this.parentNode.children;
    sib.splice(sib.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  addEventListener(t: string, fn: Handler): void {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Handler): void {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string, e: unknown): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e);
  }
  getBoundingClientRect() {
    return { left: 100, top: 50, width: 900, height: 500, right: 1000, bottom: 550 };
  }
  // The E2E's synthetic pointers have no capture to take: this must be survivable.
  setPointerCapture(): void {
    throw new Error("InvalidPointerId");
  }
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}
}

let modalOpen = false;
const winListeners = new Map<string, Set<Handler>>();

function installDom(): void {
  modalOpen = false;
  winListeners.clear();
  vi.stubGlobal("document", {
    createElement: (tag: string) => new El(tag),
    querySelector: (sel: string) => (sel === ".modal-backdrop" && modalOpen ? {} : null),
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
    activeElement: null,
  });
  vi.stubGlobal("window", {
    addEventListener: (t: string, fn: Handler) => {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: Handler) => winListeners.get(t)?.delete(fn),
  });
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });
  vi.stubGlobal(
    "Path2D",
    class {
      moveTo() {}
      lineTo() {}
      arc() {}
      closePath() {}
      ellipse() {}
    },
  );
}

/* ---------------- fixtures ---------------- */

// Canvas 641×361; the view puts canvas (0,0) at client (100, 50), 0.75 css px
// per canvas px (zoom 1.5 device px at dpr 2) — every axis differs.
const W = 641;
const H = 361;
const VIEW = { zoom: 1.5, dpr: 2, panX: 0, panY: 0, stageW: 1800, stageH: 1000 };
const CSS_PER_CANVAS = VIEW.zoom / VIEW.dpr;
const toClient = (x: number, y: number) => ({ x: 100 + x * CSS_PER_CANVAS, y: 50 + y * CSS_PER_CANVAS });

const ROTATED: ClipTransform = { rotate: 90, flipH: true, flipV: false, scale: 0.5, x: 30, y: -10, opacity: 1 };

function project(opts: { drawing?: { transform: ClipTransform; strokes: Stroke[]; hidden?: boolean } } = {}): ProjectFile {
  const tracks: unknown[] = [];
  const media: unknown[] = [
    { id: "m-photo", kind: "image", path: "C:\\p.png", width: W, height: H },
  ];
  if (opts.drawing) {
    tracks.push({
      id: "t-draw",
      kind: "video",
      name: "Drawing 1",
      muted: false,
      hidden: opts.drawing.hidden ? true : undefined,
      clips: [{ id: "c-draw", mediaId: "m-draw", timelineStart: 0, srcIn: 0, srcOut: 1, speed: 1, transform: opts.drawing.transform, audio: {} }],
    });
    media.push({
      id: "m-draw",
      kind: "image",
      path: "Drawing",
      width: 200,
      height: 100,
      generator: { type: "drawing", chunks: [opts.drawing.strokes] },
    });
  }
  tracks.push({
    id: "t-photo",
    kind: "video",
    name: "p",
    muted: false,
    clips: [
      {
        id: "c-photo",
        mediaId: "m-photo",
        timelineStart: 0,
        srcIn: 0,
        srcOut: 1,
        speed: 1,
        transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0, opacity: 1 },
        audio: {},
      },
    ],
  });
  return { schema: 3, kind: "image", timeline: { width: W, height: H, fps: { num: 30, den: 1 }, tracks }, media } as unknown as ProjectFile;
}

function harness(p: ProjectFile, tool: ToolState["tool"] = "pen") {
  const store = new Store<ProjectFile>(p);
  const history: ProjectFile[] = [];
  const events = { commits: 0, commitFroms: 0, replaces: 0, holds: 0, releases: 0 };
  // The real session's `edited` rule: commit / commitFrom / replace all mark
  // the project edited, except replace(..., { edit: false }).
  let edited = false;
  const session = {
    store,
    get project() {
      return store.get();
    },
    commit(fn: (p: ProjectFile) => ProjectFile) {
      const before = store.get();
      const after = fn(before);
      if (after === before) return;
      history.push(before);
      events.commits++;
      edited = true;
      store.set(after);
    },
    commitFrom(before: ProjectFile) {
      if (store.get() === before) return;
      history.push(before);
      events.commitFroms++;
      edited = true;
    },
    replace(next: ProjectFile, opts?: { edit?: boolean }) {
      events.replaces++;
      if (opts?.edit !== false) edited = true;
      store.set(next);
    },
  };
  const stage = new El("div");
  const tools = createToolStore();
  tools.set({ ...tools.get(), tool });
  const lives: unknown[] = [];
  const ctx = {
    session,
    tools,
    selection: new Store<string | null>("t-photo"),
    view: {
      store: new Store(VIEW),
      panning: false,
      clientToCanvas: (x: number, y: number) => ({ x: (x - 100) / CSS_PER_CANVAS, y: (y - 50) / CSS_PER_CANVAS }),
      canvasToClient: (x: number, y: number) => toClient(x, y),
      fit() {},
      actual() {},
      zoomAt() {},
      panBy() {},
    },
    res: {},
    stage,
    requestRender: vi.fn(),
    setLive: (l: unknown) => lives.push(l),
    holdAutosave: () => {
      events.holds++;
      let done = false;
      return () => {
        if (!done) events.releases++;
        done = true;
      };
    },
    mode: new Store<"idle" | "crop-image" | "crop-layer">("idle"),
    registerOverlay: () => () => {},
  };
  const handle = mountInk(ctx as never);
  const surface = (): El | undefined => stage.children.find((c) => c.className === "imged-ink");
  const isEdited = (): boolean => edited;
  return { ctx, session, store, history, events, stage, surface, lives, handle, isEdited };
}

function ptr(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const c = toClient(x, y);
  return {
    type,
    pointerId: 41,
    pointerType: "pen",
    button: 0,
    buttons: 1,
    pressure: 0.8,
    clientX: c.x,
    clientY: c.y,
    shiftKey: false,
    getCoalescedEvents: () => [],
    preventDefault: () => {},
    stopPropagation: () => {},
    ...extra,
  };
}

/** A zigzag across the top-left quadrant: pointerdown, 6 moves, pointerup. */
const ZIGZAG: [number, number][] = [
  [40, 40],
  [70, 90],
  [100, 40],
  [130, 90],
  [160, 40],
  [190, 90],
  [220, 40],
];

function draw(h: ReturnType<typeof harness>, path: [number, number][], extra: Record<string, unknown> = {}): void {
  const s = h.surface()!;
  s.fire("pointerdown", ptr("pointerdown", path[0]![0], path[0]![1], extra));
  for (const [x, y] of path.slice(1)) s.fire("pointermove", ptr("pointermove", x, y, extra));
  const [lx, ly] = path[path.length - 1]!;
  s.fire("pointerup", ptr("pointerup", lx, ly, { ...extra, pressure: 0 }));
}

function drawingStrokes(p: ProjectFile, trackId: string): Stroke[] {
  const t = p.timeline.tracks.find((x) => x.id === trackId)!;
  const m = p.media.find((x) => x.id === t.clips[0]!.mediaId)!;
  return (m.generator as { chunks: Stroke[][] }).chunks.flat();
}

beforeEach(installDom);
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- tests ---------------- */

describe("pen", () => {
  it("creates the drawing layer AND its first stroke in ONE commit, from synthetic moves", async () => {
    const h = harness(project());
    // What the Layers panel sees when the project notification lands: it
    // clears a selection it cannot find, so the new layer must ALREADY be the
    // selection by then (set in the same tick as the commit).
    let selAtNotify: string | null | undefined;
    h.store.subscribe(() => {
      selAtNotify = h.ctx.selection.get();
    });
    draw(h, ZIGZAG);
    expect(h.events.commits).toBe(1);
    expect(h.history).toHaveLength(1);
    expect(h.ctx.selection.get()).toMatch(/^made-/);
    const p = h.store.get();
    // the new layer sits directly above the selected photo
    const made = p.timeline.tracks[0]!.id;
    expect(made).toMatch(/^made-/);
    expect(p.timeline.tracks.map((t) => t.id)).toEqual([made, "t-photo"]);
    const [s] = drawingStrokes(p, made);
    if (!s || !("p" in s) || s.t !== "pen") throw new Error("no pen stroke");
    const pts = decodePoints(s.p)!;
    // getCoalescedEvents() → [] still gave one sample per move: 7 points
    // (a zigzag, so simplification keeps every corner)
    expect(pts.length / 3).toBe(7);
    // local == canvas on a fresh layer; the first point is where the pen landed
    expect(pts[0]).toBeCloseTo(40, 3);
    expect(pts[1]).toBeCloseTo(40, 3);
    expect(pts[(6 * 3)]).toBeCloseTo(220, 3);
    // width: 4 css px at 0.75 css per canvas px, layer scale 1
    expect(s.w).toBeCloseTo(cssToSource(4, 2, 1.5, 1), 9);
    expect(s.o).toBe(1);
    expect(s.c).toBe("#000000");
    // the layer that received the ink is selected; the hold is released; the
    // live mark is cleared
    await Promise.resolve();
    expect(h.ctx.selection.get()).toBe(made);
    expect(selAtNotify).toBe(made);
    expect(h.events.holds).toBe(1);
    expect(h.events.releases).toBe(1);
    expect(h.lives[h.lives.length - 1]).toBe(null);
    h.handle.dispose();
  });

  it("lands under the cursor on a rotated, flipped, half-scale drawing layer", () => {
    // The same gesture on a fresh (identity) layer is the reference: there,
    // layer px ARE canvas px, i.e. exactly where the pen went.
    const plain = harness(project());
    draw(plain, ZIGZAG);
    const [flat] = drawingStrokes(plain.store.get(), plain.store.get().timeline.tracks[0]!.id);
    if (!flat || !("p" in flat)) throw new Error("no reference stroke");
    const want = decodePoints(flat.p)!;
    plain.handle.dispose();

    const h = harness(project({ drawing: { transform: ROTATED, strokes: [] } }), "pen");
    h.ctx.selection.set("t-draw");
    // The LIVE mark is drawn in the target's space too (the renderer hands its
    // paint a layer-local transform).
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", ZIGZAG[0]![0], ZIGZAG[0]![1]));
    surf.fire("pointermove", ptr("pointermove", ZIGZAG[1]![0], ZIGZAG[1]![1]));
    const live = h.lives[h.lives.length - 1] as { trackId: string; paint(c: unknown): void };
    expect(live.trackId).toBe("t-draw");
    liveMarks.length = 0;
    live.paint({ globalAlpha: 1, save() {}, restore() {}, fill() {}, stroke() {}, beginPath() {}, arc() {} });
    const lm = liveMarks[0]!;
    const first = ref.toCanvas(ROTATED, 200, 100, W, H, lm.pts[0]!, lm.pts[1]!);
    expect(first.x).toBeCloseTo(ZIGZAG[0]![0], 3);
    expect(first.y).toBeCloseTo(ZIGZAG[0]![1], 3);
    surf.fire("pointercancel", ptr("pointercancel", 0, 0));

    draw(h, ZIGZAG);
    const [s] = drawingStrokes(h.store.get(), "t-draw");
    if (!s || !("p" in s)) throw new Error("no stroke");
    const pts = decodePoints(s.p)!;
    expect(pts.length).toBe(want.length);
    for (let i = 0; i < pts.length / 3; i++) {
      const c = ref.toCanvas(ROTATED, 200, 100, W, H, pts[i * 3]!, pts[i * 3 + 1]!);
      expect(c.x, `x${i}`).toBeCloseTo(want[i * 3]!, 2);
      expect(c.y, `y${i}`).toBeCloseTo(want[i * 3 + 1]!, 2);
    }
    // and not trivially: the stored points are NOT canvas px
    expect(Math.abs(pts[0]! - want[0]!) + Math.abs(pts[1]! - want[1]!)).toBeGreaterThan(10);
    // the stored width is in THAT layer's source px (scale 0.5 → twice as many)
    expect(s.w).toBeCloseTo(cssToSource(4, 2, 1.5, 0.5), 9);
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
  });

  it("re-resolves the target at commit when an undo removed it mid-gesture", () => {
    const h = harness(project({ drawing: { transform: ROTATED, strokes: [] } }), "pen");
    h.ctx.selection.set("t-draw");
    const s = h.surface()!;
    s.fire("pointerdown", ptr("pointerdown", 40, 40));
    s.fire("pointermove", ptr("pointermove", 90, 70));
    // an undo with the pen still down takes the drawing layer away
    h.store.set(project());
    h.ctx.selection.set(null);
    s.fire("pointerup", ptr("pointerup", 120, 50));
    const p = h.store.get();
    const made = p.timeline.tracks[0]!.id;
    expect(made).toMatch(/^made-/);
    const [st] = drawingStrokes(p, made);
    if (!st || !("p" in st)) throw new Error("no stroke");
    // mapped into the NEW layer (identity): canvas px
    expect(decodePoints(st.p)![0]).toBeCloseTo(40, 3);
    h.handle.dispose();
  });

  it("a stroke that cannot be appended leaves no empty layer behind", () => {
    appendRefuses.on = true;
    try {
      const h = harness(project());
      draw(h, ZIGZAG);
      expect(h.events.commits).toBe(0);
      expect(h.store.get().timeline.tracks.map((t) => t.id)).toEqual(["t-photo"]);
      h.handle.dispose();
    } finally {
      appendRefuses.on = false;
    }
  });

  it("never draws with a right click or the middle button", () => {
    const h = harness(project());
    draw(h, ZIGZAG, { button: 2, buttons: 2 });
    draw(h, ZIGZAG, { button: 1, buttons: 4 });
    expect(h.events.commits).toBe(0);
    expect(h.events.holds).toBe(0);
    h.handle.dispose();
  });

  it("ignores a touch once a pen has been seen (palm rejection)", () => {
    const h = harness(project());
    draw(h, ZIGZAG);
    draw(h, ZIGZAG.map(([x, y]) => [x, y + 100] as [number, number]), { pointerType: "touch", pointerId: 7 });
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
  });
});

describe("shapes", () => {
  // A drawing layer scaled down to a sliver: the loader refuses any shape end
  // past ±1e7 layer px, and here a canvas offset of a few hundred px is
  // divided by 1e-6. A plain drag lands far outside that; so does a tap.
  const SLIVER: ClipTransform = { rotate: 0, flipH: false, flipV: false, scale: 1e-6, x: 0, y: 0, opacity: 1 };
  const PLAIN: ClipTransform = { ...SLIVER, scale: 1 };
  beforeEach(() => {
    toasts.length = 0;
  });

  it("control: a drag on a plain drawing layer commits one arrow, silently", () => {
    const h = harness(project({ drawing: { transform: PLAIN, strokes: [] } }), "shape");
    draw(h, [
      [40, 40],
      [220, 90],
    ]);
    expect(h.events.commits).toBe(1);
    expect(drawingStrokes(h.store.get(), "t-draw").map((s) => s.t)).toEqual(["arrow"]);
    expect(toasts).toEqual([]);
    h.handle.dispose();
  });

  it("a drag whose ends land out of the loader's range commits nothing, and says why", () => {
    const h = harness(project({ drawing: { transform: SLIVER, strokes: [] } }), "shape");
    draw(h, [
      [40, 40],
      [220, 90],
    ]);
    expect(h.events.commits).toBe(0);
    expect(drawingStrokes(h.store.get(), "t-draw")).toEqual([]);
    expect(toasts).toEqual(["info: That shape reaches too far outside the layer to keep."]);
    h.handle.dispose();
  });

  it("a flick too short to be a shape stays silent there, out of range or not", () => {
    const h = harness(project({ drawing: { transform: SLIVER, strokes: [] } }), "shape");
    draw(h, [
      [40, 40],
      [40.5, 40.3],
    ]);
    expect(h.events.commits).toBe(0);
    expect(toasts).toEqual([]);
    h.handle.dispose();
  });
});

describe("cancelling", () => {
  it("a second finger (the view starting a pinch) drops a touch mark", async () => {
    const h = harness(project());
    const s = h.surface()!;
    const touch = { pointerType: "touch", pointerId: 3 };
    s.fire("pointerdown", ptr("pointerdown", 40, 40, touch));
    s.fire("pointermove", ptr("pointermove", 90, 70, touch));
    // the view claims both fingers in its capture phase and starts zooming
    h.ctx.view.panning = true;
    h.ctx.view.store.set({ ...VIEW, zoom: 1.8 });
    await Promise.resolve();
    s.fire("pointerup", ptr("pointerup", 120, 50, touch));
    expect(h.events.commits).toBe(0);
    expect(h.events.releases).toBe(1);
    h.handle.dispose();
  });

  it("after a pinch, a fresh single finger draws again (the pinch's ups reach only the window)", async () => {
    const h = harness(project());
    const s = h.surface()!;
    const f1 = { pointerType: "touch", pointerId: 3 };
    const f2 = { pointerType: "touch", pointerId: 4 };
    s.fire("pointerdown", ptr("pointerdown", 40, 40, f1));
    s.fire("pointermove", ptr("pointermove", 90, 70, f1));
    // Finger 2 lands: the view stops ITS pointerdown in the capture phase (the
    // surface never sees it), takes both fingers and starts zooming.
    h.ctx.view.panning = true;
    h.ctx.view.store.set({ ...VIEW, zoom: 1.8 });
    await Promise.resolve();
    // Both fingers lift. Captured by the view: their ups reach the window's
    // capture phase and the stage, never this surface.
    for (const f of [f1, f2]) {
      for (const fn of winListeners.get("pointerup") ?? []) fn(ptr("pointerup", 120, 50, f));
    }
    h.ctx.view.panning = false;
    h.ctx.view.store.set({ ...VIEW });
    await Promise.resolve();
    expect(h.events.commits).toBe(0);
    // a new single finger is a mark again, not "a second finger"
    draw(h, ZIGZAG, { pointerType: "touch", pointerId: 5 });
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
    // and the window listeners go with the editor
    expect(winListeners.get("pointerup")?.size ?? 0).toBe(0);
    expect(winListeners.get("pointercancel")?.size ?? 0).toBe(0);
  });

  it("a finger the view takes over (capture lost) leaves the count too", async () => {
    const h = harness(project());
    const s = h.surface()!;
    const f1 = { pointerType: "touch", pointerId: 3 };
    s.fire("pointerdown", ptr("pointerdown", 40, 40, f1));
    s.fire("lostpointercapture", ptr("lostpointercapture", 40, 40, f1));
    expect(h.events.releases).toBe(1);
    draw(h, ZIGZAG, { pointerType: "touch", pointerId: 5 });
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
  });

  it("Esc drops the mark in progress: nothing committed, hold released, live cleared", () => {
    const h = harness(project());
    const s = h.surface()!;
    s.fire("pointerdown", ptr("pointerdown", 40, 40));
    s.fire("pointermove", ptr("pointermove", 90, 70));
    let stopped = false;
    const key = { key: "Escape", repeat: false, target: null, preventDefault: () => {}, stopImmediatePropagation: () => (stopped = true) };
    for (const fn of winListeners.get("keydown") ?? []) fn(key);
    expect(stopped).toBe(true);
    s.fire("pointerup", ptr("pointerup", 120, 50));
    expect(h.events.commits).toBe(0);
    expect(h.events.releases).toBe(1);
    expect(h.lives[h.lives.length - 1]).toBe(null);
    h.handle.dispose();
  });

  it("Esc behind a modal is not the ink's to take", () => {
    const h = harness(project());
    const s = h.surface()!;
    s.fire("pointerdown", ptr("pointerdown", 40, 40));
    modalOpen = true;
    let stopped = false;
    const key = { key: "Escape", repeat: false, target: null, preventDefault: () => {}, stopImmediatePropagation: () => (stopped = true) };
    for (const fn of winListeners.get("keydown") ?? []) fn(key);
    expect(stopped).toBe(false);
    s.fire("pointerup", ptr("pointerup", 90, 70));
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
  });
});

describe("stroke eraser", () => {
  // A horizontal stroke in the rotated layer's own space, y = 50, x 20..180.
  const mark: Stroke = { t: "pen", c: "#112233", w: 4, o: 1, p: "" };

  async function withMark() {
    const { encodePoints } = await import("../strokes");
    const s = { ...mark, p: encodePoints(new Float32Array([20, 50, 1, 180, 50, 1])) } as Stroke;
    const h = harness(project({ drawing: { transform: ROTATED, strokes: [s] } }), "eraser");
    return { h, s };
  }

  it("removes a stroke on a rotated layer where it is DRAWN, in one undo step", async () => {
    const { h, s } = await withMark();
    // where the stroke's middle is on the canvas
    const mid = ref.toCanvas(ROTATED, 200, 100, W, H, 100, 50);
    draw(h, [
      [mid.x - 30, mid.y],
      [mid.x + 30, mid.y],
    ]);
    expect(drawingStrokes(h.store.get(), "t-draw")).toEqual([]);
    expect(h.events.replaces).toBeGreaterThan(0);
    expect(h.events.commitFroms).toBe(1);
    expect(h.history).toHaveLength(1);
    expect(drawingStrokes(h.history[0]!, "t-draw")).toEqual([s]);
    // the release's commit is what marks it edited
    expect(h.isEdited()).toBe(true);
    h.handle.dispose();
  });

  it("misses where the stroke would be if the layer's rotation were ignored", async () => {
    const { h } = await withMark();
    // unrotated, unflipped, unscaled placement of local (100, 50)
    const naive = { x: 100 - 100 + W / 2 + 30, y: 50 - 50 + H / 2 - 10 + 60 };
    draw(h, [
      [naive.x - 30, naive.y],
      [naive.x + 30, naive.y],
    ]);
    expect(drawingStrokes(h.store.get(), "t-draw")).toHaveLength(1);
    expect(h.history).toHaveLength(0);
    h.handle.dispose();
  });

  it("is not thrown off by an autosave re-stamping the project mid-gesture", async () => {
    const { h } = await withMark();
    const mid = ref.toCanvas(ROTATED, 200, 100, W, H, 100, 50);
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", mid.x - 30, mid.y - 40));
    // what a save pass does: same content, new object, new modifiedAt
    h.store.set({ ...h.store.get(), modifiedAt: "2026-09-29T12:00:00.000Z" } as ProjectFile);
    surf.fire("pointermove", ptr("pointermove", mid.x - 30, mid.y));
    surf.fire("pointermove", ptr("pointermove", mid.x + 30, mid.y));
    surf.fire("pointerup", ptr("pointerup", mid.x + 30, mid.y));
    expect(drawingStrokes(h.store.get(), "t-draw")).toEqual([]);
    expect(h.history).toHaveLength(1);
    h.handle.dispose();
  });

  it("an eraser pass that touches nothing adds no history step", async () => {
    const { h } = await withMark();
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", 5, 5));
    h.store.set({ ...h.store.get(), modifiedAt: "2026-09-29T12:00:00.000Z" } as ProjectFile);
    surf.fire("pointermove", ptr("pointermove", 15, 5));
    surf.fire("pointerup", ptr("pointerup", 15, 5));
    expect(h.history).toHaveLength(0);
    h.handle.dispose();
  });

  it("puts everything back on Esc", async () => {
    const { h, s } = await withMark();
    const mid = ref.toCanvas(ROTATED, 200, 100, W, H, 100, 50);
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", mid.x - 30, mid.y));
    surf.fire("pointermove", ptr("pointermove", mid.x + 30, mid.y));
    expect(drawingStrokes(h.store.get(), "t-draw")).toEqual([]);
    const key = { key: "Escape", repeat: false, target: null, preventDefault: () => {}, stopImmediatePropagation: () => {} };
    for (const fn of winListeners.get("keydown") ?? []) fn(key);
    expect(drawingStrokes(h.store.get(), "t-draw")).toEqual([s]);
    expect(h.history).toHaveLength(0);
    // the previews and the put-back were not the user's edit: closing a
    // temporary project must not ask about it
    expect(h.events.replaces).toBeGreaterThan(0);
    expect(h.isEdited()).toBe(false);
    h.handle.dispose();
  });
});

describe("pixel eraser", () => {
  it("previews through the live mark on its layer, then commits ONE erase stroke", () => {
    const h = harness(project({ drawing: { transform: ROTATED, strokes: [] } }), "eraser");
    h.ctx.tools.set({ ...h.ctx.tools.get(), eraserMode: "pixel" });
    h.ctx.selection.set("t-draw");
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", ZIGZAG[0]![0], ZIGZAG[0]![1]));
    surf.fire("pointermove", ptr("pointermove", ZIGZAG[1]![0], ZIGZAG[1]![1]));
    // no project churn while the eraser moves: the live mark on t-draw is the preview
    expect(h.events.replaces).toBe(0);
    expect((h.lives[h.lives.length - 1] as { trackId: string }).trackId).toBe("t-draw");
    surf.fire("pointerup", ptr("pointerup", ZIGZAG[1]![0], ZIGZAG[1]![1]));
    const strokes = drawingStrokes(h.store.get(), "t-draw");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.t).toBe("erase");
    expect(strokes[0]!.w).toBeCloseTo(cssToSource(16, 2, 1.5, 0.5), 9);
    expect(h.events.commits).toBe(1);
    expect(h.history).toHaveLength(1);
    h.handle.dispose();
  });

  it("with no drawing layer to cut, does nothing at all", () => {
    const h = harness(project(), "eraser");
    h.ctx.tools.set({ ...h.ctx.tools.get(), eraserMode: "pixel" });
    draw(h, ZIGZAG);
    expect(h.events.replaces + h.events.commits + h.events.commitFroms + h.events.holds).toBe(0);
    h.handle.dispose();
  });

  it("never conjures a drawing layer when its own layer vanished mid-gesture", () => {
    const h = harness(project({ drawing: { transform: ROTATED, strokes: [] } }), "eraser");
    h.ctx.tools.set({ ...h.ctx.tools.get(), eraserMode: "pixel" });
    h.ctx.selection.set("t-draw");
    const surf = h.surface()!;
    surf.fire("pointerdown", ptr("pointerdown", 40, 40));
    surf.fire("pointermove", ptr("pointermove", 90, 70));
    h.store.set(project());
    h.ctx.selection.set("t-photo");
    surf.fire("pointerup", ptr("pointerup", 90, 70));
    expect(h.store.get().timeline.tracks.map((t) => t.id)).toEqual(["t-photo"]);
    expect(h.events.commits).toBe(0);
    expect(h.events.releases).toBe(1);
    h.handle.dispose();
  });
});

describe("the surface", () => {
  it("exists only while an ink tool is active, and stays under the ruler", async () => {
    const h = harness(project(), "select");
    expect(h.surface()).toBeUndefined();
    h.ctx.tools.set({ ...h.ctx.tools.get(), tool: "marker", ruler: { cx: 300, cy: 180, angle: 0 } });
    await Promise.resolve();
    const kids = h.stage.children.map((c) => c.className);
    expect(kids).toEqual(["imged-ink", "imged-ruler"]);
    h.ctx.tools.set({ ...h.ctx.tools.get(), tool: "select" });
    await Promise.resolve();
    expect(h.surface()).toBeUndefined();
    h.handle.dispose();
    expect(h.stage.children).toEqual([]);
  });
  it("showing the ruler with the pen down keeps the mark (the surface is not re-inserted)", async () => {
    const h = harness(project(), "pen");
    const surf = h.surface()!;
    // What the real DOM does: taking a node out of the document drops the
    // pointer capture it holds.
    const remove = surf.remove.bind(surf);
    surf.remove = () => {
      surf.fire("lostpointercapture", ptr("lostpointercapture", 0, 0));
      remove();
    };
    surf.fire("pointerdown", ptr("pointerdown", ZIGZAG[0]![0], ZIGZAG[0]![1]));
    surf.fire("pointermove", ptr("pointermove", ZIGZAG[1]![0], ZIGZAG[1]![1]));
    h.ctx.tools.set({ ...h.ctx.tools.get(), ruler: { cx: 300, cy: 180, angle: 0 } });
    await Promise.resolve();
    expect(h.stage.children.map((c) => c.className)).toEqual(["imged-ink", "imged-ruler"]);
    for (const [x, y] of ZIGZAG.slice(2)) surf.fire("pointermove", ptr("pointermove", x, y));
    surf.fire("pointerup", ptr("pointerup", 220, 40, { pressure: 0 }));
    expect(h.events.commits).toBe(1);
    h.handle.dispose();
  });

  it("Shift+wheel on the ruler (delivered as a horizontal wheel) rotates it 15°, and the view never sees it", async () => {
    const h = harness(project(), "pen");
    h.ctx.tools.set({ ...h.ctx.tools.get(), ruler: { cx: 300, cy: 180, angle: 0 } });
    await Promise.resolve();
    const r = h.stage.children.find((c) => c.className === "imged-ruler")!;
    const wheel = (extra: Record<string, unknown>) => {
      const e = { deltaY: 0, deltaX: 0, shiftKey: false, ctrlKey: false, prevented: false, stopped: false, ...extra } as Record<string, unknown>;
      e.preventDefault = () => (e.prevented = true);
      e.stopPropagation = () => (e.stopped = true);
      r.fire("wheel", e);
      return e;
    };
    const e1 = wheel({ deltaX: 100, shiftKey: true });
    expect(e1.prevented).toBe(true);
    expect(e1.stopped).toBe(true);
    expect(h.ctx.tools.get().ruler!.angle).toBe(15);
    wheel({ deltaX: -100, shiftKey: true });
    wheel({ deltaX: -100, shiftKey: true });
    expect(h.ctx.tools.get().ruler!.angle).toBe(-15);
    // a plain vertical wheel still steps 1° (two steps: one stays inside the
    // 1.5° snap around -15°)
    wheel({ deltaY: 100 });
    wheel({ deltaY: 100 });
    expect(h.ctx.tools.get().ruler!.angle).toBe(-13);
    // no delta at all is not the ruler's
    expect(wheel({}).prevented).toBe(false);
    h.handle.dispose();
  });

  it("the brush circle resizes on [ / ] while the pointer rests, around the same centre", async () => {
    const h = harness(project(), "pen");
    const surf = h.surface()!;
    const cur = surf.children.find((c) => c.className === "imged-ink__cursor")!;
    // hovering (no button), a mouse at client (400, 300); the surface is at (100, 50)
    surf.fire("pointermove", { ...ptr("pointermove", 0, 0, { pointerType: "mouse", buttons: 0 }), clientX: 400, clientY: 300 });
    expect(cur.hidden).toBe(false);
    expect(cur.style.width).toBe("4px");
    expect(cur.style.transform).toBe("translate(298px, 248px)");
    h.ctx.tools.set({ ...h.ctx.tools.get(), sizes: { ...h.ctx.tools.get().sizes, pen: 30 } });
    await Promise.resolve();
    expect(cur.style.width).toBe("30px");
    expect(cur.style.height).toBe("30px");
    expect(cur.style.transform).toBe("translate(285px, 235px)");
    h.handle.dispose();
  });
});
