import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaInfo, MediaRef, PdfAnnot, ProjectFile } from "../../core/types";
import { DEFAULT_SETTINGS } from "../../core/types";
import { Store } from "../../core/store";
import { encodePoints } from "../../image/strokes";
import { insertPicturePages, mediaFileKey, pageAnnots, picturePageSizingOf } from "../model";
import type { PdfViewPage } from "../types";
import { FakeElement, FakeEvent, makeKit, project, showPages, type Kit } from "./marks/testkit.test-util";

// Picture pages afterwards (0.9.5), in the editor: the page menu's Page size
// (marked current, one undo step, several pages), and a missing picture —
// its placeholder on the page and in the rail, the page's "Relink picture"
// (button and menu), and the press on that button kept from the tools.

const h = vi.hoisted(() => ({ menus: [] as { x: number; y: number; items: { label: string; icon?: string; hint?: string; onSelect(): void }[] }[] }));
vi.mock("../../ui/menu", () => ({
  showMenu: (x: number, y: number, items: { label: string; onSelect(): void }[]) => void h.menus.push({ x, y, items }),
  closeMenu: () => {},
}));
vi.mock("../../ui/toast", () => ({ toast: { error: () => {}, refuse: () => {}, info: () => {}, notice: () => {} } }));
vi.mock("../view", () => ({ createThumbRail: () => ({}), isPdfOpenError: () => false, openPdf: async () => ({}) }));

const { settingsStore } = await import("../../core/session");
const { createPageOps, withPagePictures } = await import("./pages");
const { toolsPart } = await import("./tools");
const { mountMissingPictureButtons, shownFraction, RELINK_BUTTON } = await import("./missing-pictures");
const { picturesToCheck, railNeedsSync } = await import("./shell");

const still = (path: string, w: number, h: number): MediaInfo => ({ path, size: 11, mtimeMs: 22, kind: "image", duration: 0, width: w, height: h, hasAudio: false });

function seq(): () => string {
  let n = 0;
  return () => `i${++n}`;
}

/** P1, P2 (source pages), then a picture page i2 (800×600 scan, picture i3,
 *  media i1) at slot 2. A pen stroke over the picture on i2 and an ordinary
 *  picture mark of the SAME file on P1. */
function doc(): ProjectFile {
  const p = insertPicturePages(project(), 2, [still("C:\\scans\\land.jpg", 800, 600)], "picture", seq());
  const annots = Object.create(null) as Record<string, PdfAnnot[]>;
  for (const k of Object.keys(p.pdf!.annots)) annots[k] = p.pdf!.annots[k]!;
  annots.i2 = [...annots.i2!, { id: "ink", t: "ink", kind: "pen", c: "#000000", w: 4, o: 1, p: encodePoints(new Float32Array([100, 100, 1, 200, 150, 1])) }];
  annots.P1 = [{ id: "mk", t: "image", x: 50, y: 60, w: 100, h: 80, media: "i1" }];
  return { ...p, pdf: { ...p.pdf!, annots } };
}

let kit: Kit;
const relinked: string[][] = [];
function ops(p: ProjectFile = doc(), missing?: string[]) {
  kit = makeKit(p);
  kit.ctx.missingPictures = new Store<ReadonlySet<string>>(new Set(missing ?? []));
  return createPageOps(kit.ctx, {
    isDisposed: () => false,
    addDocs: () => {},
    dropDocs: () => {},
    openExport: () => {},
    relinkPictures: (ids) => void relinked.push(ids),
  });
}
const landKey = mediaFileKey({ path: "C:\\scans\\land.jpg", size: 11, mtimeMs: 22 });
const labels = (items: { label: string }[]): string[] => items.map((i) => i.label);

beforeEach(() => {
  h.menus = [];
  relinked.length = 0;
  settingsStore.set({ ...DEFAULT_SETTINGS, pdfSignatures: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page menu's Page size", () => {
  it("is offered on a picture page only, with its current sizing", () => {
    const o = ops();
    expect(labels(o.menuItems([0]))).not.toContain("Page size");
    const item = o.menuItems([2]).find((i) => i.label === "Page size")!;
    expect(item.hint).toBe("Picture size");
  });

  it("opens the three sizes where the menu was, the current one ticked; choosing one is ONE undo step", () => {
    const o = ops();
    o.menuItems([2], { clientX: 40, clientY: 70 }).find((i) => i.label === "Page size")!.onSelect();
    const menu = h.menus.pop()!;
    expect([menu.x, menu.y]).toEqual([40, 70]);
    expect(labels(menu.items)).toEqual(["Picture size", "A4", "Letter"]);
    const ticked = menu.items.filter((i) => i.icon?.includes("<path"));
    expect(labels(ticked)).toEqual(["Picture size"]);
    menu.items[1]!.onSelect();
    expect(kit.session.steps).toBe(1);
    expect(picturePageSizingOf(kit.session.project, "i2")).toBe("a4");
    // the stroke over the scan moved with it (the picture box grew)
    const ink = pageAnnots(kit.session.project, "i2").find((a) => a.id === "ink")!;
    expect(ink).not.toBe(pageAnnots(kit.session.history[0]!, "i2").find((a) => a.id === "ink"));
    // now A4 is the ticked one
    o.menuItems([2], { clientX: 1, clientY: 1 }).find((i) => i.label === "Page size")!.onSelect();
    expect(labels(h.menus.pop()!.items.filter((i) => i.icon?.includes("<path")))).toEqual(["A4"]);
    // choosing the current one changes nothing
    expect(o.setSizing([2], "a4")).toBe(false);
    expect(kit.session.steps).toBe(1);
  });

  it("with several pages selected, applies to the picture pages and skips the rest", () => {
    const p0 = doc();
    const p = insertPicturePages(p0, 4, [still("C:\\scans\\port.png", 300, 900)], "picture", () => `x${Math.random().toString(36).slice(2)}`);
    const o = ops(p);
    const items = o.menuItems([0, 2, 3]);
    expect(items.find((i) => i.label === "Page size")).toBeDefined();
    expect(o.setSizing([0, 2, 3], "letter")).toBe(true);
    expect(kit.session.steps).toBe(1);
    const pages = kit.session.project.pdf!.pages;
    expect(picturePageSizingOf(kit.session.project, pages[2]!.id)).toBe("letter");
    expect(picturePageSizingOf(kit.session.project, pages[3]!.id)).toBe("letter");
    expect(pages[0]).toBe(p.pdf!.pages[0]);
  });

  it("marks none when the selected picture pages are in different sizings", () => {
    const p = insertPicturePages(doc(), 4, [still("C:\\scans\\port.png", 300, 900)], "a4", () => `y${Math.random().toString(36).slice(2)}`);
    const o = ops(p);
    const item = o.menuItems([2, 3], { clientX: 0, clientY: 0 }).find((i) => i.label === "Page size")!;
    expect(item.hint).toBeUndefined();
    item.onSelect();
    expect(h.menus.pop()!.items.filter((i) => i.icon?.includes("<path"))).toEqual([]);
  });
});

describe("a missing picture", () => {
  it("the page menu offers Relink picture for the page's missing files only", () => {
    const o = ops(doc(), [landKey]);
    const item = o.menuItems([2]).find((i) => i.label === "Relink picture")!;
    item.onSelect();
    expect(relinked).toEqual([["i1"]]);
    // a page without a picture: no entry; nothing missing: no entry
    expect(labels(o.menuItems([1]))).not.toContain("Relink picture");
    const o2 = ops(doc(), []);
    expect(labels(o2.menuItems([2]))).not.toContain("Relink picture");
  });

  it("the rail shows the picture page's placeholder and marks every page with a missing picture", () => {
    const p = doc();
    const vps: PdfViewPage[] = p.pdf!.pages.map((pg) => (pg.src === null ? { key: pg.id, doc: null, index: 0, rotate: 0, w: pg.w, h: pg.h } : { key: pg.id, doc: {} as never, index: pg.page, rotate: 0 }));
    const thumb = vi.fn(async () => "thumb://x");
    const out = withPagePictures(vps, p, { url: (x) => `asset://${x}`, thumb, missing: (r) => mediaFileKey(r) === landKey });
    expect(out.map((v) => v.missingPicture === true)).toEqual([true, false, true]);
    expect(out[2]!.picture!.missing).toBe(true);
    expect(out[2]!.picture!.thumb).toBeUndefined();
    // the same file present: no mark, the thumbnail asked for
    const fine = withPagePictures(vps, p, { thumb, missing: () => false });
    expect(fine.map((v) => v.missingPicture === true)).toEqual([false, false, false]);
    expect(fine[2]!.picture!.missing).toBeUndefined();
    expect(typeof fine[2]!.picture!.thumb).toBe("function");
  });

  it("the page draws the placeholder at its box, and the picture again once the file is back", async () => {
    kit = makeKit(doc());
    kit.ctx.missingPictures = new Store<ReadonlySet<string>>(new Set([landKey]));
    const part = toolsPart(kit.ctx, kit.hosts);
    showPages(kit);
    await kit.flush();
    const svg = (key: string): FakeElement => (kit.view.overlay(key) as unknown as FakeElement).querySelector("svg")!;
    expect(svg("P1").querySelector("[data-id='mk']")!.tagName).toBe("G");
    expect(svg("i2").querySelector("[data-id='i3']")!.tagName).toBe("G");
    // found again: drawn as the picture
    kit.ctx.missingPictures.set(new Set());
    await kit.flush();
    expect(svg("P1").querySelector("[data-id='mk']")!.tagName).toBe("IMAGE");
    expect(svg("i2").querySelector("[data-id='i3']")!.tagName).toBe("IMAGE");
    part.dispose();
  });

  it("puts one Relink picture button over the page's first missing picture; its press starts no tool", async () => {
    kit = makeKit(doc());
    kit.ctx.missingPictures = new Store<ReadonlySet<string>>(new Set([landKey]));
    // the shell's capture listener, ahead of the tools
    kit.view.el.addEventListener(
      "pointerdown",
      (e: Event) => {
        const t = e.target as unknown as { closest(s: string): unknown } | null;
        if (t && t.closest(`.${RELINK_BUTTON}`)) e.preventDefault();
      },
      true,
    );
    const part = toolsPart(kit.ctx, kit.hosts);
    kit.ctx.tools.update((s) => ({ ...s, tool: "pen" }));
    const asked: string[][] = [];
    const btns = mountMissingPictureButtons(kit.ctx, (ids) => void asked.push(ids));
    showPages(kit);
    await kit.flush();
    const btnOf = (key: string): FakeElement | null => (kit.view.overlay(key) as unknown as FakeElement).querySelector(`.${RELINK_BUTTON}`);
    expect(btnOf("P2")).toBeNull();
    const onP1 = btnOf("P1")!;
    expect(onP1.textContent).toContain("Relink picture");
    // centred on the mark: (50 + 50) / 612, (60 + 40) / 792 of the page
    expect(onP1.style.left).toBe(`${Math.round((100 / 612) * 1e5) / 1e3}%`);
    expect(onP1.style.top).toBe(`${Math.round((100 / 792) * 1e5) / 1e3}%`);
    const onPic = btnOf("i2")!;
    expect([onPic.style.left, onPic.style.top]).toEqual(["50%", "50%"]);
    // a press on it draws nothing; its click asks for the relink
    kit.pointer("pointerdown", 100, 100, {}, onP1);
    kit.pointer("pointermove", 140, 140, {}, onP1);
    kit.pointer("pointerup", 140, 140, {}, onP1);
    expect(kit.session.steps).toBe(0);
    onP1.dispatchEvent(new FakeEvent("click", { detail: 1 }));
    expect(asked).toEqual([["i1"]]);
    // the file found: the buttons go
    kit.ctx.missingPictures.set(new Set());
    await kit.flush();
    expect(btnOf("P1")).toBeNull();
    expect(btnOf("i2")).toBeNull();
    btns.dispose();
    part.dispose();
  });

  it("shownFraction turns a page point with the page", () => {
    // u = 60/600 = 0.1 across, v = 300/400 = 0.75 down: every turn differs,
    // and swapping u and v in any branch gives another answer
    expect(shownFraction(60, 300, 600, 400, 0)).toEqual({ fx: 0.1, fy: 0.75 });
    expect(shownFraction(60, 300, 600, 400, 90)).toEqual({ fx: 0.25, fy: 0.1 });
    expect(shownFraction(60, 300, 600, 400, 180)).toEqual({ fx: 0.9, fy: 0.25 });
    expect(shownFraction(60, 300, 600, 400, 270)).toEqual({ fx: 0.75, fy: 0.9 });
  });

  it("the rail is rebuilt when a mark change moves a missing picture to or off a page, not for other edits", () => {
    const p = doc();
    const missing: ReadonlySet<string> = new Set([landKey]);
    const withP1 = (list: PdfAnnot[]): ProjectFile => ({ ...p, pdf: { ...p.pdf!, annots: { ...p.pdf!.annots, P1: list } } });
    const withP2 = (list: PdfAnnot[]): ProjectFile => ({ ...p, pdf: { ...p.pdf!, annots: { ...p.pdf!.annots, P2: list } } });
    const mk = pageAnnots(p, "P1")[0]!;
    // the missing mark deleted from P1: its badge must go
    expect(railNeedsSync(p, withP1([]), missing)).toBe(true);
    // pasted onto P2: P2 gains the badge
    expect(railNeedsSync(p, withP2([{ ...mk, id: "mk2" }]), missing)).toBe(true);
    // a stroke on P2: no page changes its badge, nothing rebuilt
    const stroke: PdfAnnot = { id: "s", t: "line", c: "#000000", w: 2, a: [1, 2], b: [3, 4] };
    expect(railNeedsSync(p, withP2([stroke]), missing)).toBe(false);
    // the files changed (a relink or its undo): rebuilt
    expect(railNeedsSync(p, { ...p, media: [...p.media] }, missing)).toBe(true);
    // nothing missing: never
    expect(railNeedsSync(p, withP1([]), new Set())).toBe(false);
  });

  it("the open checks only pictures some mark uses, one per file", () => {
    const p = doc();
    const twin: MediaRef = { ...p.media.find((m) => m.id === "i1")!, id: "twin" };
    const unused: MediaRef = { ...twin, id: "unused", path: "C:\\other.jpg" };
    const q: ProjectFile = { ...p, media: [...p.media, twin, unused] };
    expect(picturesToCheck(q, ["i1", "twin", "unused"]).map((m) => m.id)).toEqual(["i1"]);
    expect(picturesToCheck(q, ["unused"])).toEqual([]);
    expect(picturesToCheck(q, [])).toEqual([]);
  });
});
