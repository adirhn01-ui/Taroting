// A missing picture relinked through the app's real relink dialog (driven
// against a fake DOM, as src/editor/media/relink-dialog.test.ts does): the
// PDF editor's own way of applying the located file, the missing set it
// clears, and the open-time and window-focus checks of the picture files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, MediaRef, PdfAnnot, ProjectFile } from "../../core/types";

const m = vi.hoisted(() => ({
  open: null as unknown as () => Promise<string | null>,
  probe: null as unknown as (path: string) => Promise<MediaInfo>,
  /** what Locate asked of each picker */
  imagePicks: 0,
  dialogOpts: [] as unknown[],
}));

vi.mock("../../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/ipc")>();
  return {
    ...real,
    inTauri: true,
    ipc: { ...real.ipc, probeMedia: (p: string) => m.probe(p) },
    pickImageFile: () => {
      m.imagePicks++;
      return m.open();
    },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (o: unknown) => {
    m.dialogOpts.push(o);
    return m.open();
  },
}));
vi.mock("../../ui/focus", () => ({ trapTab: () => () => {}, focusFirst: () => {} }));
vi.mock("../../ui/toast", () => ({ toast: { info: () => {}, error: () => {}, refuse: () => {} } }));

import { createPdfProject } from "../../core/pdf-project";
import { Store } from "../../core/store";
import type { ProjectSession } from "../../core/session";
import { insertPicturePages, mediaFileKey, nextMissingSet, pageAnnots, usedPictureFiles } from "../model";
import { openPictureRelink, relinkPicture } from "./picture-relink";
import { notePicturesFound, recheckPictures, whenNoModal } from "./missing-pictures";

/* ---------------- a fake DOM ---------------- */

class FakeEl {
  innerHTML = "";
  textContent = "";
  title = "";
  disabled = false;
  dataset: Record<string, string> = {};
  className = "";
  classList = { add: () => {}, remove: () => {} };
  private kids = new Map<string, FakeEl>();
  private listeners = new Map<string, ((e: unknown) => void)[]>();
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
    for (const fn of this.listeners.get(type) ?? []) fn({ target: null, preventDefault() {}, stopPropagation() {} });
  }
  appendChild<T>(c: T): T {
    return c;
  }
  remove(): void {}
}
class ListEl extends FakeEl {
  rows: FakeEl[] = [];
  override appendChild<T>(c: T): T {
    this.rows.push(c as unknown as FakeEl);
    return c;
  }
  override querySelector(sel: string): FakeEl | null {
    const attr = /^\[data-row="(.*)"\]$/.exec(sel);
    if (!attr) return super.querySelector(sel);
    return this.rows.find((r) => r.dataset.row === attr[1]) ?? null;
  }
}

let list: ListEl;
beforeEach(() => {
  const backdrop = new FakeEl();
  list = new ListEl();
  backdrop.seed("#rl-list", list);
  m.imagePicks = 0;
  m.dialogOpts = [];
  let made = 0;
  vi.stubGlobal("document", {
    createElement: () => (made++ === 0 ? backdrop : new FakeEl()),
    body: new FakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- fixtures ---------------- */

const still = (path: string, w: number, h: number, size = 4321, mtimeMs = 1_700_000_000_123): MediaInfo => ({
  path,
  size,
  mtimeMs,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
});
const SCAN = still("E:\\scans\\land.jpg", 800, 600);

/** A source page P1, a picture page (page i2, picture i3, media i1) of the
 *  800×600 scan, and an ordinary picture mark on P1 of the same file under a
 *  second MediaRef ("twin"). */
function doc(): ProjectFile {
  let n = 0;
  const base = createPdfProject("Doc", { path: "C:\\a.pdf", size: 10, mtimeMs: 20, pages: 1 }, { id: () => ["src", "P1", "proj", "trk"][n++]! });
  let k = 0;
  const p = insertPicturePages(base, 1, [SCAN], "picture", () => `i${++k}`);
  const twin: MediaRef = { ...p.media.find((x) => x.id === "i1")!, id: "twin" };
  const annots = Object.create(null) as Record<string, PdfAnnot[]>;
  for (const key of Object.keys(p.pdf!.annots)) annots[key] = p.pdf!.annots[key]!;
  annots.P1 = [{ id: "mk", t: "image", x: 30, y: 45, w: 120, h: 70, media: "twin" }];
  return { ...p, media: [...p.media, twin], pdf: { ...p.pdf!, annots } };
}

function sessionOf(start: ProjectFile): { session: ProjectSession; commits: () => number } {
  let p = start;
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
  return { session, commits: () => commits };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const picBox = (p: ProjectFile): number[] => {
  const a = pageAnnots(p, "i2").find((x) => x.id === "i3") as Extract<PdfAnnot, { t: "image" }>;
  return [a.x, a.y, a.w, a.h];
};

/* ---------------- the dialog ---------------- */

describe("relinking a picture through the dialog", () => {
  it("applies the PDF editor's rule: every ref of the file, the page picture fitted, one commit", async () => {
    const { session, commits } = sessionOf(doc());
    const before = picBox(session.project);
    const missing = new Store<ReadonlySet<string>>(new Set([mediaFileKey(SCAN)]));
    const relinked: string[] = [];
    m.open = async () => "F:\\moved\\tall.png";
    m.probe = async (path) => still(path, 300, 600, 999, 1_700_000_555_000);
    openPictureRelink({ session, missing: ["i1"], missingPictures: missing, onRelinked: (id) => void relinked.push(id) });
    list.rows[0]!.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(commits()).toBe(1);
    for (const id of ["i1", "twin"]) expect(session.project.media.find((x) => x.id === id)!.path).toBe("F:\\moved\\tall.png");
    // the page keeps its size; the portrait picture sits centred in the old box
    expect(before).toEqual([0, 0, 600, 450]);
    expect(picBox(session.project)).toEqual([187.5, 0, 225, 450]);
    // the ordinary mark keeps its box
    const mk = pageAnnots(session.project, "P1")[0] as Extract<PdfAnnot, { t: "image" }>;
    expect([mk.x, mk.y, mk.w, mk.h]).toEqual([30, 45, 120, 70]);
    expect(relinked).toEqual(["i1"]);
    // a new identity was never in the set; the old one stays for an undo
    expect([...missing.get()]).toEqual([mediaFileKey(SCAN)]);
  });

  it("the file put back at its OWN place (same identity) no longer counts as missing", async () => {
    const { session } = sessionOf(doc());
    const missing = new Store<ReadonlySet<string>>(new Set([mediaFileKey(SCAN), "Z:\\other.jpg|1|2"]));
    m.open = async () => SCAN.path;
    m.probe = async () => SCAN;
    openPictureRelink({ session, missing: ["i1"], missingPictures: missing, onRelinked: () => {} });
    list.rows[0]!.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(mediaFileKey(session.project.media.find((x) => x.id === "i1")!)).toBe(mediaFileKey(SCAN));
    expect([...missing.get()]).toEqual(["Z:\\other.jpg|1|2"]);
  });

  it("Locate offers every still picture (the image picker), so a .png replaces a missing .jpg", async () => {
    const { session } = sessionOf(doc());
    m.open = async () => "F:\\moved\\land.png";
    m.probe = async (path) => still(path, 800, 600, 777, 1_700_000_999_000);
    openPictureRelink({ session, missing: ["i1"], onRelinked: () => {} });
    list.rows[0]!.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(m.imagePicks).toBe(1);
    // the one-extension picker was never opened
    expect(m.dialogOpts).toEqual([]);
    expect(session.project.media.find((x) => x.id === "i1")!.path).toBe("F:\\moved\\land.png");
  });

  it("a non-picture chosen anyway is still refused", async () => {
    const { session, commits } = sessionOf(doc());
    m.open = async () => "F:\\moved\\clip.mp4";
    m.probe = async (path) => ({ path, size: 5, mtimeMs: 6, kind: "video", duration: 4, width: 640, height: 360, hasAudio: false });
    openPictureRelink({ session, missing: ["i1"], onRelinked: () => {} });
    const row = list.rows[0]!;
    row.querySelector("[data-locate]")!.fire("click");
    await flush();
    expect(m.imagePicks).toBe(1);
    expect(commits()).toBe(0);
    expect(row.querySelector(".relink-row__status")!.textContent).toBe("This isn't a still image.");
    expect(session.project.media.find((x) => x.id === "i1")!.path).toBe(SCAN.path);
  });

  it("a probe without a picture size keeps the old size and the page picture's box", () => {
    const p = doc();
    const out = relinkPicture(p, "i1", "F:\\x.jpg", { ...still("F:\\x.jpg", 0, 0), width: undefined, height: undefined } as unknown as MediaInfo);
    const ref = out.media.find((x) => x.id === "i1")!;
    expect([ref.path, ref.width, ref.height]).toEqual(["F:\\x.jpg", 800, 600]);
    expect(picBox(out)).toEqual([0, 0, 600, 450]);
  });
});

/* ---------------- the missing set ---------------- */

describe("which picture files count as missing", () => {
  it("usedPictureFiles: the files picture marks use, one per file", () => {
    const p = doc();
    const unused: MediaRef = { ...p.media.find((x) => x.id === "i1")!, id: "unused", path: "C:\\unused.jpg" };
    expect(usedPictureFiles({ ...p, media: [...p.media, unused] }).map((x) => x.id)).toEqual(["i1"]);
  });

  it("nextMissingSet: a checked file is in it exactly when gone; others keep their entry", () => {
    const a = { ...SCAN, id: "a" } as MediaRef;
    const b = { ...still("E:\\b.jpg", 10, 20, 5, 6), id: "b" } as MediaRef;
    const set: ReadonlySet<string> = new Set([mediaFileKey(a), "old|1|2"]);
    expect(nextMissingSet(set, [a, b], [true, false])).toBe(set);
    expect([...nextMissingSet(set, [a, b], [false, true])].sort()).toEqual([mediaFileKey(b), "old|1|2"].sort());
  });

  it("notePicturesFound drops only the files given, and leaves an empty set alone", () => {
    const missing = new Store<ReadonlySet<string>>(new Set([mediaFileKey(SCAN), "k|1|2"]));
    notePicturesFound({ missingPictures: missing }, [still("E:\\elsewhere.jpg", 1, 1)]);
    expect(missing.get().size).toBe(2);
    notePicturesFound({ missingPictures: missing }, [SCAN]);
    expect([...missing.get()]).toEqual(["k|1|2"]);
  });

  it("recheckPictures: a file moved away while open shows as missing; put back, it does not", async () => {
    const { session } = sessionOf(doc());
    const missing = new Store<ReadonlySet<string>>(new Set());
    const ctx = { session, missingPictures: missing };
    let there = false;
    const asked: string[] = [];
    const exists = async (path: string): Promise<boolean> => (asked.push(path), there);
    expect(await recheckPictures(ctx, exists)).toBe(true);
    expect(asked).toEqual([SCAN.path]); // one check per FILE
    expect([...missing.get()]).toEqual([mediaFileKey(SCAN)]);
    there = true;
    expect(await recheckPictures(ctx, exists)).toBe(false);
    expect(missing.get().size).toBe(0);
    // an answer a newer check overtook changes nothing
    there = false;
    expect(await recheckPictures(ctx, exists, () => false)).toBe(false);
    expect(missing.get().size).toBe(0);
  });

  it("whenNoModal waits for an open dialog to close", async () => {
    let open = true;
    let watcher: (() => void) | null = null;
    vi.stubGlobal("document", { querySelector: () => (open ? {} : null), body: {} });
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(fn: () => void) {
          watcher = fn;
        }
        observe(): void {}
        disconnect(): void {
          watcher = null;
        }
      },
    );
    let done = false;
    void whenNoModal().done.then(() => (done = true));
    await flush();
    watcher!(); // something changed, the dialog is still up
    await flush();
    expect(done).toBe(false);
    open = false;
    watcher!();
    await flush();
    expect(done).toBe(true);
    expect(watcher).toBeNull();
  });
});
