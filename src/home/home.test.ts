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
vi.mock("../ui/toast", () => ({ toast: { error: () => {}, info: () => {} } }));

const { openRouteInfo, openRouteNotice, routeDrop, routeOpenPicks } = await import("./home");

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
