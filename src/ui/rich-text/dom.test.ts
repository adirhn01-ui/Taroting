// The styled contenteditable's walker (a copy of the PDF text box's): the
// text it reads from spans, line breaks, blocks and the placeholder <br>,
// and DOM point <-> offset in both directions. A small node double stands in
// for the DOM (vitest runs in node).

import { describe, expect, it } from "vitest";
import { editorText, kindOf, offsetOf, pointAt, UNDO_BURST_MS } from "./dom";

class N {
  childNodes: N[] = [];
  parentNode: N | null = null;
  constructor(
    readonly nodeType: number,
    readonly tagName?: string,
    readonly data?: string,
  ) {}
  get textContent(): string {
    return this.data ?? this.childNodes.map((c) => c.textContent).join("");
  }
  contains(n: N): boolean {
    for (let x: N | null = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
}
const el = (tag: string, ...kids: N[]): N => {
  const e = new N(1, tag);
  for (const k of kids) {
    k.parentNode = e;
    e.childNodes.push(k);
  }
  return e;
};
const t = (s: string): N => new N(3, undefined, s);

describe("rich-text walker", () => {
  it("reads spans with line breaks inside, and drops the placeholder <br>", () => {
    const a = t("Ab\nc");
    const b = t("d\n");
    const root = el("DIV", el("SPAN", a), el("SPAN", b), el("BR"));
    expect(editorText(root as never, 99)).toBe("Ab\ncd\n");
    expect(editorText(root as never, 3)).toBe("Ab\n");
    expect(offsetOf(root as never, b as never, 1)).toBe(5);
    expect(offsetOf(root as never, t("x") as never, 0)).toBeNull();
    // the edge of two spans belongs to the earlier one
    const p = pointAt(root as never, 4);
    expect(p.node).toBe(a);
    expect(p.offset).toBe(4);
    // past the end: before the placeholder
    const end = pointAt(root as never, 99);
    expect(end.offset).toBe(2);
  });

  it("reads a block a browser made as one line break", () => {
    const root = el("DIV", t("ab"), el("DIV", t("cd")), el("DIV", el("BR")));
    expect(editorText(root as never, 99)).toBe("ab\ncd\n");
  });

  it("kinds and the burst", () => {
    expect(kindOf("insertText")).toBe("insert");
    expect(kindOf("insertParagraph")).toBe("break");
    expect(kindOf("deleteContentBackward")).toBe("delete");
    expect(kindOf("insertFromPaste")).toBe("other");
    expect(UNDO_BURST_MS).toBe(500);
  });
});
