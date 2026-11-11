// validateImageProject and a text layer's `fontId` (Taroting 0.9.4): an
// ill-shaped id from a crafted `.trt` is dropped on load, so the legacy
// `fontFamily` is the font in force; a well-shaped one, and every layer of a
// project that never used one, keep their very object.

import { describe, expect, it } from "vitest";
import { createBlankImageProject } from "../core/image-project";
import type { Generator, MediaRef, ProjectFile } from "../core/types";
import { addGeneratorLayer, validateImageProject } from "./layers";

type TextGen = Extract<Generator, { type: "text" }>;
const text = (over: Record<string, unknown> = {}): TextGen =>
  ({ type: "text", text: "Hi", fontFamily: "Georgia", sizePx: 30, color: "#abcdef", bold: true, italic: false, ...over }) as TextGen;

function project(...gens: TextGen[]): ProjectFile {
  let p = createBlankImageProject("Card", 300, 200, "#ffffff");
  for (const g of gens) p = addGeneratorLayer(p, g, 100, 40, "Text").project;
  return p;
}
const genOf = (m: MediaRef): TextGen => m.generator as TextGen;

describe("validateImageProject: a text layer's fontId", () => {
  it("keeps a well-shaped id, and the whole project's reference", () => {
    const p = project(text({ fontId: "lib:Inter" }), text({ fontId: "Segoe UI Light" }));
    expect(validateImageProject(p).project).toBe(p);
  });

  it("leaves a 0.9.3 project (no fontId anywhere) untouched, same reference", () => {
    const p = project(text(), text({ fontFamily: "Impact" }));
    expect(validateImageProject(p).project).toBe(p);
  });

  it("drops an ill-shaped id, keeps the rest of that generator and every other layer's object", () => {
    const good = text({ text: "Good", fontId: "Consolas" });
    const p = project(good, text({ text: "Bad", fontId: "lib:" }));
    const out = validateImageProject(p);
    const [goodRef, badRef] = out.project.media;
    // The clean layer's MediaRef is the very same object.
    expect(goodRef).toBe(p.media[0]);
    expect(genOf(goodRef!).fontId).toBe("Consolas");
    // The damaged one: no `fontId` key at all, the legacy field as it was.
    const bad = genOf(badRef!);
    expect("fontId" in bad).toBe(false);
    expect(bad).toEqual({ type: "text", text: "Bad", fontFamily: "Georgia", sizePx: 30, color: "#abcdef", bold: true, italic: false });
    // A silent repair: nothing to tell the user.
    expect(out.notes).toEqual([]);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an empty string", ""],
    ["a control character", "Inter\u0000"],
    ["edge whitespace", "Inter "],
    ["over 96 units", "x".repeat(97)],
  ])("drops %s", (_label, bad) => {
    const p = project(text({ fontId: bad }));
    const out = validateImageProject(p);
    expect("fontId" in genOf(out.project.media[0]!)).toBe(false);
  });
});
