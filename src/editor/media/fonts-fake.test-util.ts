// A stand-in for src/fonts (the font runtime) and a small fake DOM, shared by
// the video-text font tests. The runtime's real behaviour belongs to its own
// tests; these fakes only model what the seam promises:
//  - a legacy request never reaches the runtime;
//  - before a font is ready `fontFace` answers its alias with the requested
//    flags, once ready the real face's flags, and a missing font the legacy
//    name with `missing: true`;
//  - `ensureFonts` can be made to resolve late, by hand.
// Usage: vi.mock("<path>/fonts", async () => (await import("<path>/fonts-fake.test-util")).fakeFonts)

import type { FontFaceInfo, FontFamily, FontId, FontRequest } from "../../core/types";

export const fontsState = {
  /** Ids whose faces have loaded. */
  ready: new Set<string>(),
  /** Ids that are not on this PC. */
  missing: new Set<string>(),
  faces: new Map<string, FontFaceInfo[]>(),
  /** Every ensureFonts call, in order. */
  ensureCalls: [] as FontRequest[][],
  /** fontFace calls (a legacy font must never make one). */
  fontFaceCalls: 0,
  /** When true, ensureFonts waits for `release()`. */
  late: false,
  pending: [] as (() => void)[],
  pickers: [] as {
    host: unknown;
    opts: { value(): { legacy: FontFamily; fontId?: FontId }; onPick(v: { legacy: FontFamily; fontId?: FontId }): void };
    disposed: boolean;
  }[],
  reset(): void {
    this.ready.clear();
    this.missing.clear();
    this.faces.clear();
    this.ensureCalls = [];
    this.fontFaceCalls = 0;
    this.late = false;
    this.pending = [];
    this.pickers = [];
  },
  /** Finish every late ensureFonts. */
  release(): void {
    const due = this.pending;
    this.pending = [];
    for (const f of due) f();
  },
};

/** The fake's alias for an id: deterministic, needs no quoting. */
export const alias = (id: string): string => `tf-${id.replace(/[^A-Za-z0-9]/g, "_")}`;

export const face = (bold: boolean, italic: boolean): FontFaceInfo => ({
  bold,
  italic,
  weight: bold ? 700 : 400,
  style: `${bold ? "Bold" : "Regular"}${italic ? " Italic" : ""}`,
  embed: "full",
});

function settle(reqs: FontRequest[]): void {
  for (const r of reqs) if (!fontsState.missing.has(r.id)) fontsState.ready.add(r.id);
}

export const fakeFonts = {
  ensureFonts(reqs: FontRequest[]): Promise<void> {
    fontsState.ensureCalls.push(reqs);
    if (!fontsState.late) {
      settle(reqs);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) =>
      fontsState.pending.push(() => {
        settle(reqs);
        resolve();
      }),
    );
  },
  fontsReady(reqs: FontRequest[]): boolean {
    return reqs.every((r) => fontsState.ready.has(r.id) || fontsState.missing.has(r.id));
  },
  fontFace(legacy: FontFamily, id: FontId | undefined, bold: boolean, italic: boolean) {
    fontsState.fontFaceCalls++;
    if (id === undefined) return { family: legacy, bold, italic, missing: false };
    if (fontsState.missing.has(id)) return { family: legacy, bold, italic, missing: true };
    if (fontsState.ready.has(id)) {
      const f = fontsState.faces.get(id) ?? [face(false, false)];
      return {
        family: alias(id),
        bold: bold && f.some((x) => x.bold),
        italic: italic && f.some((x) => x.italic),
        missing: false,
      };
    }
    return { family: alias(id), bold, italic, missing: false };
  },
  facesOf(id: FontId): FontFaceInfo[] | null {
    return fontsState.faces.get(id) ?? null;
  },
  missingFonts(reqs: FontRequest[]): FontId[] {
    return reqs.filter((r) => fontsState.missing.has(r.id)).map((r) => r.id);
  },
  mountFontPicker(
    host: unknown,
    opts: { value(): { legacy: FontFamily; fontId?: FontId }; onPick(v: { legacy: FontFamily; fontId?: FontId }): void },
  ) {
    const p = { host, opts, disposed: false };
    fontsState.pickers.push(p);
    return {
      refresh() {},
      dispose() {
        p.disposed = true;
      },
    };
  },
};

/* ---------------- fake DOM ---------------- */

type Listener = (e: unknown) => void;

export class FakeEl {
  [k: string]: unknown;
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners = new Map<string, Listener[]>();
  removed = false;
  private picks = new Map<string, FakeEl>();
  constructor(public tag: string) {}
  append(...els: FakeEl[]): void {
    this.children.push(...els);
  }
  prepend(el: FakeEl): void {
    this.children.unshift(el);
  }
  appendChild(el: FakeEl): FakeEl {
    this.children.push(el);
    return el;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string, e: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...e });
  }
  querySelector(sel: string): FakeEl {
    let el = this.picks.get(sel);
    if (!el) this.picks.set(sel, (el = new FakeEl(sel)));
    return el;
  }
  remove(): void {
    this.removed = true;
  }
  focus(): void {}
  select(): void {}
  /** A canvas context that measures like a real one: an alias names a font
   *  whose face is only used once it is READY; until then (and for any other
   *  family) the fallback draws, 10 px per character. The ready font is 30. */
  getContext(): { font: string; measureText(s: string): { width: number } } {
    return {
      font: "",
      measureText(s: string) {
        const loaded = [...fontsState.ready].some((id) => this.font.includes(alias(id)));
        return { width: s.length * (loaded ? 30 : 10) };
      },
    };
  }
  /** Depth-first: the first element `pred` accepts. */
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  button(text: string): FakeEl {
    const hit = this.find((e) => e.tag === "button" && e.textContent === text);
    if (!hit) throw new Error(`no ${text} button`);
    return hit;
  }
}

/** A fake `document` (stubbed globally by the caller's vi.stubGlobal). */
export function fakeDocument(): { doc: FakeEl; body: FakeEl; backdrop(): FakeEl } {
  const body = new FakeEl("body");
  const doc = new FakeEl("document");
  Object.assign(doc, { body, createElement: (tag: string) => new FakeEl(tag) });
  return { doc, body, backdrop: () => body.children[body.children.length - 1]! };
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
