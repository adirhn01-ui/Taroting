// Line breaking for text boxes, shared by the vector path and the canvas
// fallback: break after whitespace, a word wider than the box breaks between
// characters, trailing spaces never count toward a line's width. Works in
// LOGICAL order on string offsets so bidi can then reorder each line.

/** Line height as a multiple of the font size (the editor's CSS uses the same). */
export const LINE_HEIGHT = 1.25;

/** [start, end) ranges of `para`'s lines; an empty paragraph is one empty line. */
export function wrapParagraph(para: string, width: number, measure: (s: string) => number): [number, number][] {
  const lines: [number, number][] = [];
  if (para.length === 0) return [[0, 0]];
  const trimEnd = (a: number, b: number): number => {
    while (b > a && /\s/.test(para[b - 1]!)) b--;
    return b;
  };
  // word tokens: [start, end) including their trailing whitespace; leading
  // whitespace of the paragraph belongs to the first word
  const words: [number, number][] = [];
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(para)) !== null) words.push([words.length === 0 ? 0 : m.index, m.index + m[0].length]);
  if (words.length === 0) return [[0, 0]];

  let s = words[0]![0];
  let e = s;
  for (const [ws, we] of words) {
    const candidate = trimEnd(s, we);
    if (measure(para.slice(s, candidate)) <= width) {
      e = we;
      continue;
    }
    if (e > s) {
      lines.push([s, trimEnd(s, e)]);
      s = ws;
      e = ws;
      if (measure(para.slice(s, trimEnd(s, we))) <= width) {
        e = we;
        continue;
      }
    }
    // a word wider than the box on its own: break it between characters
    let i = s;
    const end = trimEnd(s, we);
    while (i < end) {
      let j = i;
      let last = i;
      while (j < end) {
        const cp = para.codePointAt(j)!;
        const next = j + (cp > 0xffff ? 2 : 1);
        if (last > i && measure(para.slice(i, next)) > width) break;
        last = next;
        j = next;
      }
      if (last >= end) {
        s = i;
        e = we;
        break;
      }
      lines.push([i, last]);
      i = last;
      s = i;
      e = i;
    }
  }
  if (e > s || lines.length === 0) lines.push([s, trimEnd(s, e)]);
  return lines;
}
