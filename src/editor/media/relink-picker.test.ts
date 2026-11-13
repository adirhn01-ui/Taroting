// Which file picker the relink dialog's Locate opens: without a `pick` on the
// context (the video and image editors), the native picker filtered to the
// missing file's own extension; with one (the PDF editor), that picker only.
// Driven through the real openRelinkDialog against a minimal fake DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, MediaRef, ProjectFile } from "../../core/types";

const m = vi.hoisted(() => ({
  dialogOpts: [] as unknown[],
  dialogAnswer: null as string | null,
  probe: null as unknown as (path: string) => Promise<MediaInfo>,
}));

vi.mock("../../core/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/ipc")>();
  return { ...real, inTauri: true, ipc: { ...real.ipc, probeMedia: (p: string) => m.probe(p) } };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async (o: unknown) => {
    m.dialogOpts.push(o);
    return m.dialogAnswer;
  },
}));
vi.mock("../../ui/focus", () => ({ trapTab: () => () => {}, focusFirst: () => {} }));
vi.mock("../../ui/toast", () => ({ toast: { info: () => {}, error: () => {}, refuse: () => {} } }));

import { addMedia, createProject } from "../../core/project";
import type { ProjectSession } from "../../core/session";
import { openRelinkDialog, type RelinkCtx } from "./relink";

class FakeEl {
  innerHTML = "";
  textContent = "";
  title = "";
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};
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
}

let list: ListEl;
beforeEach(() => {
  m.dialogOpts = [];
  m.dialogAnswer = null;
  const backdrop = new FakeEl();
  list = new ListEl();
  backdrop.seed("#rl-list", list);
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

const still = (path: string, w: number, h: number): MediaInfo => ({
  path,
  size: 51,
  mtimeMs: 1_700_000_000_777,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
});

/** A project with one missing still (scan.jpg); Locate pressed on its row. */
async function locate(extra: Partial<RelinkCtx>): Promise<{ project: () => ProjectFile; id: string }> {
  const added = addMedia(createProject("Picker fixture"), still("E:\\old\\scan.jpg", 640, 480));
  let p = added.project;
  const session = {
    get project() {
      return p;
    },
    commit(fn: (q: ProjectFile) => ProjectFile) {
      p = fn(p);
    },
  } as unknown as ProjectSession;
  openRelinkDialog({ session, media: { retrack: () => {} }, missing: [added.media.id], ...extra });
  list.rows[0]!.querySelector("[data-locate]")!.fire("click");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { project: () => p, id: added.media.id };
}

describe("relink: the picker Locate opens", () => {
  it("default: the native picker, filtered to the missing file's own extension only", async () => {
    await locate({});
    expect(m.dialogOpts).toEqual([{ multiple: false, filters: [{ name: "scan", extensions: ["jpg"] }] }]);
  });

  it("with a pick hook: that picker alone, handed the missing record, and its file is applied", async () => {
    const asked: MediaRef[] = [];
    m.probe = async (path) => still(path, 300, 200);
    const r = await locate({
      stillsOnly: true,
      pick: async (ref) => {
        asked.push(ref);
        return "F:\\moved\\scan.png";
      },
    });
    expect(m.dialogOpts).toEqual([]);
    expect(asked.map((x) => x.path)).toEqual(["E:\\old\\scan.jpg"]);
    const ref = r.project().media.find((x) => x.id === r.id)!;
    expect([ref.path, ref.width, ref.height]).toEqual(["F:\\moved\\scan.png", 300, 200]);
  });

  it("with a pick hook that is closed: nothing is probed or applied", async () => {
    let probed = 0;
    m.probe = async (path) => {
      probed++;
      return still(path, 300, 200);
    };
    const r = await locate({ pick: async () => null });
    expect(probed).toBe(0);
    expect(r.project().media.find((x) => x.id === r.id)!.path).toBe("E:\\old\\scan.jpg");
  });
});
