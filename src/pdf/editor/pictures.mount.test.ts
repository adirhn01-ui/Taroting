import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, MediaRef, PdfAnnot, ProjectFile } from "../../core/types";
import { picturePageLayout } from "../../core/picture-page";
import { deletePages, insertBlankPage, pageAnnots, reorderPages } from "../model";
import type { PdfViewPage } from "../types";
import { FakeElement, FakeEvent, makeKit, project, type Kit } from "./marks/testkit.test-util";

// "Insert → Pictures" (0.9.5): the page panel's insert (picker order, the
// size question, one undo step, the skipped files said once), its dialog, and
// the rail's view of a picture page.

const h = vi.hoisted(() => ({
  probes: new Map<string, MediaInfo | Error>(),
  probed: [] as string[],
  toasts: [] as string[],
  picks: [] as string[][],
}));
vi.mock("../../core/ipc", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ipc: {
    probeMedia: async (p: string) => {
      h.probed.push(p);
      const v = h.probes.get(p);
      if (!v || v instanceof Error) throw v ?? new Error("no such file");
      return v;
    },
  },
  mediaUrl: (p: string) => `asset://${p}`,
  pickImageFiles: async () => h.picks.shift() ?? [],
  pickPdfFiles: async () => [],
}));
vi.mock("../../ui/toast", () => ({
  toast: {
    error: (m: string) => void h.toasts.push(`error:${m}`),
    refuse: (m: string) => void h.toasts.push(`refuse:${m}`),
    info: (m: string) => void h.toasts.push(`info:${m}`),
  },
}));
vi.mock("../../ui/focus", () => ({
  trapTab: () => () => {},
  focusFirst: (root: FakeElement, sel: string) => {
    root.querySelector(sel)?.focus();
    return true;
  },
}));
vi.mock("../view", () => ({ createThumbRail: () => ({}), isPdfOpenError: () => false, openPdf: async () => ({}) }));

const { createPageOps, probePictures, railThumbs, skippedPicturesText, sortByName, withPagePictures } = await import("./pages");
const { picturePagesTitle, resetPicturePagesSizing } = await import("./pictures-dialog");
const { pictureBox } = await import("../view/thumbs");

const still = (path: string, w: number, h: number, patch: Partial<MediaInfo> = {}): MediaInfo => ({
  path,
  size: 10,
  mtimeMs: 20,
  kind: "image",
  duration: 0,
  width: w,
  height: h,
  hasAudio: false,
  ...patch,
});

let kit: Kit;
const scrolled: number[] = [];
function ops(p: ProjectFile = project()) {
  kit = makeKit(p);
  (kit.view as unknown as { scrollToPage(s: number): void }).scrollToPage = (s: number) => void scrolled.push(s);
  return createPageOps(kit.ctx, { isDisposed: () => false, addDocs: () => {}, dropDocs: () => {}, openExport: () => {} });
}
const backdrop = (): FakeElement | null => kit.doc.body.querySelector(".modal-backdrop");
const click = (el: FakeElement | null): void => void el!.dispatchEvent(new FakeEvent("click", { detail: 1 }));
const pages = (): string[] => kit.session.project.pdf!.pages.map((pg) => pg.id);

beforeEach(() => {
  h.probes.clear();
  h.probed = [];
  h.toasts = [];
  h.picks = [];
  scrolled.length = 0;
  resetPicturePagesSizing();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pure parts", () => {
  it("sorts picked files in natural name order, case ignored", () => {
    expect(sortByName(["C:\\s\\scan 10.jpg", "C:\\t\\Scan 2.jpg", "C:\\s\\scan 1.png"])).toEqual([
      "C:\\s\\scan 1.png",
      "C:\\t\\Scan 2.jpg",
      "C:\\s\\scan 10.jpg",
    ]);
  });

  it("says skipped files once, counted", () => {
    expect(skippedPicturesText(1)).toBe("Skipped 1 file: only still pictures can be placed on a page.");
    expect(skippedPicturesText(3)).toBe("Skipped 3 files: only still pictures can be placed on a page.");
  });

  it("probes keeping the picked order and leaves out failures, non-stills and unsized stills", async () => {
    const paths = ["a.jpg", "b.jpg", "c.mp4", "d.png", "e.png"];
    const answers: Record<string, MediaInfo | Error> = {
      "a.jpg": still("a.jpg", 10, 20),
      "b.jpg": new Error("corrupt"),
      "c.mp4": still("c.mp4", 10, 10, { kind: "video" }),
      "d.png": still("d.png", 0, 5),
      "e.png": still("e.png", 30, 40),
    };
    // the slower first answer must not reorder the result
    const probe = async (p: string): Promise<MediaInfo> => {
      if (p === "a.jpg") await new Promise((r) => setTimeout(r, 5));
      const v = answers[p]!;
      if (v instanceof Error) throw v;
      return v;
    };
    expect((await probePictures(paths, probe, () => false))!.map((i) => i.path)).toEqual(["a.jpg", "e.png"]);
    expect(await probePictures(paths, probe, () => true)).toBeNull();
  });

  it("titles the dialog by count", () => {
    expect(picturePagesTitle(1)).toBe("Add 1 picture as a page");
    expect(picturePagesTitle(3)).toBe("Add 3 pictures as pages");
  });

  it("places a page picture in a thumbnail, turned with its page", () => {
    // a 600×300 page; the picture's x, y, w, h all differ (none 0 or 1), so
    // a turn that confuses y with 1 − y − h, or w with h, shows
    const pic = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
    expect(pictureBox(pic, 0, 600, 300)).toEqual({ left: 10, top: 20, width: 50, height: 30, imgW: 100, imgH: 100, turn: 0 });
    // turned right, (X, Y) → (1 − Y, X): x 0.5..0.8, y 0.1..0.6 of a 300×600
    // view; the box is 90 pt wide × 300 tall, the upright picture 300 × 90
    expect(pictureBox(pic, 90, 600, 300)).toEqual({ left: 50, top: 10, width: 30, height: 50, imgW: 333.333, imgH: 30, turn: 90 });
    // upside down, (X, Y) → (1 − X, 1 − Y): x 0.4..0.9, y 0.5..0.8
    expect(pictureBox(pic, 180, 600, 300)).toEqual({ left: 40, top: 50, width: 50, height: 30, imgW: 100, imgH: 100, turn: 180 });
    // turned left, (X, Y) → (Y, 1 − X): x 0.2..0.5, y 0.4..0.9
    expect(pictureBox(pic, 270, 600, 300)).toEqual({ left: 20, top: 40, width: 30, height: 50, imgW: 333.333, imgH: 30, turn: 270 });
  });
});

describe("Insert → Pictures", () => {
  it("asks the page size, then inserts the readable pictures after the slot as ONE step, says the skipped once", async () => {
    const o = ops();
    h.picks.push(["C:\\s\\b 10.jpg", "C:\\s\\b 2.jpg", "C:\\s\\clip.mp4"]);
    h.probes.set("C:\\s\\b 2.jpg", still("C:\\s\\b 2.jpg", 400, 300));
    h.probes.set("C:\\s\\b 10.jpg", still("C:\\s\\b 10.jpg", 200, 500));
    h.probes.set("C:\\s\\clip.mp4", still("C:\\s\\clip.mp4", 64, 64, { kind: "video" }));
    const done = o.insertPictures(0);
    await kit.flush();
    // the question first: nothing probed or inserted yet
    expect(backdrop()).not.toBeNull();
    expect(backdrop()!.querySelector("#pdfed-picpages-title")!.textContent).toBe("Add 3 pictures as pages");
    expect(h.probed).toEqual([]);
    const select = backdrop()!.querySelector("select")!;
    expect(select.value).toBe("picture");
    select.value = "a4";
    click(backdrop()!.querySelector(".btn--primary"));
    await done;
    expect(backdrop()).toBeNull();
    expect(kit.session.steps).toBe(1);
    const ids = pages();
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe("P1");
    expect(ids[3]).toBe("P2");
    // natural name order: "b 2" before "b 10"
    const media = (id: string): string => {
      const a = pageAnnots(kit.session.project, id)[0] as Extract<PdfAnnot, { t: "image" }>;
      return kit.session.project.media.find((m) => m.id === a.media)!.path;
    };
    expect([media(ids[1]!), media(ids[2]!)]).toEqual(["C:\\s\\b 2.jpg", "C:\\s\\b 10.jpg"]);
    const first = kit.session.project.pdf!.pages[1]!;
    const want = picturePageLayout(400, 300, "a4");
    expect([first.w, first.h]).toEqual([want.pageW, want.pageH]);
    expect(h.toasts).toEqual(["refuse:Skipped 1 file: only still pictures can be placed on a page."]);
    expect(kit.ctx.pageSelection.get()).toEqual([1, 2]);
    expect(scrolled).toEqual([1]);
  });

  it("remembers the page size for the session; Cancel and Escape insert nothing", async () => {
    const o = ops();
    h.probes.set("C:\\a.jpg", still("C:\\a.jpg", 10, 10));
    h.picks.push(["C:\\a.jpg"]);
    let done = o.insertPictures(1);
    await kit.flush();
    expect(backdrop()!.querySelector("#pdfed-picpages-title")!.textContent).toBe("Add 1 picture as a page");
    backdrop()!.querySelector("select")!.value = "letter";
    click(backdrop()!.querySelector(".btn--primary"));
    await done;
    expect(kit.session.steps).toBe(1);

    h.picks.push(["C:\\a.jpg"]);
    done = o.insertPictures(1);
    await kit.flush();
    expect(backdrop()!.querySelector("select")!.value).toBe("letter");
    const cancel = backdrop()!.querySelectorAll("button").find((b) => b.textContent === "Cancel")!;
    click(cancel);
    await done;
    expect(backdrop()).toBeNull();
    expect(kit.session.steps).toBe(1);

    h.picks.push(["C:\\a.jpg"]);
    done = o.insertPictures(1);
    await kit.flush();
    kit.doc.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    await done;
    expect(backdrop()).toBeNull();
    expect(kit.session.steps).toBe(1);
    expect(kit.overlays).toEqual([]);
  });

  it("given paths and a size (the E2E's way in): no picker, no question", async () => {
    const o = ops();
    h.probes.set("C:\\x.png", still("C:\\x.png", 90, 30));
    await o.insertPictures(1, { paths: ["C:\\x.png"], sizing: "picture" });
    expect(backdrop()).toBeNull();
    expect(pages()).toHaveLength(3);
    expect(kit.session.project.pdf!.pages[2]).toMatchObject({ src: null, w: 67.5, h: 22.5 });
  });

  it("lands after the page it was asked after, wherever that page went meanwhile — at the end when it is gone", async () => {
    // three pages: P1 P2 B; the pictures are asked after P1 (slot 0)
    const three = (): ProjectFile => insertBlankPage(project(), 2, 300, 300);
    const run = async (meanwhile: (p: ProjectFile) => ProjectFile): Promise<string[]> => {
      const o = ops(three());
      h.probes.set("C:\\n.png", still("C:\\n.png", 90, 30));
      const before = pages();
      const done = o.insertPictures(0, { paths: ["C:\\n.png"] });
      await kit.flush();
      // the size question is open: the user changes the pages behind it
      kit.session.commit(meanwhile);
      click(backdrop()!.querySelector(".btn--primary"));
      await done;
      return pages().map((id) => (!before.includes(id) ? "NEW" : before.indexOf(id) === 2 ? "B" : id));
    };
    // P1 moved to the end: the new page follows it there (a stale slot would put it at 1)
    expect(await run((p) => reorderPages(p, [p.pdf!.pages[1]!.id, p.pdf!.pages[2]!.id, p.pdf!.pages[0]!.id]))).toEqual(["P2", "B", "P1", "NEW"]);
    expect(scrolled.at(-1)).toBe(3);
    // P1 deleted: at the end, not at the stale slot 1
    expect(await run((p) => deletePages(p, ["P1"]))).toEqual(["P2", "B", "NEW"]);
    expect(scrolled.at(-1)).toBe(2);
  });

  it("nothing readable: nothing inserted, said once", async () => {
    const o = ops();
    await o.insertPictures(0, { paths: ["C:\\gone.jpg", "C:\\gone2.jpg"], sizing: "picture" });
    expect(kit.session.steps).toBe(0);
    expect(h.toasts).toEqual(["refuse:Skipped 2 files: only still pictures can be placed on a page."]);
  });
});

describe("the rail's picture pages", () => {
  const ref: MediaRef = { id: "m1", path: "C:\\s.jpg", size: 1, mtimeMs: 2, kind: "image", duration: 0, hasAudio: false };
  const withPic = (p: ProjectFile, pageId: string): ProjectFile => {
    const annots = Object.create(null) as Record<string, PdfAnnot[]>;
    annots[pageId] = [{ id: "a", t: "image", x: 0, y: 99, w: 306, h: 396, media: "m1", bg: true }];
    return { ...p, media: [ref], pdf: { ...p.pdf!, annots } };
  };

  it("adds the page picture to a blank page's slot, with its identity, URL and thumbnail", async () => {
    const viewPages: PdfViewPage[] = [{ key: "P1", doc: null, index: 0, rotate: 0, w: 612, h: 792 }];
    const thumb = vi.fn(async (m: MediaRef) => `thumb:${m.path}`);
    const out = withPagePictures(viewPages, withPic(project(), "P1"), { thumb });
    const { thumb: t, ...rest } = out[0]!.picture!;
    expect(rest).toEqual({ file: "C:\\s.jpg|1|2", url: "asset://C:\\s.jpg", x: 0, y: 0.125, w: 0.5, h: 0.5 });
    expect(thumb).not.toHaveBeenCalled();
    expect(await t!()).toBe("thumb:C:\\s.jpg");
    expect(out[0]).not.toBe(viewPages[0]);
  });

  it("a project without page pictures does no new work: same list, media never read, no helper reached", () => {
    const p = project();
    let mediaReads = 0;
    const counted = Object.defineProperty({ ...p }, "media", {
      get: () => {
        mediaReads++;
        return p.media;
      },
    });
    const url = vi.fn((x: string) => x);
    const thumb = vi.fn(async () => "");
    const viewPages: PdfViewPage[] = [
      { key: "P1", doc: null, index: 0, rotate: 0, w: 612, h: 792 },
      { key: "P2", doc: null, index: 1, rotate: 90, w: 612, h: 792 },
    ];
    expect(withPagePictures(viewPages, counted, { url, thumb })).toBe(viewPages);
    expect(mediaReads).toBe(0);
    expect(url).not.toHaveBeenCalled();
    expect(thumb).not.toHaveBeenCalled();
  });

  it("looks the media up through ONE table per call, however many picture pages", () => {
    const base = project();
    const annots = Object.create(null) as Record<string, PdfAnnot[]>;
    const viewPages: PdfViewPage[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `B${i}`;
      annots[id] = [{ id: `a${i}`, t: "image", x: 0, y: 0, w: 10, h: 10, media: "m1", bg: true }];
      viewPages.push({ key: id, doc: null, index: 0, rotate: 0, w: 100, h: 100 });
    }
    let mediaReads = 0;
    const counted = Object.defineProperty({ ...base, pdf: { ...base.pdf!, annots } }, "media", {
      get: () => {
        mediaReads++;
        return [ref];
      },
    });
    const out = withPagePictures(viewPages, counted);
    expect(out.every((vp) => vp.picture?.file === "C:\\s.jpg|1|2")).toBe(true);
    expect(mediaReads).toBe(1);
  });

  it("asks the cached thumbnail once per file identity; a failure is asked again later", async () => {
    let fail = true;
    const ask = vi.fn(async (m: MediaRef) => {
      if (fail) throw new Error("busy");
      return `t:${m.path}|${m.mtimeMs}`;
    });
    const thumbs = railThumbs(ask);
    await expect(thumbs(ref)).rejects.toThrow("busy");
    fail = false;
    expect(await thumbs(ref)).toBe("t:C:\\s.jpg|2");
    expect(await thumbs({ ...ref, id: "other id, same file" })).toBe("t:C:\\s.jpg|2");
    expect(ask).toHaveBeenCalledTimes(2);
    // the same path after an edit is another file
    expect(await thumbs({ ...ref, mtimeMs: 3 })).toBe("t:C:\\s.jpg|3");
    expect(ask).toHaveBeenCalledTimes(3);
  });
});
