import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Home's Open and drop routing, as pure functions: which files open a project,
// which are refused, and which go to the "Open as" dialog — never the viewer.

vi.mock("../core/ipc", () => ({
  describeError: String,
  ipc: {},
  mediaUrl: String,
  onDragDrop: async () => () => {},
  pickOpenFiles: async () => [],
}));
vi.mock("../core/nav", () => ({ navigate: () => {} }));
vi.mock("../core/open-media", () => ({ isTempProjectPath: async () => false }));
vi.mock("../ui/menu", () => ({ showMenu: () => {}, closeMenu: () => {} }));
vi.mock("../ui/toast", () => ({ toast: { error: () => {}, info: () => {}, refuse: () => {} } }));

const {
  emptyGridHtml,
  gridEnterAction,
  isSearchChord,
  modalEnterConfirms,
  openRouteInfo,
  openRouteNotice,
  orphanRowsHtml,
  routeDrop,
  routeOpenPicks,
  sortRecents,
} = await import("./home");
import type { RecentItem } from "../core/types";

describe("routeOpenPicks (Home's Open)", () => {
  it("does nothing when nothing was picked", () => {
    expect(routeOpenPicks([])).toEqual({ kind: "nothing" });
  });

  it("opens exactly one project", () => {
    const route = routeOpenPicks(["C:\\Docs\\Cut.TRT"]);
    expect(route).toEqual({ kind: "project", path: "C:\\Docs\\Cut.TRT", ignored: 0 });
    expect(openRouteNotice(route)).toBeNull();
    expect(openRouteInfo(route)).toBeNull();
  });

  it("refuses a project picked with anything else, another project included", () => {
    const mixed = routeOpenPicks(["C:\\a.mp4", "C:\\Docs\\Cut.trt"]);
    expect(mixed).toEqual({ kind: "mixed" });
    expect(routeOpenPicks(["C:\\a.trt", "C:\\b.trt"])).toEqual({ kind: "mixed" });
    expect(openRouteNotice(mixed)).toBe(
      "Open one project at a time, or choose media files to start a new project.",
    );
  });

  it("hands media to the dialog in natural name order, whatever order the picker used", () => {
    const route = routeOpenPicks(["D:\\x\\shot 10.png", "C:\\y\\Shot 9.JPG", "E:\\z\\clip.mp4", "C:\\y\\shot 2.png"]);
    expect(route).toEqual({
      kind: "media",
      media: ["E:\\z\\clip.mp4", "C:\\y\\shot 2.png", "C:\\y\\Shot 9.JPG", "D:\\x\\shot 10.png"],
      skipped: 0,
    });
    expect(openRouteNotice(route)).toBeNull();
  });

  it("drops unsupported files with one toast that says how many", () => {
    const route = routeOpenPicks(["C:\\a.png", "C:\\notes.txt", "C:\\b.psd", "C:\\c.mov"]);
    expect(route).toEqual({ kind: "media", media: ["C:\\a.png", "C:\\c.mov"], skipped: 2 });
    expect(openRouteNotice(route)).toBe("Skipped 2 files of an unsupported type.");
    const one = routeOpenPicks(["C:\\a.png", "C:\\notes.txt"]);
    expect(openRouteNotice(one)).toBe("Skipped 1 file of an unsupported type.");
  });

  it("refuses a pick with nothing supported in it", () => {
    expect(openRouteNotice(routeOpenPicks(["C:\\notes.txt"]))).toBe("Unsupported file type.");
    const three = routeOpenPicks(["C:\\a.txt", "C:\\b.doc", "C:\\c"]);
    expect(three).toEqual({ kind: "unsupported", count: 3 });
    expect(openRouteNotice(three)).toBe("None of these 3 files is a supported type.");
  });
});

describe("routeDrop (a drop on Home)", () => {
  it("still opens a dropped project directly, even among other files, and says the rest were not opened", () => {
    const route = routeDrop(["C:\\a.mp4", "C:\\Cut.trt", "C:\\b.trt"]);
    expect(route).toEqual({ kind: "project", path: "C:\\Cut.trt", ignored: 2 });
    // Information, not an error: the project did open.
    expect(openRouteNotice(route)).toBeNull();
    expect(openRouteInfo(route)).toBe("Opened the project. The other 2 files were not opened.");
    expect(openRouteInfo(routeDrop(["C:\\Cut.trt", "C:\\a.png"]))).toBe(
      "Opened the project. The other file was not opened.",
    );
  });

  it("says nothing extra for a project dropped on its own", () => {
    const route = routeDrop(["C:\\Cut.trt"]);
    expect(route).toEqual({ kind: "project", path: "C:\\Cut.trt", ignored: 0 });
    expect(openRouteInfo(route)).toBeNull();
  });

  it("sends dropped media to the same dialog as Open", () => {
    expect(routeDrop(["C:\\b.png", "C:\\a.png"])).toEqual({ kind: "media", media: ["C:\\a.png", "C:\\b.png"], skipped: 0 });
  });
});

describe("Home never opens media in the viewer", () => {
  it("has no route to the viewer at all", () => {
    // The routing's result type has no viewer variant; this pins that no
    // other path in the screen navigates there either.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "home.ts"), "utf8");
    expect(src).not.toMatch(/view:\s*"viewer"/);
  });
});

describe("sortRecents by Name", () => {
  const rec = (name: string, i: number): RecentItem => ({
    path: `C:\\Docs\\${i}.trt`,
    name,
    modifiedAt: `2026-09-0${i}T10:00:00Z`,
    durationSec: 0,
    thumb: null,
    sizeBytes: i,
  });

  it("is natural, the way Explorer orders names: 2 before 10, case ignored", () => {
    // Input order differs from every expected position, and a plain
    // localeCompare would put "Clip 10" before "Clip 2".
    const items = [rec("Clip 10", 1), rec("clip 3", 2), rec("Clip 2", 3), rec("Clip 1", 4)];
    expect(sortRecents(items, "name").map((r) => r.name)).toEqual(["Clip 1", "Clip 2", "clip 3", "Clip 10"]);
    // The input is not reordered in place.
    expect(items.map((r) => r.name)).toEqual(["Clip 10", "clip 3", "Clip 2", "Clip 1"]);
  });
});

/** An event target whose `closest` answers for the selectors listed. */
const inside = (...sels: string[]) => ({ closest: (s: string) => (sels.includes(s) ? {} : null) });

describe("gridEnterAction (Enter on the recents grid)", () => {
  it("opens a focused card", () => {
    expect(gridEnterAction(inside(".project-card"), false)).toBe("open");
  });

  it("leaves Enter on a card's More button to the button's own click (the menu)", () => {
    expect(gridEnterAction(inside(".project-card", "[data-more]"), false)).toBeNull();
  });

  it("leaves Enter in an inline rename to the rename", () => {
    expect(gridEnterAction(inside(".project-card", ".project-card__rename"), false)).toBeNull();
  });

  it("toggles in select mode, More button included, and ignores anything outside a card", () => {
    expect(gridEnterAction(inside(".project-card"), true)).toBe("toggle");
    expect(gridEnterAction(inside(".project-card", "[data-more]"), true)).toBe("toggle");
    expect(gridEnterAction(inside(), false)).toBeNull();
    expect(gridEnterAction(inside("[data-more]"), true)).toBeNull();
  });
});

describe("modalEnterConfirms (Enter in a Home dialog)", () => {
  const input = { id: "input" };
  const cancel = { id: "cancel" };

  it("confirms only from the name field", () => {
    expect(modalEnterConfirms({ key: "Enter", target: input }, input)).toBe(true);
  });

  it("never confirms from a focused Cancel (or any other button)", () => {
    expect(modalEnterConfirms({ key: "Enter", target: cancel }, input)).toBe(false);
  });

  it("leaves a dialog without a field, other keys and an IME's Enter alone", () => {
    expect(modalEnterConfirms({ key: "Enter", target: cancel }, null)).toBe(false);
    expect(modalEnterConfirms({ key: "Escape", target: input }, input)).toBe(false);
    expect(modalEnterConfirms({ key: "Enter", target: input, isComposing: true }, input)).toBe(false);
  });
});

describe("isSearchChord (Ctrl+F)", () => {
  const ev = (key: string, code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it("matches Ctrl+F by label and, on a non-Latin layout, by position", () => {
    expect(isSearchChord(ev("f", "KeyF", { ctrlKey: true }))).toBe(true);
    expect(isSearchChord(ev("כ", "KeyF", { ctrlKey: true }))).toBe(true);
  });

  it("does not match plain F, Ctrl+Shift+F, or a Latin layout's F on another key", () => {
    expect(isSearchChord(ev("f", "KeyF"))).toBe(false);
    expect(isSearchChord(ev("F", "KeyF", { ctrlKey: true, shiftKey: true }))).toBe(false);
    // Dvorak: the key labelled F sits where QWERTY has Y; Ctrl+U at KeyF is not find.
    expect(isSearchChord(ev("u", "KeyF", { ctrlKey: true }))).toBe(false);
  });
});

describe("the grid's empty states", () => {
  it("tells an unreadable list apart from an empty one, with a way to try again", () => {
    const err = emptyGridHtml("error");
    expect(err).toContain("Couldn't read your recent projects.");
    expect(err).toContain('data-act="retry-recents"');
    expect(err).not.toContain("No projects yet.");
    expect(emptyGridHtml("none")).toContain("No projects yet.");
    expect(emptyGridHtml("none")).not.toContain("retry-recents");
    expect(emptyGridHtml("searching")).toContain("No projects match your search.");
  });
});

describe("orphanRowsHtml (Recover lines)", () => {
  it("names each orphan by its file, escaped, keyed by index rather than by path", () => {
    const html = orphanRowsHtml(["C:\\tmp\\Holiday.trt", "C:\\tmp\\<b>&co.trt"]);
    expect(html).toContain("<strong>Holiday</strong>");
    expect(html).toContain("<strong>&lt;b&gt;&amp;co</strong>");
    expect(html).toContain('data-recover="0"');
    expect(html).toContain('data-recover="1"');
    expect(html).not.toContain("tmp");
    expect(orphanRowsHtml([])).toBe("");
  });
});
