// The DOM side of a styled contenteditable: one walker that reads the text
// and maps DOM points to text offsets and back, the selection as offsets,
// and the undo-burst rule. A copy of the helpers the PDF text box uses
// (src/pdf/editor/marks/text.ts), kept separate so the shipped PDF editor
// stays exactly as it is; the two can be joined later.
//
// Offsets are UTF-16 units of the text the walker reads: every text node's
// data, every <br> as "\n", except Chromium's placeholder <br> (the last leaf
// of the content, nothing after it) and a <br> that is the last leaf of a
// block, which are no character. DIV and P blocks (what a browser may make of
// Enter or a paste) are read as `innerText` reads them: a block boundary with
// text before or after it is ONE "\n".

interface Leaf {
  node: Node;
  start: number;
  /** characters this leaf stands for (a placeholder <br>: 0) */
  len: number;
  br: boolean;
  /** a block boundary's "\n" (no node of its own): where its point is */
  at?: { node: Node; offset: number };
}

const tagOf = (n: Node): string => String((n as Element).tagName ?? "").toUpperCase();
export const isBr = (n: Node): boolean => n.nodeType === 1 && tagOf(n) === "BR";
const isBlock = (n: Node): boolean => n.nodeType === 1 && (tagOf(n) === "DIV" || tagOf(n) === "P");
export const dataOf = (n: Node): string => (n as Text).data ?? n.textContent ?? "";
const indexIn = (n: Node): number => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number;

type Item =
  | { k: "t"; node: Node }
  | { k: "br"; node: Node; blockLast: boolean }
  | { k: "open"; node: Node }
  | { k: "close"; node: Node }
  | { k: "pt" };

/** The one walker: the content's text, its leaves, the placeholder <br> and,
 *  with `target`, the offset of that DOM point (null when it is not met). */
function scan(root: Node, target?: { node: Node; off: number }): { leaves: Leaf[]; text: string; placeholder: Node | null; found: number | null } {
  const items: Item[] = [];
  const open: { last: number }[] = [];
  let tOff = 0;
  const leaf = (it: Item): void => {
    items.push(it);
    for (const b of open) b.last = items.length - 1;
  };
  const walk = (n: Node): void => {
    const kids = Array.from(n.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (target && target.node === n && target.off === i) items.push({ k: "pt" });
      const c = kids[i]!;
      if (c.nodeType === 3) {
        if (target && target.node === c) tOff = target.off;
        leaf({ k: "t", node: c });
      } else if (isBr(c)) leaf({ k: "br", node: c, blockLast: false });
      else if (c.nodeType === 1) {
        const block = isBlock(c);
        if (block) {
          items.push({ k: "open", node: c });
          open.push({ last: -1 });
        }
        walk(c);
        if (block) {
          const b = open.pop()!;
          const last = items[b.last];
          if (last && last.k === "br") last.blockLast = true;
          items.push({ k: "close", node: c });
        }
      }
    }
    if (target && target.node === n && target.off >= kids.length) items.push({ k: "pt" });
  };
  walk(root);
  let placeholder: Node | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const l = items[i]!;
    if (l.k === "br") {
      placeholder = l.node;
      break;
    }
    if (l.k === "t" && dataOf(l.node).length > 0) break;
  }
  const leaves: Leaf[] = [];
  let text = "";
  let found: number | null = null;
  let boundary = false;
  let pending: { node: Node; offset: number } | null = null;
  const brk = (at: { node: Node; offset: number }): void => {
    leaves.push({ node: at.node, start: text.length, len: 1, br: true, at });
    text += "\n";
    boundary = true;
    pending = null;
  };
  for (const it of items) {
    if (it.k === "open") {
      if (pending) brk(pending);
      else if (text.length > 0 && !boundary) brk({ node: it.node.parentNode!, offset: indexIn(it.node) });
    } else if (it.k === "close") {
      if (!boundary) pending = { node: it.node.parentNode!, offset: indexIn(it.node) + 1 };
    } else if (it.k === "pt") {
      found = text.length;
    } else if (it.k === "t") {
      const d = dataOf(it.node);
      if (d.length > 0 && pending) brk(pending);
      if (target && target.node === it.node) found = text.length + Math.max(0, Math.min(tOff, d.length));
      leaves.push({ node: it.node, start: text.length, len: d.length, br: false });
      text += d;
      if (d.length > 0) boundary = false;
    } else {
      const n = it.node === placeholder || it.blockLast ? 0 : 1;
      if (n > 0 && pending) brk(pending);
      if (target && target.node === it.node) found = text.length;
      leaves.push({ node: it.node, start: text.length, len: n, br: true });
      if (n > 0) text += "\n";
      boundary = false;
    }
  }
  return { leaves, text, placeholder, found };
}

/** The text an editor's content holds, by the walker, cut to `max` units. */
export function editorText(root: Node, max: number): string {
  return scan(root).text.slice(0, max);
}

/** The text offset of the DOM point (`node`, `off`) inside `root`, or null
 *  when the point is not in it. */
export function offsetOf(root: Node, node: Node, off: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  const { text, found } = scan(root, { node, off });
  return found === null ? null : Math.min(found, text.length);
}

function beforeNode(n: Node): { node: Node; offset: number } {
  const p = n.parentNode!;
  return { node: p, offset: Array.prototype.indexOf.call(p.childNodes, n) as number };
}

/** The DOM point for text offset `at` (clamped). At the edge of two text
 *  nodes the earlier one wins (the end of the run before), which is where
 *  typing inherits its style from (`remapRuns`). */
export function pointAt(root: Node, at: number): { node: Node; offset: number } {
  const { leaves, text, placeholder } = scan(root);
  const v = Math.max(0, Math.min(at, text.length));
  for (const l of leaves) {
    if (l.at) {
      if (v === l.start) return l.at;
    } else if (!l.br && v >= l.start && v <= l.start + l.len) return { node: l.node, offset: v - l.start };
    else if (l.br && l.node !== placeholder && v === l.start) return beforeNode(l.node);
  }
  if (placeholder) return beforeNode(placeholder);
  return { node: root, offset: root.childNodes.length };
}

/** A selection as text offsets: [s, e), and which end the focus is at. */
export interface SelOffsets {
  s: number;
  e: number;
  backward: boolean;
}

export function windowSelection(): Selection | null {
  try {
    return typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
  } catch {
    return null;
  }
}

/** The document selection as offsets into `root`, or null when either end is
 *  outside it (or there is none). */
export function readSelection(root: Node): SelOffsets | null {
  const sel = windowSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const a = offsetOf(root, sel.anchorNode, sel.anchorOffset);
  const f = offsetOf(root, sel.focusNode, sel.focusOffset);
  if (a === null || f === null) return null;
  return { s: Math.min(a, f), e: Math.max(a, f), backward: f < a };
}

/** Put the document selection at `o` inside `root` (focus end kept). */
export function writeSelection(root: Node, o: SelOffsets): void {
  const sel = windowSelection();
  if (!sel) return;
  try {
    const anchor = pointAt(root, o.backward ? o.e : o.s);
    const focus = pointAt(root, o.backward ? o.s : o.e);
    if (typeof sel.setBaseAndExtent === "function") sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    else if (typeof document.createRange === "function") {
      const r = document.createRange();
      r.setStart(anchor.node, anchor.offset);
      r.setEnd(focus.node, focus.offset);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {
    /* the caret stays where it is */
  }
}

/** The CSS Custom Highlight registry, when this engine has one. */
export function highlightRegistry(): { set(name: string, h: unknown): unknown; delete(name: string): unknown } | null {
  const g = globalThis as unknown as { CSS?: { highlights?: { set(n: string, h: unknown): unknown; delete(n: string): unknown } }; Highlight?: unknown };
  return g.CSS && g.CSS.highlights && typeof g.Highlight === "function" ? g.CSS.highlights : null;
}

/** A typing burst merges into one undo step while it stays the same kind and
 *  no gap between two inputs is longer than this. */
export const UNDO_BURST_MS = 500;

/** "break": a line break (Enter), a kind of its own in the burst rule */
export type EditKind = "insert" | "delete" | "break" | "other";
export function kindOf(inputType: unknown): EditKind {
  const t = typeof inputType === "string" ? inputType : "";
  if (t === "insertParagraph" || t === "insertLineBreak") return "break";
  if (t === "insertText") return "insert";
  if (t.startsWith("delete")) return "delete";
  return "other";
}
