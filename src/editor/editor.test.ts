import { describe, expect, it } from "vitest";
import { exitDest } from "./editor";

/**
 * Every exit from the editor — Back, Ctrl+W, the keep/discard outcomes and a
 * failed load — lands where exitDest says. An editor opened from the viewer
 * ("Open as project") returns to the viewer on the file it was showing.
 *
 * Fixtures differ on every axis: the viewer's file and the project's .trt are
 * different files in different folders with different extensions, so an exit
 * that handed the viewer the PROJECT path (the other string in the route)
 * fails here rather than passing because the two coincided.
 */
const PROJECT = "C:\\Users\\adirh\\AppData\\Local\\Taroting\\tmp-projects\\beach-walk.trt";
const SHOWN = "D:\\Camera roll\\2026\\IMG_4471.MOV";

describe("exitDest", () => {
  it("a viewer-launched editor goes back to the viewer on the same file", () => {
    expect(exitDest({ view: "editor", projectPath: PROJECT, temp: true, returnTo: SHOWN })).toEqual({
      view: "viewer",
      path: SHOWN,
    });
  });

  it("any other editor goes home, temp or not", () => {
    expect(exitDest({ view: "editor", projectPath: PROJECT })).toEqual({ view: "home" });
    expect(exitDest({ view: "editor", projectPath: PROJECT, temp: true })).toEqual({ view: "home" });
  });

  it("an empty returnTo is no file to go back to: home, never a viewer on nothing", () => {
    expect(exitDest({ view: "editor", projectPath: PROJECT, returnTo: "" })).toEqual({ view: "home" });
  });
});
