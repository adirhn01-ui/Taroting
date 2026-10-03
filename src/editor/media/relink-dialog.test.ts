// The relink dialog driven through the real openRelinkDialog against a fake
// DOM (vite.config pins `environment: "node"`): the row a Locate resolves, the
// retrack it asks for, and picks that answer after the dialog has closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, ProjectFile } from "../../core/types";

const m = vi.hoisted(() => ({
  open: null as unknown as () => Promise<string | null>,
  probe: null as unknown as (path: string) => Promise<MediaInfo>,
  refuse: [] as string[],
  error: [] as string[],
}));

vi.mock("../../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/ipc")>();
  return { ...real, inTauri: true, ipc: { ...real.ipc, probeMedia: (p: string) => m.probe(p) } };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => m.open() }));
vi.mock("../../ui/focus", () => ({ trapTab: () => () => {}, focusFirst: () => {} }));
vi.mock("../../ui/toast", () => ({
  toast: {
    info: () => {},
    error: (s: string) => void m.error.push(s),
    refuse: (s: string) => void m.refuse.push(s),
  },
}));

import { addMedia, createProject, insertClip, makeClip } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import { openRelinkDialog } from "./relink";

/* ---------------- a fake DOM ---------------- */

class FakeEl {
  innerHTML = "";
  textContent = "";
  title = "";
  disabled = false;
  dataset: Record<string, string> = {};
  cls = new Set<string>();
  protected kids = new Map<string, FakeEl>();
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  set className(v: string) {
    this.cls = new Set(v.split(" ").filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(" ");
  }
  classList = {
    add: (c: string) => void this.cls.add(c),
    remove: (c: string) => void this.cls.delete(c),
  };
  querySelector(sel: string): FakeEl | null {
    let k = this.kids.get(sel);
    if (!k) {
      k = new FakeEl();
      this.kids.set(sel, k);
    }
    return k;
  }
  seed(sel: string, el: FakeEl): void {
    this.kids.set(sel, el);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ target: null, preventDefault() {}, stopPropagation() {} });
    }
  }
  appendChild<T>(c: T): T {
    return c;
  }
  remove(): void {}
}

/** The relink list. Its attribute-selector lookup behaves as the browser's
 *  does: `[data-row="…"]` built from an id holding a quote is not a valid
 *  selector, and querySelector THROWS a SyntaxError for it. */
class ListEl extends FakeEl {
  rows: FakeEl[] = [];
  override appendChild<T>(c: T): T {
    this.rows.push(c as unknown as FakeEl);
    return c;
  }
  override querySelector(sel: string): FakeEl | null {
    const attr = /^\[data-row="(.*)"\]$/.exec(sel);
    if (!attr) return super.querySelector(sel);
    if (attr[1]!.includes('"')) throw new SyntaxError(`'${sel}' is not a valid selector.`);
    return this.rows.find((r) => r.dataset.row === attr[1]) ?? null;
  }
}

let backdrop: FakeEl;
let list: ListEl;
/** Every element the dialog created after its backdrop, in order. */
let created: FakeEl[] = [];

beforeEach(() => {
  m.refuse = [];
  m.error = [];
  backdrop = new FakeEl();
  list = new ListEl();
  backdrop.seed("#rl-list", list);
  let made = 0;
  created = [];
  vi.stubGlobal("document", {
    // The dialog's first element is its backdrop; every later one is a row.
    createElement: () => {
      if (made++ === 0) return backdrop;
      const el = new FakeEl();
      created.push(el);
      return el;
    },
    body: new FakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- fixtures ---------------- */

function info(path: string, over: Partial<MediaInfo> = {}): MediaInfo {
  return { path, size: 3, mtimeMs: 4, kind: "video", duration: 6.5, width: 640, height: 360, hasAudio: false, ...over };
}

/** A project whose one media (id `mediaId`) is missing, with a clip on it, and
 *  a session that records what it was asked to commit. */
function open(mediaId: string): {
  session: ProjectSession;
  commits: () => number;
  retracks: unknown[][];
  close: () => void;
  row: FakeEl;
} {
  let p: ProjectFile = createProject("Relink fixture");
  const added = addMedia(p, info("E:/old/harbour.mp4"));
  p = {
    ...added.project,
    media: added.project.media.map((x) => (x.id === added.media.id ? { ...x, id: mediaId } : x)),
  };
  p = insertClip(p, p.timeline.tracks[0]!.id, makeClip({ ...added.media, id: mediaId }, 1.5));
  let commits = 0;
  const session = {
    get project() {
      return p;
    },
    commit(fn: (q: ProjectFile) => ProjectFile) {
      commits++;
      p = fn(p);
    },
  } as unknown as ProjectSession;
  const retracks: unknown[][] = [];
  const close = openRelinkDialog({
    session,
    media: { retrack: (...a: unknown[]) => void retracks.push(a) } as never,
    missing: [mediaId],
  });
  return { session, commits: () => commits, retracks, close, row: list.rows[0]! };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/* ---------------- tests ---------------- */

describe("relink: the located row and the retrack", () => {
  it("marks the row it located as relinked, even for an id no selector can hold", async () => {
    const id = 'clip"]1';
    m.open = async () => "F:/new/harbour.mp4";
    m.probe = async (p) => info(p);
    const d = open(id);
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(d.commits()).toBe(1);
    expect(d.row.cls.has("relink-row--resolved")).toBe(true);
    expect(d.row.querySelector(".relink-row__status")!.textContent).toBe("Relinked");
    expect(d.row.title).toBe("F:/new/harbour.mp4");
  });

  it("retracks as a CHANGED file, so the old file's waveform and thumbnail go", async () => {
    m.open = async () => "F:/new/harbour.mp4";
    m.probe = async (p) => info(p);
    const d = open("m-7");
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(d.retracks).toEqual([["m-7", true]]);
  });
});

describe("relink: picks that answer after the dialog closed", () => {
  it("closed by the screen while the picker was up: nothing applied, and the user is told", async () => {
    const pick = deferred<string | null>();
    m.open = () => pick.promise;
    let probes = 0;
    m.probe = async (p) => (probes++, info(p));
    const d = open("m-7");
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    d.close(); // the editor's quiet closer: an Explorer open replaced it
    pick.resolve("F:/new/clip.mp4");
    await flush();
    expect(probes).toBe(0);
    expect(d.commits()).toBe(0);
    expect(d.retracks).toEqual([]);
    expect(m.refuse).toEqual(["clip.mp4 wasn't relinked because the project was closed."]);
  });

  it("closed by the screen while the probe ran: nothing applied, and the user is told", async () => {
    const probe = deferred<MediaInfo>();
    m.open = async () => "F:/new/clip.mp4";
    m.probe = () => probe.promise;
    const d = open("m-7");
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    d.close();
    probe.resolve(info("F:/new/clip.mp4"));
    await flush();
    expect(d.commits()).toBe(0);
    expect(d.retracks).toEqual([]);
    expect(m.refuse).toEqual(["clip.mp4 wasn't relinked because the project was closed."]);
  });

  it("closed by the user: nothing applied, and no word about a closed project", async () => {
    const pick = deferred<string | null>();
    m.open = () => pick.promise;
    m.probe = async (p) => info(p);
    const d = open("m-7");
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    backdrop.querySelector("[data-close-btn]")!.fire("click");
    pick.resolve("F:/new/clip.mp4");
    await flush();
    expect(d.commits()).toBe(0);
    expect(m.refuse).toEqual([]);
    expect(m.error).toEqual(["1 media file(s) still missing on disk."]);
  });

  it("a stale Use anyway left over from before the close applies nothing", async () => {
    m.open = async () => "F:/new/clip.mp4";
    // A different length raises the inline warning instead of applying.
    m.probe = async (p) => info(p, { duration: 2.25 });
    const d = open("m-7");
    d.row.querySelector("[data-locate]")!.fire("click");
    await flush();
    const warn = created.find((el) => el.className === "relink-row__warn")!;
    expect(warn).toBeDefined();
    d.close();
    warn.querySelector("[data-use]")!.fire("click");
    await flush();
    expect(d.commits()).toBe(0);
    expect(d.retracks).toEqual([]);
  });
});
