import { describe, expect, it } from "vitest";
import { mediaDisplayName, textLabel } from "./media-name";
import type { Generator, MediaRef } from "./types";

/*
 * One name per media entry, wherever it is shown. Each generated fixture's
 * stored path (the label stamped at creation) DISAGREES with its generator, the
 * way an edited element's does — a rule that read the path would pass a
 * fixture where the two matched and still show the stale label in the app.
 */

const textGen = (text: string): Extract<Generator, { type: "text" }> => ({
  type: "text",
  text,
  fontFamily: "Segoe UI",
  sizePx: 96,
  color: "#ffffff",
  bold: false,
  italic: false,
});

function gen(path: string, generator: Generator): MediaRef {
  return { id: `g-${path}`, path, size: 0, mtimeMs: 0, kind: "image", duration: 0, hasAudio: false, width: 320, height: 120, generator };
}

describe("mediaDisplayName", () => {
  it("keeps a text's dots: the name is not cut at the last one like a file extension", () => {
    const m = gen("Text — www.site.com", textGen("www.site.com"));
    expect(mediaDisplayName(m)).toBe("Text — www.site.com");
  });

  it("keeps a text's slashes: the name is not cut down to a path segment", () => {
    const m = gen("Text — 3/4 off today", textGen("3/4 off today"));
    expect(mediaDisplayName(m)).toBe("Text — 3/4 off today");
  });

  it("names an edited text by what it says now, not by its creation-time label", () => {
    const m = gen("Text — Old title", textGen("Chapter two"));
    expect(mediaDisplayName(m)).toBe("Text — Chapter two");
  });

  it("follows an edit: a new generator object gets its own name", () => {
    const before = gen("Text — First", textGen("First"));
    expect(mediaDisplayName(before)).toBe("Text — First");
    // What updateMedia does: a new MediaRef carrying a new generator.
    const after: MediaRef = { ...before, generator: textGen("Second draft") };
    expect(mediaDisplayName(after)).toBe("Text — Second draft");
    expect(mediaDisplayName(before)).toBe("Text — First");
  });

  it("uses the same label rule a new text element is created with", () => {
    const long = "A title well past the twenty-four character cut\nwith a second line";
    const m = gen("anything", textGen(long));
    expect(mediaDisplayName(m)).toBe(textLabel(long));
    expect(mediaDisplayName(m)).toBe("Text — A title well past the tw…");
  });

  it("names a solid by its current colour", () => {
    // Created black, recoloured in the inspector since: the path still says so.
    const m = gen("Solid #000000", { type: "solid", color: "#12ab34" });
    expect(mediaDisplayName(m)).toBe("Solid #12ab34");
  });

  it("names a drawing 'Drawing'", () => {
    const m = gen("Ink.layer", { type: "drawing", chunks: [] });
    expect(mediaDisplayName(m)).toBe("Drawing");
  });

  it("names a file by its name without the extension, inner dots kept", () => {
    const m: MediaRef = {
      id: "f",
      path: "D:\\shoot\\take.final.v2.mov",
      size: 9,
      mtimeMs: 4,
      kind: "video",
      duration: 3,
      hasAudio: true,
      width: 1920,
      height: 1080,
    };
    expect(mediaDisplayName(m)).toBe("take.final.v2");
  });
});

describe("textLabel", () => {
  it("collapses whitespace to one line, cuts at 24 and falls back to Title", () => {
    expect(textLabel("  Hello\n\tworld  ")).toBe("Text — Hello world");
    expect(textLabel("x".repeat(25))).toBe(`Text — ${"x".repeat(24)}…`);
    expect(textLabel("x".repeat(24))).toBe(`Text — ${"x".repeat(24)}`);
    expect(textLabel(" \n ")).toBe("Text — Title");
  });
});
