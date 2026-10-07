// The video editor shell mounted against a fake DOM: what the shell itself
// wires — selection repaints, the bin's rebuild gate, the transport readout,
// focus handling on the speed menu and the project name, paste selection,
// imports that outlive the editor, a mount that throws halfway, and the
// teardown. vite.config pins `environment: "node"`, so every element is a small
// fake (listeners, classes, write-counting innerHTML/textContent) handed out by
// selector, and everything the shell builds ON — the playback stack, preview,
// overlay, theater, inspector, timeline, media manager, IPC, menus, toasts —
// is mocked to a recorder. The session, the project mutators and the stores
// are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, MediaInfo, MediaRef, ProjectFile } from "../core/types";
import type { InspectorHandle } from "./inspector/inspector";

const m = vi.hoisted(() => ({
  loaded: null as unknown as { project: ProjectFile; missing: string[]; recovered: boolean },
  probe: null as unknown as (path: string) => Promise<MediaInfo>,
  pick: null as unknown as () => Promise<string[]>,
  saves: 0,
  drop: null as null | { onDrop(paths: string[]): void },
  dropUnlisten: { calls: 0 },
  keys: new Map<string, () => void>(),
  shortcutsAttached: 0,
  shortcutsDetached: 0,
  closeTaskUnreg: 0,
  menu: [] as { label: string; onSelect: () => void }[],
  toasts: {
    info: [] as string[],
    error: [] as string[],
    refuse: [] as string[],
    notice: [] as Array<[string, string | undefined]>,
  },
  engine: null as unknown as {
    time: number;
    playing: boolean;
    durationCalls: number;
    emit(): void;
    speeds: number[];
  },
  throwOnSeek: false,
  throwOnRefresh: false,
  mediaDispose: [] as unknown[],
  /** The `missing` argument of every ensureAll call, in order. */
  ensureAllMissing: [] as (readonly string[] | undefined)[],
  media: null as unknown as {
    status: { set(v: Record<string, unknown>): void };
    damage: { set(v: Record<string, unknown>): void };
  },
  /** The options the shell constructed its MediaManager with. */
  mediaOpts: null as unknown as {
    onDamaged(mediaId: string, state: unknown, quick: boolean): void;
  },
  /** The options of every `toast.error`, in order (the messages stay in
   *  `toasts.error`). */
  errorOpts: [] as unknown[],
  timeline: null as unknown as {
    renders: number;
    deps: { onClipMenu(c: Clip, x: number, y: number): void };
  },
  overlayCtx: null as unknown as {
    selection: { get(): string | null; set(v: string | null): void };
    playbackUrl?(media: MediaRef): string | null;
    onGestureEnd?(): void;
  },
  inspectorCtx: null as unknown as Record<string, unknown>,
  theaterCtx: null as unknown as Record<string, unknown>,
  gesture: false,
  disposed: [] as string[],
  inspectorRebuilds: 0,
  overlayCancels: 0,
  throwOnTheaterDispose: false,
}));

vi.mock("../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      loadProject: async () => m.loaded,
      probeMedia: (path: string) => m.probe(path),
      saveProject: async () => {
        m.saves++;
      },
    },
    pickMediaFiles: () => m.pick(),
    mediaUrl: (p: string) => p,
    onDragDrop: async (h: { onDrop(paths: string[]): void }) => {
      m.drop = h;
      return () => {
        m.dropUnlisten.calls++;
      };
    },
  };
});
vi.mock("../core/nav", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/nav")>()),
  navigate: () => {},
}));
vi.mock("../core/monitor-volume", () => ({
  createMonitorVolume: () => ({
    get: () => ({ level: 1, muted: false }),
    setLevel: () => {},
    toggleMute: () => {},
    subscribe: () => () => {},
    flush: () => {},
    dispose: () => void m.disposed.push("volume"),
  }),
}));
vi.mock("../core/app-close", () => ({
  registerCloseTask: () => () => {
    m.closeTaskUnreg++;
  },
}));
vi.mock("../core/shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/shortcuts")>()),
  ShortcutManager: class {
    on(action: string, h: () => void): void {
      m.keys.set(action, h);
    }
    setSuppressed(): void {}
    setBindings(): void {}
    attach(): void {
      m.shortcutsAttached++;
    }
    detach(): void {
      m.shortcutsDetached++;
    }
  },
}));
vi.mock("../ui/menu", () => ({
  showMenu: (_x: number, _y: number, items: { label: string; onSelect: () => void }[]) => {
    m.menu = items;
  },
  closeMenu: () => {},
}));
vi.mock("../ui/toast", () => ({
  toast: {
    info: (s: string) => void m.toasts.info.push(s),
    error: (s: string, o?: unknown) => {
      m.toasts.error.push(s);
      m.errorOpts.push(o);
    },
    refuse: (s: string) => void m.toasts.refuse.push(s),
    notice: (s: string, d?: string) => void m.toasts.notice.push([s, d]),
  },
}));
vi.mock("../ui/temp-project", () => ({
  createTempLeaveGate: () => ({}),
  createTempExits: () => ({
    confirm: async () => true,
    confirmLeave: (dest: () => void) => dest(),
    keep: async () => "ignored",
  }),
}));
vi.mock("./export/export-dialog", () => ({ openExportDialog: () => () => {} }));
vi.mock("./media/generators", () => ({ openGeneratorDialog: () => () => {} }));
vi.mock("./media/relink", () => ({ openRelinkDialog: () => () => {} }));
vi.mock("./media/media", async (importOriginal) => {
  const { Store } = await import("../core/store");
  // The real rule, so the dispose tests below exercise what ships.
  const { abandonsPlayback } = await importOriginal<typeof import("./media/media")>();
  return {
    abandonsPlayback,
    MediaManager: class {
      status = new Store<Record<string, unknown>>({});
      thumbs = new Store<Record<string, string>>({});
      waveforms = new Store<Record<string, unknown>>({});
      damage = new Store<Record<string, unknown>>({});
      constructor(_getProject: unknown, opts: unknown) {
        m.media = this as never;
        m.mediaOpts = opts as never;
      }
      async init(): Promise<void> {}
      ensureAll(_project: unknown, missing?: readonly string[]): void {
        m.ensureAllMissing.push(missing);
      }
      untrack(): void {}
      retrack(): void {}
      dispose(opts?: unknown): void {
        m.mediaDispose.push(opts);
      }
    },
  };
});
vi.mock("./playback/audio-graph", () => ({
  AudioGraph: class {
    tick(): void {}
    setMonitorVolume(): void {}
    dispose(): void {
      m.disposed.push("graph");
    }
  },
}));
vi.mock("./playback/scheduler", () => ({
  Scheduler: class {
    activeVideo(): null {
      return null;
    }
  },
}));
vi.mock("./playback/engine", async () => {
  const { timelineDuration } = await import("../core/time");
  return {
    PlaybackEngine: class {
      time = 0;
      playing = false;
      previewSpeed = 1;
      loop = false;
      durationCalls = 0;
      speeds: number[] = [];
      private listeners = new Set<(t: number, playing: boolean) => void>();
      constructor(private getProject: () => ProjectFile) {
        m.engine = this as never;
      }
      fps() {
        return this.getProject().timeline.fps;
      }
      duration(): number {
        this.durationCalls++;
        return timelineDuration(this.getProject().timeline);
      }
      onTick(fn: (t: number, playing: boolean) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      }
      emit(): void {
        for (const l of [...this.listeners]) l(this.time, this.playing);
      }
      seek(t: number): void {
        if (m.throwOnSeek) throw new Error("evalKfs: empty keyframe array");
        this.time = t;
      }
      setPreviewSpeed(s: number): void {
        this.speeds.push(s);
      }
      refresh(): void {
        if (m.throwOnRefresh) throw new Error("engine refresh failed");
      }
      toggle(): void {}
      stop(): void {}
      stepFrames(): void {}
      jumpSeconds(): void {}
      dispose(): void {
        m.disposed.push("engine");
      }
    },
  };
});
vi.mock("./preview/preview", () => ({
  mountStage: () => ({
    canvas: { classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({}) },
    refit() {},
    dispose() {
      m.disposed.push("stage");
    },
  }),
}));
vi.mock("./preview/overlay", () => ({
  mountCanvasOverlay: (ctx: typeof m.overlayCtx) => {
    m.overlayCtx = ctx;
    return {
      gestureActive: () => m.gesture,
      cancelGesture: () => void m.overlayCancels++,
      dispose: () => void m.disposed.push("overlay"),
    };
  },
}));
vi.mock("./preview/theater", () => ({
  mountTheater: (ctx: Record<string, unknown>) => {
    m.theaterCtx = ctx;
    return {
      toggle() {},
      dispose() {
        if (m.throwOnTheaterDispose) throw new Error("theater teardown failed");
        m.disposed.push("theater");
      },
    };
  },
}));
// The handle is checked against the real InspectorHandle, so a renamed method
// is a tsc error here rather than a mock that answers a call the real panel
// never would (the gesture-end seam once called a `rebuild` only this mock had).
vi.mock("./inspector/inspector", () => ({
  mountInspector: (_host: unknown, ctx: Record<string, unknown>) => {
    m.inspectorCtx = ctx;
    return {
      dispose: () => void m.disposed.push("inspector"),
      overlayGestureEnded: () => void m.inspectorRebuilds++,
    } satisfies InspectorHandle;
  },
}));
vi.mock("./timeline/interactions", () => ({
  createLaneAutoScroll: () => ({ aim() {}, stop() {} }),
}));
vi.mock("./timeline/timeline", () => ({
  TimelineController: class {
    renders = 0;
    view = { t0: 0, pxPerSec: 80 };
    constructor(
      _host: unknown,
      readonly deps: unknown,
    ) {
      m.timeline = this as never;
    }
    requestRender(): void {
      this.renders++;
    }
    zoomCentered(): void {}
    clearDropPreview(): void {}
    dispose(): void {
      m.disposed.push("timeline");
    }
  },
}));

import { escapeHtml } from "../core/format";
import { addMedia, createProject, findClip, insertClip, makeClip, removeClip, updateClip } from "../core/project";
import { currentSession, type ProjectSession } from "../core/session";
import { mountEditor } from "./editor";

/* ---------------- a fake DOM, just enough for the shell ---------------- */

interface Ev {
  key?: string;
  stopped: number;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeEl {
  [k: string]: unknown;
  writes = { innerHTML: 0, textContent: 0 };
  blurs = 0;
  value = "";
  title = "";
  hidden = false;
  id = "";
  className = "";
  children: unknown[] = [];
  style: Record<string, string> = {};
  private html = "";
  private text = "";
  private kids = new Map<string, FakeEl>();
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  private cls = new Set<string>();
  classList = {
    add: (...c: string[]) => void c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => void c.forEach((x) => this.cls.delete(x)),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.cls.has(c);
      if (want) this.cls.add(c);
      else this.cls.delete(c);
      return want;
    },
    contains: (c: string) => this.cls.has(c),
  };
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = String(v);
    this.writes.innerHTML++;
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = String(v);
    this.writes.textContent++;
  }
  /** Memoized per selector: the shell looks each element up once, and the
   *  tests look up the same one afterwards. */
  querySelector(sel: string): FakeEl {
    let k = this.kids.get(sel);
    if (!k) {
      k = new FakeEl();
      this.kids.set(sel, k);
    }
    return k;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Run every listener the shell added for `type`, as the browser would. */
  fire(type: string, init: { key?: string } = {}): Ev {
    const ev: Ev = {
      ...init,
      stopped: 0,
      preventDefault() {},
      stopPropagation() {
        ev.stopped++;
      },
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    return ev;
  }
  blur(): void {
    this.blurs++;
  }
  focus(): void {}
  select(): void {}
  after(): void {}
  remove(): void {}
  appendChild<T>(c: T): T {
    return c;
  }
  setAttribute(): void {}
  contains(): boolean {
    return false;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

/* ---------------- fixtures ---------------- */

const FPS30 = { num: 30, den: 1 };

function videoInfo(path: string, over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path,
    size: 10,
    mtimeMs: 20,
    kind: "video",
    duration: 8.4,
    width: 1280,
    height: 720,
    hasAudio: false,
    fps: FPS30,
    ...over,
  };
}

/** One video media with one clip on V1 at 2.5 s (so the timeline ends at
 *  10.9 s), plus a text element in the bin, so the bin has a generator to
 *  name. Ids are fixed so a test can find the clip again. */
function fixture(): { project: ProjectFile; media: MediaRef; clip: Clip } {
  let p = createProject("Shell fixture");
  const added = addMedia(p, videoInfo("D:/clips/harbour.mp4"));
  p = added.project;
  p = addMedia(p, {
    path: "Text — Hi",
    size: 0,
    mtimeMs: 0,
    kind: "image",
    duration: 0,
    width: 300,
    height: 80,
    hasAudio: false,
    generator: { type: "text", text: "Hello harbour" } as never,
  }).project;
  const clip = { ...makeClip(added.media, 2.5), id: "c-a" };
  p = insertClip(p, p.timeline.tracks[0]!.id, clip);
  return { project: p, media: added.media, clip };
}

/* ---------------- harness ---------------- */

let handles: { dispose(): Promise<void> }[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function mount(project?: ProjectFile, missing: string[] = []): Promise<{
  root: FakeEl;
  handle: { dispose(): Promise<void> };
  session: ProjectSession;
}> {
  m.loaded = { project: project ?? fixture().project, missing, recovered: false };
  const root = new FakeEl();
  const handle = await mountEditor(
    root as unknown as HTMLElement,
    { view: "editor", projectPath: "C:/p/shell.trt" },
    () => false,
  );
  handles.push(handle);
  await flush();
  return { root, handle, session: currentSession.get()! };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Open the clip menu the timeline would open on `clipId`, then pick
 *  Replace media from it. */
function replaceMediaOn(session: ProjectSession, clipId: string): void {
  m.timeline.deps.onClipMenu(findClip(session.project, clipId)!.clip, 10, 10);
  m.menu.find((i) => i.label === "Replace media")!.onSelect();
}

beforeEach(() => {
  m.saves = 0;
  m.drop = null;
  m.dropUnlisten.calls = 0;
  m.keys.clear();
  m.shortcutsAttached = 0;
  m.shortcutsDetached = 0;
  m.closeTaskUnreg = 0;
  m.menu = [];
  m.toasts = { info: [], error: [], refuse: [], notice: [] };
  m.errorOpts = [];
  m.throwOnSeek = false;
  m.throwOnRefresh = false;
  m.throwOnTheaterDispose = false;
  m.mediaDispose = [];
  m.ensureAllMissing = [];
  m.gesture = false;
  m.disposed = [];
  m.inspectorRebuilds = 0;
  m.overlayCancels = 0;
  m.probe = async (path) => videoInfo(path);
  m.pick = async () => [];
  vi.stubGlobal("HTMLElement", FakeEl);
  vi.stubGlobal("document", {
    createElement: () => new FakeEl(),
    querySelector: () => null,
    activeElement: null,
    body: new FakeEl(),
    documentElement: new FakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // Timers are looked up at call time, so the session's autosave timers land
  // on node's.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t?: ReturnType<typeof setTimeout>) => clearTimeout(t),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (t?: ReturnType<typeof setInterval>) => clearInterval(t),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(async () => {
  for (const h of handles) await h.dispose();
  handles = [];
  currentSession.set(null);
  vi.unstubAllGlobals();
});

/* ---------------- tests ---------------- */

describe("selection repaints the timeline", () => {
  it("a selection made or cleared on the preview canvas repaints the timeline's outline", async () => {
    const fx = fixture();
    const { clip } = fx;
    await mount(fx.project);
    m.timeline.renders = 0;
    m.overlayCtx.selection.set(clip.id);
    await flush();
    expect(m.timeline.renders).toBeGreaterThan(0);
    m.timeline.renders = 0;
    m.overlayCtx.selection.set(null); // Escape on the canvas
    await flush();
    expect(m.timeline.renders).toBeGreaterThan(0);
  });
});

describe("the media bin rebuilds only when the media change", () => {
  it("clip-only edits (a canvas drag's replace per move) leave the bin's rows alone", async () => {
    const fx = fixture();
    const { clip } = fx;
    const { root, session } = await mount(fx.project);
    const list = root.querySelector("#media-list");
    const before = list.writes.innerHTML;
    for (const x of [12, 31, 57]) {
      session.replace(
        updateClip(session.project, clip.id, (c) => ({ ...c, transform: { ...c.transform!, x } })),
      );
      await flush();
    }
    expect(list.writes.innerHTML).toBe(before);
  });

  it("an import rebuilds it once", async () => {
    const { root, session } = await mount();
    const list = root.querySelector("#media-list");
    const before = list.writes.innerHTML;
    session.commit((p) => addMedia(p, videoInfo("D:/clips/pier.mov")).project);
    await flush();
    expect(list.writes.innerHTML).toBe(before + 1);
    expect(list.innerHTML).toContain("pier");
  });

  it("names a text element the way the timeline and the inspector do", async () => {
    const { root } = await mount();
    expect(root.querySelector("#media-list").innerHTML).toContain("Text — Hello harbour");
  });
});

/**
 * A damaged video in the bin, and the toast that first says so. The manager
 * is a recorder here, so the test publishes its status and damage records the
 * way the real one does. The fixture's video is row 0 of the bin, its text
 * element row 1; rows are handed to the bin as fakes so the in-place paints
 * can be read back.
 */
describe("a damaged video in the bin", () => {
  const QUICK = "asset://cache/harbour.quick.mp4";
  const repairing = (ratio: number | null) => ({ until: 60.6, phase: "repairing", ratio });

  async function bin() {
    const fx = fixture();
    const { root } = await mount(fx.project);
    const list = root.querySelector("#media-list");
    const rows = [new FakeEl(), new FakeEl()];
    list.children = rows;
    return { fx, list, row: rows[0]! };
  }

  it("says Damaged, amber, with what can't be read and how the repair stands", async () => {
    const { fx, list } = await bin();
    m.media.status.set({ [fx.media.id]: { state: "ready", url: QUICK, sourcePath: QUICK } });
    m.media.damage.set({ [fx.media.id]: repairing(0.4) });
    await flush();
    expect(list.innerHTML).toContain(
      `<span class="media-row__status media-row__status--warn" title="${escapeHtml("0:00-1:00 couldn't be read · repairing 40%")}">Damaged</span>`,
    );
    expect(list.innerHTML).toContain(`<div class="media-row__bar">`);
    expect(list.innerHTML).not.toContain(">Ready<");
  });

  it("feeds the repair's progress to the bar and tooltip in place, rebuilding no row", async () => {
    const { fx, list, row } = await bin();
    m.media.status.set({ [fx.media.id]: { state: "ready", url: QUICK, sourcePath: QUICK } });
    m.media.damage.set({ [fx.media.id]: repairing(0.4) });
    await flush();
    const rebuilt = list.writes.innerHTML;
    m.media.damage.set({ [fx.media.id]: repairing(0.65) });
    await flush();
    expect(list.writes.innerHTML).toBe(rebuilt);
    expect(row.querySelector(".media-row__bar > div").style.width).toBe("65%");
    expect(row.querySelector(".media-row__status--warn").title).toBe("0:00-1:00 couldn't be read · repairing 65%");
  });

  it("keeps saying Damaged while the media waits on its repair, whatever the status ratio does", async () => {
    // The instant copy failed in the element: the status is Preparing on the
    // repair's job, and its ratio ticks too. The Preparing repaint must not
    // write "Preparing 50%" over the Damaged label.
    const { fx, row } = await bin();
    m.media.status.set({ [fx.media.id]: { state: "preparing", ratio: 0.3, jobId: 412 } });
    m.media.damage.set({ [fx.media.id]: repairing(0.3) });
    await flush();
    m.media.status.set({ [fx.media.id]: { state: "preparing", ratio: 0.5, jobId: 412 } });
    await flush();
    expect(row.querySelector(".media-row__status").writes.textContent).toBe(0);
  });

  it("drops the bar once the repair has landed", async () => {
    const { fx, list } = await bin();
    m.media.status.set({ [fx.media.id]: { state: "ready", url: QUICK, sourcePath: QUICK } });
    m.media.damage.set({ [fx.media.id]: { until: 60.6, phase: "recovered", ratio: null } });
    await flush();
    expect(list.innerHTML).toContain(`title="${escapeHtml("0:00-1:00 couldn't be read · recovered")}">Damaged</span>`);
    expect(list.innerHTML).not.toContain(`<div class="media-row__bar">`);
  });

  it("lets Failed win: its message is the more useful fact", async () => {
    const { fx, list } = await bin();
    m.media.status.set({ [fx.media.id]: { state: "failed", message: "This file couldn't be played" } });
    m.media.damage.set({ [fx.media.id]: repairing(0.4) });
    await flush();
    expect(list.innerHTML).toContain(">Failed<");
    expect(list.innerHTML).not.toContain(">Damaged<");
  });

  it("raises one notice, not an error, whose second line says what can't be read", async () => {
    const fx = fixture();
    await mount(fx.project);
    m.mediaOpts.onDamaged(fx.media.id, repairing(null), true);
    expect(m.toasts.notice).toEqual([
      [
        "This video is damaged",
        "0:00-1:00 can't be read. The rest plays now; Taroting repairs the damaged part in the background.",
      ],
    ]);
    expect(m.toasts.error).toEqual([]);
  });

  it("raises nothing when the recovered copy was already there: a reopen is not news", async () => {
    const fx = fixture();
    await mount(fx.project);
    m.mediaOpts.onDamaged(fx.media.id, { until: 60.6, phase: "recovered", ratio: null }, false);
    expect(m.toasts.notice).toEqual([]);
    expect(m.toasts.error).toEqual([]);
  });

  it("raises nothing for a media that has left the project", async () => {
    await mount();
    m.mediaOpts.onDamaged("m-gone", repairing(null), true);
    expect(m.toasts.notice).toEqual([]);
    expect(m.toasts.error).toEqual([]);
  });
});

describe("the transport readout", () => {
  it("is rewritten only when the frame moves, and walks the duration once per timeline", async () => {
    const { root } = await mount();
    const el = root.querySelector("#tr-time");
    const writes = el.writes.textContent;
    const walks = m.engine.durationCalls;
    m.engine.time = 1.0; // frame 30
    m.engine.emit();
    expect(el.writes.textContent).toBe(writes + 1);
    expect(el.textContent).toBe("00:01:00 / 00:10:27");
    // three more ticks inside the same frame (30 fps: 1.0 up to 1.0333)
    for (const t of [1.004, 1.017, 1.031]) {
      m.engine.time = t;
      m.engine.emit();
    }
    expect(el.writes.textContent).toBe(writes + 1);
    m.engine.time = 1.04; // frame 31
    m.engine.emit();
    expect(el.writes.textContent).toBe(writes + 2);
    expect(el.textContent).toBe("00:01:01 / 00:10:27");
    expect(m.engine.durationCalls).toBe(walks);
  });

  it("follows a duration change made by an edit", async () => {
    const fx = fixture();
    const { clip } = fx;
    const { root, session } = await mount(fx.project);
    const el = root.querySelector("#tr-time");
    session.commit((p) => updateClip(p, clip.id, (c) => ({ ...c, srcOut: 4 })));
    await flush();
    expect(el.textContent).toBe("00:00:00 / 00:06:15");
  });
});

describe("the preview speed menu gives focus back after a mouse pick", () => {
  it("blurs on a pointer pick, keeps focus while the keyboard steps through it", async () => {
    const { root } = await mount();
    const sel = root.querySelector("#tr-speed");
    sel.value = "2";
    sel.fire("pointerdown");
    sel.fire("change");
    expect(m.engine.speeds).toEqual([2]);
    expect(sel.blurs).toBe(1);
    sel.fire("keydown", { key: "ArrowDown" });
    sel.value = "1.5";
    sel.fire("change");
    expect(m.engine.speeds).toEqual([2, 1.5]);
    expect(sel.blurs).toBe(1);
    sel.fire("pointerdown");
    sel.value = "0.5";
    sel.fire("change");
    expect(sel.blurs).toBe(2);
  });
});

describe("Space on the project name", () => {
  it("starts the rename without reaching the window's shortcuts", async () => {
    const { root } = await mount();
    const ev = root.querySelector("#ed-name").fire("keydown", { key: " " });
    expect(ev.stopped).toBe(1);
  });
});

describe("paste selects what it pasted", () => {
  it("the pasted clip becomes the selection, so Delete removes it and not the original", async () => {
    const fx = fixture();
    const { clip } = fx;
    const { session } = await mount(fx.project);
    m.overlayCtx.selection.set(clip.id);
    m.keys.get("copy")!();
    m.engine.time = 40.2;
    m.keys.get("paste")!();
    const sel = m.overlayCtx.selection.get();
    expect(sel).not.toBe(clip.id);
    const pasted = findClip(session.project, sel!);
    expect(pasted?.clip.timelineStart).toBe(40.2);
    expect(pasted?.clip.mediaId).toBe(clip.mediaId);
    m.keys.get("delete")!();
    expect(findClip(session.project, clip.id)).toBeDefined();
    expect(findClip(session.project, sel!)).toBeUndefined();
  });
});

describe("imports that outlive the editor", () => {
  it("a pick that answers after the editor closed is refused, never committed", async () => {
    const pick = deferred<string[]>();
    m.pick = () => pick.promise;
    let probes = 0;
    m.probe = async (p) => (probes++, videoInfo(p));
    const { root, handle, session } = await mount();
    const mediaBefore = session.project.media;
    root.querySelector("#ed-import").fire("click");
    await handle.dispose();
    pick.resolve(["D:/clips/clip.mp4"]);
    await flush();
    expect(probes).toBe(0);
    expect(session.project.media).toBe(mediaBefore);
    expect(m.toasts.refuse).toEqual(["clip.mp4 wasn't imported because the project was closed."]);
  });

  it("a probe in flight when the editor closes commits nothing, and names what was left", async () => {
    const probe = deferred<MediaInfo>();
    const probed: string[] = [];
    m.pick = async () => ["D:/clips/a.mp4", "D:/clips/b.mov"];
    m.probe = (p) => (probed.push(p), probe.promise);
    const { root, handle, session } = await mount();
    const mediaBefore = session.project.media;
    root.querySelector("#ed-import").fire("click");
    await flush();
    expect(probed).toEqual(["D:/clips/a.mp4"]);
    const saves = m.saves;
    await handle.dispose();
    probe.resolve(videoInfo("D:/clips/a.mp4"));
    await flush();
    expect(probed).toEqual(["D:/clips/a.mp4"]);
    expect(session.project.media).toBe(mediaBefore);
    expect(m.saves).toBe(saves);
    expect(m.toasts.refuse).toEqual(["2 files weren't imported because the project was closed."]);
    expect(m.toasts.error).toEqual([]);
  });

  it("a probe that fails after the close is the same refusal, not a 'Couldn't import' over the next screen", async () => {
    const probe = deferred<MediaInfo>();
    m.probe = () => probe.promise;
    const { handle } = await mount();
    m.drop!.onDrop(["D:/clips/dropped.mkv"]);
    await flush();
    await handle.dispose();
    probe.reject(new Error("ffprobe gave up"));
    await flush();
    expect(m.toasts.error).toEqual([]);
    expect(m.toasts.refuse).toEqual(["dropped.mkv wasn't imported because the project was closed."]);
  });

  it("an open editor still imports, and a picker failure is reported instead of left unhandled", async () => {
    m.pick = async () => ["D:/clips/pier.mov"];
    const { root, session } = await mount();
    const n = session.project.media.length;
    root.querySelector("#ed-import").fire("click");
    await flush();
    expect(session.project.media.length).toBe(n + 1);
    m.pick = async () => {
      throw new Error("dialog plugin failed");
    };
    root.querySelector("#ed-import").fire("click");
    await flush();
    expect(m.toasts.error).toEqual(["dialog plugin failed"]);
  });

  it("a dropped file whose commit throws is a 'Couldn't import' toast, not an unhandled rejection", async () => {
    // The commit runs the engine refresh synchronously; a throw there used to
    // escape importPaths, and the drop path's `void` left it unhandled.
    const { session } = await mount();
    const n = session.project.media.length;
    m.throwOnRefresh = true;
    m.drop!.onDrop(["D:/clips/quay.mkv", "D:/clips/pier.mov"]);
    await flush();
    expect(m.toasts.error).toEqual([
      "Couldn't import quay: engine refresh failed",
      "Couldn't import pier: engine refresh failed",
    ]);
    expect(m.toasts.refuse).toEqual([]);
    // The session took both before the refresh threw: the loop went on to the
    // second file instead of stopping at the first throw.
    expect(session.project.media.length).toBe(n + 2);
  });

  it("an unsupported drop is a refusal, not a recorded error", async () => {
    await mount();
    m.drop!.onDrop(["D:/docs/notes.txt"]);
    await flush();
    expect(m.toasts.refuse).toEqual(["Unsupported file type."]);
    expect(m.toasts.error).toEqual([]);
  });

  it("Replace media whose pick answers after the close is refused, never probed", async () => {
    const fx = fixture();
    const { clip } = fx;
    const pick = deferred<string[]>();
    m.pick = () => pick.promise;
    let probes = 0;
    m.probe = async (p) => (probes++, videoInfo(p));
    const { handle, session } = await mount(fx.project);
    replaceMediaOn(session, clip.id);
    await handle.dispose();
    pick.resolve(["D:/clips/other.mp4"]);
    await flush();
    expect(probes).toBe(0);
    expect(findClip(session.project, clip.id)!.clip.mediaId).toBe(clip.mediaId);
    expect(m.toasts.refuse).toEqual(["other.mp4 wasn't imported because the project was closed."]);
  });

  it("Replace media whose probe answers after the close commits nothing", async () => {
    const fx = fixture();
    const { clip } = fx;
    const probe = deferred<MediaInfo>();
    m.pick = async () => ["D:/clips/other.mp4"];
    m.probe = () => probe.promise;
    const { handle, session } = await mount(fx.project);
    const mediaBefore = session.project.media;
    replaceMediaOn(session, clip.id);
    await flush();
    await handle.dispose();
    probe.resolve(videoInfo("D:/clips/other.mp4"));
    await flush();
    expect(session.project.media).toBe(mediaBefore);
    expect(m.toasts.refuse).toEqual(["other.mp4 wasn't imported because the project was closed."]);
  });

  it("Replace media on a clip deleted while its file was read adds nothing to the bin", async () => {
    const fx = fixture();
    const { clip } = fx;
    const probe = deferred<MediaInfo>();
    m.pick = async () => ["D:/clips/other.mp4"];
    m.probe = () => probe.promise;
    const { session } = await mount(fx.project);
    replaceMediaOn(session, clip.id);
    await flush();
    session.commit((p) => removeClip(p, clip.id));
    const mediaBefore = session.project.media;
    probe.resolve(videoInfo("D:/clips/other.mp4"));
    await flush();
    expect(findClip(session.project, clip.id)).toBeUndefined();
    expect(session.project.media).toBe(mediaBefore);
    expect(m.toasts.error).toEqual([]);
    expect(m.toasts.refuse).toEqual([]);
  });

  it("Replace media refuses a file with no length rather than making an empty clip", async () => {
    const fx = fixture();
    const { clip } = fx;
    m.pick = async () => ["D:/clips/broken.mp4"];
    m.probe = async (p) => videoInfo(p, { duration: 0 });
    const { session } = await mount(fx.project);
    const mediaBefore = session.project.media;
    replaceMediaOn(session, clip.id);
    await flush();
    expect(findClip(session.project, clip.id)!.clip.mediaId).toBe(clip.mediaId);
    expect(session.project.media).toBe(mediaBefore);
    expect(m.toasts.refuse).toEqual(["broken.mp4 has no length, so it can't replace this clip."]);
  });

  it("Replace media refuses a sound file on a video layer with a refusal, not a recorded error", async () => {
    const fx = fixture();
    const { clip } = fx;
    m.pick = async () => ["D:/clips/song.wav"];
    m.probe = async (p) => videoInfo(p, { kind: "audio", width: undefined, height: undefined });
    const { session } = await mount(fx.project);
    replaceMediaOn(session, clip.id);
    await flush();
    expect(m.toasts.refuse).toEqual(["Choose a video or picture for a video layer."]);
    expect(m.toasts.error).toEqual([]);
  });

  it("Replace media retargets through retargetClip: the keyframes follow the trim", async () => {
    const { clip, project } = fixture();
    const trimmed = updateClip(project, clip.id, (c) => ({
      ...c,
      srcIn: 1.25,
      keyframes: {
        opacity: [
          { t: 2.5, v: 0.4 },
          { t: 5.75, v: 1 },
        ],
      },
    }));
    m.pick = async () => ["D:/clips/other.mp4"];
    m.probe = async (p) => videoInfo(p, { duration: 30 });
    const { session } = await mount(trimmed);
    replaceMediaOn(session, clip.id);
    await flush();
    const now = findClip(session.project, clip.id)!.clip;
    expect(now.mediaId).not.toBe(clip.mediaId);
    expect(now.srcIn).toBe(0);
    expect(now.keyframes!.opacity!.map((k) => k.t)).toEqual([1.25, 4.5]);
  });
});

describe("a mount that throws halfway", () => {
  it("tears down everything it built, unpublishes the session, and rethrows", async () => {
    m.throwOnSeek = true;
    m.loaded = { project: fixture().project, missing: [], recovered: false };
    await expect(
      mountEditor(
        new FakeEl() as unknown as HTMLElement,
        { view: "editor", projectPath: "C:/p/shell.trt" },
        () => false,
      ),
    ).rejects.toThrow("evalKfs: empty keyframe array");
    expect(currentSession.get()).toBeNull();
    // The shortcuts were attached before the first-frame seek threw.
    expect(m.shortcutsAttached).toBe(1);
    expect(m.shortcutsDetached).toBe(1);
    expect(m.closeTaskUnreg).toBe(1);
    expect(m.mediaDispose.length).toBe(1);
    expect([...m.disposed].sort()).toEqual(
      ["engine", "graph", "inspector", "overlay", "stage", "theater", "timeline", "volume"].sort(),
    );
    // The drop registration that resolves after the throw is released at once.
    await flush();
    expect(m.dropUnlisten.calls).toBe(1);
    // And the session no longer autosaves.
    const session = m.inspectorCtx.session as ProjectSession;
    session.commit((p) => ({ ...p, name: "late edit" }));
    await session.save();
    expect(m.saves).toBe(0);
  });
});

describe("dispose and the shared teardown", () => {
  it("abandons playback jobs only for a discarded project", async () => {
    const kept = await mount();
    await kept.handle.dispose();
    expect(m.mediaDispose).toEqual([{ abandonPlayback: false }]);

    m.mediaDispose = [];
    const thrown = await mount();
    thrown.session.discard();
    await thrown.handle.dispose();
    expect(m.mediaDispose).toEqual([{ abandonPlayback: true }]);
  });

  it("leaves them to the viewer when a discarded project goes back to it", async () => {
    // Viewer → Edit → Back without an edit: the temporary project is discarded
    // without a question, and the viewer shows the same file again on the job
    // it handed over. It cannot claim an abandoned job, so abandoning it here
    // restarted the transcode from 0% on every Edit → Back round trip.
    m.loaded = { project: fixture().project, missing: [], recovered: false };
    const handle = await mountEditor(
      new FakeEl() as unknown as HTMLElement,
      { view: "editor", projectPath: "C:/p/shell.trt", temp: true, returnTo: "D:\\clips\\hevc.mov" },
      () => false,
    );
    handles.push(handle);
    await flush();
    currentSession.get()!.discard();
    await handle.dispose();
    expect(m.mediaDispose).toEqual([{ abandonPlayback: false }]);
  });

  it("takes every piece down once, newest first, and releases the session", async () => {
    const { handle } = await mount();
    await handle.dispose();
    expect(m.disposed).toEqual(["theater", "overlay", "inspector", "timeline", "volume", "engine", "graph", "stage"]);
    expect(m.shortcutsDetached).toBe(1);
    expect(m.closeTaskUnreg).toBe(1);
    expect(m.dropUnlisten.calls).toBe(1);
    expect(currentSession.get()).toBeNull();
    await handle.dispose();
    expect(m.disposed.length).toBe(8);
  });

  it("a piece that throws while coming down does not cost the final save", async () => {
    m.throwOnTheaterDispose = true;
    const { handle, session } = await mount();
    session.commit((p) => ({ ...p, name: "edited just before leaving" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await handle.dispose();
    errors.mockRestore();
    expect(m.saves).toBe(1);
    expect(m.disposed).toContain("stage");
  });
});

describe("the overlay gesture seams", () => {
  it("the inspector reads the overlay's live gesture, and rebuilds when it ends", async () => {
    await mount();
    const active = m.inspectorCtx.overlayGestureActive as () => boolean;
    expect(active()).toBe(false);
    m.gesture = true;
    expect(active()).toBe(true);
    m.overlayCtx.onGestureEnd!();
    expect(m.inspectorRebuilds).toBe(1);
  });

  it("entering theater can drop a canvas drag in flight", async () => {
    await mount();
    (m.theaterCtx.cancelGesture as () => void)();
    expect(m.overlayCancels).toBe(1);
  });

  it("the crop ghost decodes the URL the stage plays, and nothing while no plan is ready", async () => {
    const fx = fixture();
    await mount(fx.project);
    const text = fx.project.media.find((x) => x.id !== fx.media.id)!;
    // The proxy URL differs from the media path on purpose: mediaUrl is the
    // identity in this file, so an accessor that fell back to the original
    // would otherwise pass.
    m.media.status.set({
      [fx.media.id]: { state: "ready", url: "asset://cache/harbour.proxy.mp4" },
      [text.id]: { state: "preparing" },
    });
    expect(m.overlayCtx.playbackUrl!(fx.media)).toBe("asset://cache/harbour.proxy.mp4");
    expect(m.overlayCtx.playbackUrl!(text)).toBeNull();
    m.media.status.set({});
    expect(m.overlayCtx.playbackUrl!(fx.media)).toBeNull();
  });
});

describe("media the load reported missing", () => {
  it("go to the first ensureAll only; a later re-ensure passes none", async () => {
    // An id that is neither the video's nor the text's, so the call could not
    // be confused with one built from the project's own media.
    await mount(undefined, ["m-gone-from-disk"]);
    expect(m.ensureAllMissing).toEqual([["m-gone-from-disk"]]);
    m.drop!.onDrop(["D:/clips/pier.mov"]);
    await flush();
    expect(m.ensureAllMissing).toEqual([["m-gone-from-disk"], undefined]);
  });
});
