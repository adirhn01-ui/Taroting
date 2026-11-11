// The report names a text generator's library or installed font (0.9.4),
// capped, and a generator without one reports exactly as before.

import { describe, expect, it } from "vitest";
import { buildReport, redactProjectShape } from "./diagnostics";
import { addGeneratedMedia, createProject } from "./project";
import type { Generator, ProjectFile } from "./types";

type TextGen = Extract<Generator, { type: "text" }>;

const project = (over: Record<string, unknown>): ProjectFile =>
  addGeneratedMedia(
    createProject("t"),
    { type: "text", text: "private words", fontFamily: "Courier New", sizePx: 18, color: "#010203", bold: false, italic: true, ...over } as TextGen,
    20,
    10,
    "Text",
  ).project;

const ctx = (p: ProjectFile) => ({
  at: "2026-11-09T09:00:00.000Z",
  appVersion: "0.9.4",
  platform: "Win32",
  userAgent: "test",
  project: p,
});

describe("the font in a diagnostics report", () => {
  it("reports a fontId beside the fallback family", () => {
    const g = redactProjectShape(project({ fontFamily: "Segoe UI", fontId: "lib:Inter" })).media[0]!.generator!;
    expect(g).toEqual({ type: "text", chars: 13, fontFamily: "Segoe UI", fontId: "lib:Inter", sizePx: 18, bold: false, italic: true });
    expect(buildReport(ctx(project({ fontFamily: "Segoe UI", fontId: "lib:Inter" })))).toContain(
      "generator:text chars=13 Segoe UI font=lib:Inter 18px italic",
    );
  });

  it("has no fontId key, and the 0.9.3 line, without one", () => {
    const g = redactProjectShape(project({})).media[0]!.generator!;
    expect("fontId" in g).toBe(false);
    expect(buildReport(ctx(project({})))).toContain("generator:text chars=13 Courier New 18px italic");
  });

  it("caps a long font name from a crafted file", () => {
    const g = redactProjectShape(project({ fontId: "F".repeat(5000), fontFamily: "G".repeat(5000) })).media[0]!.generator!;
    expect(g.fontId).toBe("F".repeat(96));
    expect(g.fontFamily).toBe("G".repeat(96));
  });
});
