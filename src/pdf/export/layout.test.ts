// The wrapping core (0.9.4): `wrapRanges` over a range measure, the
// string-measure `wrapParagraph` kept as a byte-identical wrapper, and
// `rangeMeasurer` summing a paragraph's styled pieces.

import { describe, expect, it } from "vitest";
import { rangeMeasurer, wrapParagraph, wrapRanges } from "./layout";

/** The wrapping rule as it stood in 0.9.3, copied verbatim (string measure,
 *  string cache): the reference the refactor must equal on every case. */
function wrap093(para: string, width: number, measure: (s: string) => number): [number, number][] {
  const lines: [number, number][] = [];
  if (para.length === 0) return [[0, 0]];
  const cache = new Map<string, number>();
  const m = (t: string): number => {
    let v = cache.get(t);
    if (v === undefined) {
      v = measure(t);
      if (cache.size < 8192) cache.set(t, v);
    }
    return v;
  };
  const trimEnd = (a: number, b: number): number => {
    while (b > a && /\s/.test(para[b - 1]!)) b--;
    return b;
  };
  const words: [number, number][] = [];
  const re = /\S+\s*/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(para)) !== null) words.push([words.length === 0 ? 0 : mt.index, mt.index + mt[0].length]);
  if (words.length === 0) return [[0, 0]];
  let s = words[0]![0];
  let e = s;
  let full = 0;
  for (const [ws, we] of words) {
    const wt = trimEnd(ws, we);
    const cw = m(para.slice(ws, wt));
    const tw = wt < we ? m(para.slice(wt, we)) : 0;
    if ((e > s ? full : 0) + cw <= width) {
      full = (e > s ? full : 0) + cw + tw;
      e = we;
      continue;
    }
    if (e > s) {
      lines.push([s, trimEnd(s, e)]);
      s = ws;
      e = ws;
      full = 0;
      if (cw <= width) {
        full = cw + tw;
        e = we;
        continue;
      }
    }
    let i = s;
    const end = wt;
    while (i < end) {
      let j = i;
      let last = i;
      let acc = 0;
      while (j < end) {
        const cp = para.codePointAt(j)!;
        const next = j + (cp > 0xffff ? 2 : 1);
        const w = m(para.slice(j, next));
        if (last > i && acc + w > width) break;
        acc += w;
        last = next;
        j = next;
      }
      if (last >= end) {
        s = i;
        e = we;
        full = acc + tw;
        break;
      }
      lines.push([i, last]);
      i = last;
      s = i;
      e = i;
      full = 0;
    }
  }
  if (e > s || lines.length === 0) lines.push([s, trimEnd(s, e)]);
  return lines;
}

const mono = (s: string): number => s.length;
/** A proportional measure with uneven widths, so a wrong range or a wrong
 *  slice changes the answer. */
const prop = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ch === " " ? 0.31 : ((ch.codePointAt(0)! * 37) % 11) / 7 + 0.4;
  return w;
};

describe("wrapParagraph is unchanged by the 0.9.4 refactor", () => {
  const CASES: [string, number][] = [
    ["aaa bbb ccc", 7],
    ["aaa bbb ccc", 100],
    ["abcdefgh", 3],
    ["xx abcdefgh y", 3],
    ["", 10],
    ["   ", 4],
    ["aa bb cc dd ee ff gg", 8],
    ["  lead word", 6],
    ["ab   cd", 4],
    ["The quick brown fox jumps over the lazy dog", 9.7],
    ["a\u{1F600}\u{1F601}b c\u{1F602}d", 2.2],
    ["mixed\twhite  space and nbsp", 6.3],
    ["x".repeat(300) + " tail", 13.1],
  ];
  for (const [para, w] of CASES) {
    it(`${JSON.stringify(para.slice(0, 24))} at ${w}`, () => {
      for (const measure of [mono, prop]) {
        const calls093: string[] = [];
        const calls: string[] = [];
        const want = wrap093(para, w, (t) => (calls093.push(t), measure(t)));
        const got = wrapParagraph(para, w, (t) => (calls.push(t), measure(t)));
        expect(got).toEqual(want);
        // the same measure calls, in the same order (the cache is by string)
        expect(calls).toEqual(calls093);
      }
    });
  }
});

describe("wrapRanges + rangeMeasurer (style runs)", () => {
  // "abcd efgh": "ab" in a narrow font (1 per char), the rest in a wide one (3)
  const para = "abcd efgh";
  const pieces = [
    { s: 0, e: 2 },
    { s: 2, e: 9 },
  ];
  const perChar = [1, 3];
  const mr = () => rangeMeasurer(pieces, (i, a, b) => (b - a) * perChar[i]!);

  it("a word spanning two differently-measured pieces wraps by the SUM of its pieces", () => {
    // "abcd" = 2*1 + 2*3 = 8, "abcd " 11, "efgh" 12: two lines at 12 (all
    // narrow, 9, would be one) ...
    expect(mr()(0, 4)).toBe(8);
    expect(wrapRanges(para, 12, mr())).toEqual([
      [0, 4],
      [5, 9],
    ]);
    // ... not 7.9 (all-narrow, 4, would): it breaks between characters
    expect(wrapRanges(para, 7.9, mr())).toEqual([
      [0, 3],
      [3, 4],
      [5, 7],
      [7, 9],
    ]);
  });

  it("measures each piece of a range clipped to it, and caches by range", () => {
    const seen: [number, number, number][] = [];
    const m = rangeMeasurer(
      [
        { s: 0, e: 3 },
        { s: 3, e: 5 },
        { s: 5, e: 9 },
      ],
      (i, a, b) => (seen.push([i, a, b]), (b - a) * (i + 1)),
    );
    expect(m(2, 7)).toBe(1 * 1 + 2 * 2 + 2 * 3);
    expect(seen).toEqual([
      [0, 2, 3],
      [1, 3, 5],
      [2, 5, 7],
    ]);
    expect(m(2, 7)).toBe(11);
    expect(seen).toHaveLength(3);
    // a range inside one piece asks that piece only
    expect(m(6, 8)).toBe(6);
    expect(seen[3]).toEqual([2, 6, 8]);
    expect(seen).toHaveLength(4);
  });

  it("one piece covering the paragraph wraps exactly like wrapParagraph", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const one = rangeMeasurer([{ s: 0, e: text.length }], (_i, a, b) => prop(text.slice(a, b)));
    expect(wrapRanges(text, 9.7, one)).toEqual(wrapParagraph(text, 9.7, prop));
  });
});
