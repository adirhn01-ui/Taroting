// Loading a text generator's `fontId` (0.9.4): a well-shaped id is kept, an
// ill-shaped one is dropped (its `fontFamily`, the fallback, then applies), and
// a 0.9.3 project — no `fontId` anywhere — comes back as the very same objects.
// The legacy field is never touched here.

import { describe, expect, it } from "vitest";
import { addGeneratedMedia, createProject, sanitizeMediaRef, sanitizeProject } from "./project";
import type { Generator, MediaRef, ProjectFile } from "./types";

type TextGen = Extract<Generator, { type: "text" }>;

const textGen = (over: Record<string, unknown> = {}): TextGen =>
  ({ type: "text", text: "Hi", fontFamily: "Georgia", sizePx: 70, color: "#abcdef", bold: true, italic: false, ...over }) as TextGen;

function withText(g: TextGen): { project: ProjectFile; media: MediaRef } {
  return addGeneratedMedia(createProject("t"), g, 20, 10, "Text");
}

describe("sanitizing a text generator's fontId", () => {
  it("keeps a well-shaped id, and the media object itself", () => {
    const { media } = withText(textGen({ fontFamily: "Segoe UI", fontId: "lib:Inter" }));
    expect(sanitizeMediaRef(media)).toBe(media);
  });

  it("drops an ill-shaped id and keeps every other field", () => {
    for (const bad of ["", " Consolas", "lib:", "a\u0000b", "x".repeat(97), 42, null, { path: "C:/x.ttf" }]) {
      const { media } = withText(textGen({ fontId: bad }));
      const out = sanitizeMediaRef(media);
      expect(out, String(bad)).not.toBe(media);
      expect("fontId" in out.generator!, String(bad)).toBe(false);
      expect(out.generator, String(bad)).toEqual(textGen());
    }
  });

  it("leaves a 0.9.3 project's generator untouched (same reference)", () => {
    const { project, media } = withText(textGen());
    const out = sanitizeProject(project);
    expect(out).toBe(project);
    expect(out.media[0]!.generator).toBe(media.generator);
  });

  it("repairs a whole project with a bad id, and only that generator", () => {
    const good = withText(textGen({ fontId: "Consolas" }));
    const bad = addGeneratedMedia(good.project, textGen({ fontId: "lib:" }), 20, 10, "Text 2");
    const out = sanitizeProject(bad.project);
    expect(out.media[0]).toBe(good.media);
    expect("fontId" in out.media[1]!.generator!).toBe(false);
    expect((out.media[1]!.generator as TextGen).fontFamily).toBe("Georgia");
  });
});
