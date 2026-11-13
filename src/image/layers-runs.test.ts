// cleanTextGen and a text's style runs (0.9.5): a cut clips them, a "\r"
// (whose rewrite moves every later offset) drops them, a tab keeps them
// (same length), a clean layer keeps its reference.

import { describe, expect, it } from "vitest";
import type { Generator, PdfTextRun } from "../core/types";
import { cleanTextGen, TEXT_MAX_CHARS } from "./layers";

type TextGen = Extract<Generator, { type: "text" }>;

const gen = (text: string, runs: PdfTextRun[]): TextGen => ({
  type: "text",
  text,
  fontFamily: "Georgia",
  sizePx: 31,
  color: "#334455",
  bold: false,
  italic: false,
  runs,
});

describe("cleanTextGen with runs", () => {
  it("keeps a clean layer's reference", () => {
    const g = gen("ab cd", [{ s: 3, e: 5, c: "#ff0000" }]);
    expect(cleanTextGen(g).gen).toBe(g);
  });

  it("clips the runs of a cut text, dropping one left empty", () => {
    const n = TEXT_MAX_CHARS;
    const text = "x".repeat(n + 10);
    const g = gen(text, [
      { s: 2, e: 4, c: "#ff0000" },
      { s: n - 3, e: n + 5, size: 70 },
      { s: n + 1, e: n + 9, bold: true },
    ]);
    const out = cleanTextGen(g);
    expect(out.shortened).toBe(true);
    expect(out.gen.text).toHaveLength(n);
    expect(out.gen.runs).toEqual([
      { s: 2, e: 4, c: "#ff0000" },
      { s: n - 3, e: n, size: 70 },
    ]);
  });

  it("drops the runs when a carriage return is rewritten", () => {
    const out = cleanTextGen(gen("ab\r\ncd", [{ s: 4, e: 6, c: "#ff0000" }]));
    expect(out.gen.text).toBe("ab\ncd");
    expect("runs" in out.gen).toBe(false);
  });

  it("keeps the offsets across a tab", () => {
    const out = cleanTextGen(gen("a\tbc", [{ s: 2, e: 4, c: "#ff0000" }]));
    expect(out.gen.text).toBe("a bc");
    expect(out.gen.runs).toEqual([{ s: 2, e: 4, c: "#ff0000" }]);
  });
});
