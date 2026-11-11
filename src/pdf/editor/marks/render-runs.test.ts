// Style runs on the saved text box (0.9.4): invariant R1 (a box WITHOUT runs
// renders exactly as before: the DOM, the lines and the height were captured
// from the 0.9.3 code before the runs work and are pinned here verbatim), and
// the run render itself (spans per piece, rows by the CSS inline model, run
// fonts loaded and refilled). The font runtime is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnot } from "../../../core/types";
import { FakeElement, FakeText, installFakeDom } from "../fake-dom.test-util";

const f = vi.hoisted(() => ({
  ready: new Set<string>(),
  missing: new Set<string>(),
  ensureCalls: [] as string[][],
  releases: [] as (() => void)[],
}));
vi.mock("../../../fonts", () => ({
  ensureFonts: (reqs: { id: string; bold: boolean; italic: boolean }[]) => {
    f.ensureCalls.push(reqs.map((r) => `${r.id}${r.bold ? "B" : ""}${r.italic ? "I" : ""}`));
    return new Promise<void>((res) => {
      f.releases.push(() => {
        for (const r of reqs) f.ready.add(r.id);
        res();
      });
    });
  },
  fontsReady: (reqs: { id: string }[]) => reqs.every((r) => f.ready.has(r.id)),
  fontFace: (legacy: string, id: string, bold: boolean, italic: boolean) =>
    f.missing.has(id) ? { family: legacy, bold, italic, missing: true } : { family: `tf-${id}`, bold, italic, missing: false },
  onFontsChanged: () => () => {},
}));

// D3: counts every element read from a segment list the render gets, when on
const seg = vi.hoisted(() => ({ count: false, visits: 0 }));
vi.mock("../../../core/pdf-runs", async (orig) => {
  const real = await orig<typeof import("../../../core/pdf-runs")>();
  return {
    ...real,
    segmentsOf: (...args: Parameters<typeof real.segmentsOf>) => {
      const list = real.segmentsOf(...args);
      if (!seg.count) return list;
      return new Proxy(list, {
        get(t, k, r) {
          if (typeof k === "string" && /^\d+$/.test(k)) seg.visits++;
          return Reflect.get(t, k, r);
        },
      });
    },
  };
});

const { markNode, setTextMeasurer, textBoxHeight, textLines, textRows, styleRunSpan } = await import("./render");
const { textHeight } = await import("./geom");

type Text = Extract<PdfAnnot, { t: "text" }>;
const ID_A = "f-0123456789abcdef" as Text["fontId"] & string;

/** Widths that differ per font, size, weight and character. */
const measurer = {
  width: (font: string, s: string) => {
    const k = 4 + (font.length % 5) + (font.includes("bold") ? 1.5 : 0);
    let w = 0;
    for (const ch of s) w += ch === " " ? k * 0.5 : ch === "W" ? k * 1.75 : k;
    return w;
  },
  // ascent / descent: per family and size, never in the 0.8 / 0.2 ratio
  vertical: (font: string) => {
    const size = parseFloat(font.replace(/^[^\d]*/, "")) || 12;
    const tall = font.includes("Georgia") ? 0.93 : font.includes("tf-") ? 1.05 : 0.86;
    return { asc: size * tall, desc: size * (font.includes("Georgia") ? 0.27 : 0.21) };
  },
};

beforeEach(() => {
  const { doc } = installFakeDom((n, v) => vi.stubGlobal(n, v));
  (doc as unknown as { createElementNS: unknown }).createElementNS = (_ns: string, tag: string) => new FakeElement(tag);
  setTextMeasurer(measurer);
  f.ready = new Set();
  f.missing = new Set();
  f.ensureCalls = [];
  f.releases = [];
});
afterEach(() => {
  setTextMeasurer(null);
  vi.unstubAllGlobals();
});

/** The whole rendered structure: tags, attributes, classes, styles, text. */
function dump(n: unknown): unknown {
  if (n instanceof FakeText) return n.data;
  const e = n as FakeElement;
  const attrs = (e as unknown as { attrs: Map<string, string> }).attrs;
  const style: Record<string, string> = {};
  for (const k of Object.keys(e.style)) if (typeof e.style[k] === "string") style[k] = e.style[k]!;
  return {
    tag: e.tagName,
    cls: e.className,
    attrs: Object.fromEntries(attrs),
    style,
    kids: e.childNodes.map(dump),
  };
}

const box = (extra: Partial<Text> = {}): Text => ({
  id: "t", t: "text", x: 10, y: 20, w: 70, h: 40, text: "hello wide world", font: "Arial", size: 10, c: "#123456", bold: false, italic: false, align: "left", ...extra,
});

const R1_BOXES: Text[] = [
  box(),
  box({ font: "Georgia", size: 14, bold: true, align: "right", text: "Wide words\n\nwrap WWWWWWWWWWWWWW here" }),
  box({ font: "Courier New", size: 7.5, italic: true, align: "center", bg: "#fff3a0", border: "#000000", text: "one\ntwo three four five six" }),
  box({ text: "שלום עולם abc\nabc שלום", size: 12, r: 90 }),
  box({ font: "Impact", bold: true, italic: true, text: "x" }),
  box({ text: "" }),
];

describe("R1: a box without runs renders exactly as before", () => {
  it("the DOM, the lines and the height of run-less boxes (captured from 0.9.3)", () => {
    const got = R1_BOXES.map((a) => ({
      dom: dump(markNode(a, [], (p) => p)),
      lines: textLines(a).map((l) => ({ text: l.text, row: l.row, rtl: l.rtl })),
      h: textBoxHeight(a),
    }));
    expect(got).toMatchInlineSnapshot(`
      [
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "40",
              "width": "70",
              "x": "10",
              "y": "20",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "hello wide",
                    ],
                    "style": {
                      "height": "12.5px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "world",
                    ],
                    "style": {
                      "height": "12.5px",
                      "top": "12.5px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "transparent",
                  "boxShadow": "none",
                  "color": "#123456",
                  "fontFamily": ""Arial"",
                  "fontSize": "10px",
                  "fontStyle": "normal",
                  "fontWeight": "normal",
                  "lineHeight": "12.5px",
                  "textAlign": "left",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 25,
          "lines": [
            {
              "row": 0,
              "rtl": false,
              "text": "hello wide",
            },
            {
              "row": 1,
              "rtl": false,
              "text": "world",
            },
          ],
        },
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "40",
              "width": "70",
              "x": "10",
              "y": "20",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "Wide",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "words",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "17.5px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [],
                    "style": {
                      "height": "17.5px",
                      "top": "35px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "wrap",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "52.5px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "WWWW",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "70px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "WWWW",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "87.5px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "WWWW",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "105px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "WW",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "122.5px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "here",
                    ],
                    "style": {
                      "height": "17.5px",
                      "top": "140px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "transparent",
                  "boxShadow": "none",
                  "color": "#123456",
                  "fontFamily": ""Georgia"",
                  "fontSize": "14px",
                  "fontStyle": "normal",
                  "fontWeight": "bold",
                  "lineHeight": "17.5px",
                  "textAlign": "right",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 157.5,
          "lines": [
            {
              "row": 0,
              "rtl": false,
              "text": "Wide",
            },
            {
              "row": 1,
              "rtl": false,
              "text": "words",
            },
            {
              "row": 2,
              "rtl": false,
              "text": "",
            },
            {
              "row": 3,
              "rtl": false,
              "text": "wrap",
            },
            {
              "row": 4,
              "rtl": false,
              "text": "WWWW",
            },
            {
              "row": 5,
              "rtl": false,
              "text": "WWWW",
            },
            {
              "row": 6,
              "rtl": false,
              "text": "WWWW",
            },
            {
              "row": 7,
              "rtl": false,
              "text": "WW",
            },
            {
              "row": 8,
              "rtl": false,
              "text": "here",
            },
          ],
        },
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "40",
              "width": "70",
              "x": "10",
              "y": "20",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "one",
                    ],
                    "style": {
                      "height": "9.375px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "two three four",
                    ],
                    "style": {
                      "height": "9.375px",
                      "top": "9.375px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "five six",
                    ],
                    "style": {
                      "height": "9.375px",
                      "top": "18.75px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "#fff3a0",
                  "boxShadow": "inset 0 0 0 1px #000000",
                  "color": "#123456",
                  "fontFamily": ""Courier New"",
                  "fontSize": "7.5px",
                  "fontStyle": "italic",
                  "fontWeight": "normal",
                  "lineHeight": "9.375px",
                  "textAlign": "center",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 28.125,
          "lines": [
            {
              "row": 0,
              "rtl": false,
              "text": "one",
            },
            {
              "row": 1,
              "rtl": false,
              "text": "two three four",
            },
            {
              "row": 2,
              "rtl": false,
              "text": "five six",
            },
          ],
        },
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "70",
              "transform": "rotate(-90 45 40)",
              "width": "40",
              "x": "25",
              "y": "5",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "rtl",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "שלום",
                    ],
                    "style": {
                      "height": "15px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "rtl",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "עולם",
                    ],
                    "style": {
                      "height": "15px",
                      "top": "15px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "rtl",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "abc",
                    ],
                    "style": {
                      "height": "15px",
                      "top": "30px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "abc",
                    ],
                    "style": {
                      "height": "15px",
                      "top": "45px",
                    },
                    "tag": "DIV",
                  },
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "שלום",
                    ],
                    "style": {
                      "height": "15px",
                      "top": "60px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "transparent",
                  "boxShadow": "none",
                  "color": "#123456",
                  "fontFamily": ""Arial"",
                  "fontSize": "12px",
                  "fontStyle": "normal",
                  "fontWeight": "normal",
                  "lineHeight": "15px",
                  "textAlign": "left",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 75,
          "lines": [
            {
              "row": 0,
              "rtl": true,
              "text": "שלום",
            },
            {
              "row": 1,
              "rtl": true,
              "text": "עולם",
            },
            {
              "row": 2,
              "rtl": true,
              "text": "abc",
            },
            {
              "row": 3,
              "rtl": false,
              "text": "abc",
            },
            {
              "row": 4,
              "rtl": false,
              "text": "שלום",
            },
          ],
        },
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "40",
              "width": "70",
              "x": "10",
              "y": "20",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [
                      "x",
                    ],
                    "style": {
                      "height": "12.5px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "transparent",
                  "boxShadow": "none",
                  "color": "#123456",
                  "fontFamily": ""Impact"",
                  "fontSize": "10px",
                  "fontStyle": "normal",
                  "fontWeight": "normal",
                  "lineHeight": "12.5px",
                  "textAlign": "left",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 12.5,
          "lines": [
            {
              "row": 0,
              "rtl": false,
              "text": "x",
            },
          ],
        },
        {
          "dom": {
            "attrs": {
              "data-id": "t",
              "height": "40",
              "width": "70",
              "x": "10",
              "y": "20",
            },
            "cls": "",
            "kids": [
              {
                "attrs": {},
                "cls": "pdfmk-text",
                "kids": [
                  {
                    "attrs": {
                      "dir": "ltr",
                    },
                    "cls": "pdfmk-text__line",
                    "kids": [],
                    "style": {
                      "height": "12.5px",
                      "top": "0px",
                    },
                    "tag": "DIV",
                  },
                ],
                "style": {
                  "backgroundColor": "transparent",
                  "boxShadow": "none",
                  "color": "#123456",
                  "fontFamily": ""Arial"",
                  "fontSize": "10px",
                  "fontStyle": "normal",
                  "fontWeight": "normal",
                  "lineHeight": "12.5px",
                  "textAlign": "left",
                },
                "tag": "DIV",
              },
            ],
            "style": {},
            "tag": "FOREIGNOBJECT",
          },
          "h": 12.5,
          "lines": [
            {
              "row": 0,
              "rtl": false,
              "text": "",
            },
          ],
        },
      ]
    `);
  });

  it("a non-legacy font box, loading then ready (captured from 0.9.3)", () => {
    const a = box({ fontId: ID_A, bold: true });
    const fo = markNode(a, [], (p) => p);
    expect(f.ensureCalls.length).toBeGreaterThan(0);
    f.ready.add(ID_A);
    const fo2 = markNode(a, [], (p) => p);
    expect([dump(fo), dump(fo2), textBoxHeight(a)]).toMatchInlineSnapshot(`
      [
        {
          "attrs": {
            "data-id": "t",
            "height": "40",
            "width": "70",
            "x": "10",
            "y": "20",
          },
          "cls": "",
          "kids": [
            {
              "attrs": {},
              "cls": "pdfmk-text",
              "kids": [
                {
                  "attrs": {
                    "dir": "ltr",
                  },
                  "cls": "pdfmk-text__line",
                  "kids": [
                    "hello wide",
                  ],
                  "style": {
                    "height": "12.5px",
                    "top": "0px",
                  },
                  "tag": "DIV",
                },
                {
                  "attrs": {
                    "dir": "ltr",
                  },
                  "cls": "pdfmk-text__line",
                  "kids": [
                    "world",
                  ],
                  "style": {
                    "height": "12.5px",
                    "top": "12.5px",
                  },
                  "tag": "DIV",
                },
              ],
              "style": {
                "backgroundColor": "transparent",
                "boxShadow": "none",
                "color": "#123456",
                "fontFamily": "tf-f-0123456789abcdef, "Arial"",
                "fontSize": "10px",
                "fontStyle": "normal",
                "fontWeight": "bold",
                "lineHeight": "12.5px",
                "textAlign": "left",
              },
              "tag": "DIV",
            },
          ],
          "style": {},
          "tag": "FOREIGNOBJECT",
        },
        {
          "attrs": {
            "data-id": "t",
            "height": "40",
            "width": "70",
            "x": "10",
            "y": "20",
          },
          "cls": "",
          "kids": [
            {
              "attrs": {},
              "cls": "pdfmk-text",
              "kids": [
                {
                  "attrs": {
                    "dir": "ltr",
                  },
                  "cls": "pdfmk-text__line",
                  "kids": [
                    "hello wide",
                  ],
                  "style": {
                    "height": "12.5px",
                    "top": "0px",
                  },
                  "tag": "DIV",
                },
                {
                  "attrs": {
                    "dir": "ltr",
                  },
                  "cls": "pdfmk-text__line",
                  "kids": [
                    "world",
                  ],
                  "style": {
                    "height": "12.5px",
                    "top": "12.5px",
                  },
                  "tag": "DIV",
                },
              ],
              "style": {
                "backgroundColor": "transparent",
                "boxShadow": "none",
                "color": "#123456",
                "fontFamily": "tf-f-0123456789abcdef, "Arial"",
                "fontSize": "10px",
                "fontStyle": "normal",
                "fontWeight": "bold",
                "lineHeight": "12.5px",
                "textAlign": "left",
              },
              "tag": "DIV",
            },
          ],
          "style": {},
          "tag": "FOREIGNOBJECT",
        },
        25,
      ]
    `);
  });
});

/* ------------------------------------------------------------------ */
/* A box with runs                                                     */
/* ------------------------------------------------------------------ */

/** Widths in proportion to size; bold and Georgia wider; a space a quarter
 *  em. Ascent / descent differ per family. */
const runMeasurer = {
  width: (font: string, s: string) => {
    const size = parseFloat(font.replace(/^[^\d]*/, "")) || 12;
    const k = 0.5 + (/(^| )bold /.test(font) ? 0.1 : 0) + (font.includes("Georgia") ? 0.05 : 0);
    let w = 0;
    for (const ch of s) w += ch === " " ? size * 0.25 : size * k;
    return w;
  },
  vertical: (font: string) => {
    const size = parseFloat(font.replace(/^[^\d]*/, "")) || 12;
    if (font.includes("Georgia")) return { asc: size * 0.95, desc: size * 0.27 };
    if (font.includes("tf-")) return { asc: size * 1.05, desc: size * 0.3 };
    return { asc: size * 0.9, desc: size * 0.21 };
  },
};

const lineDivs = (a: Text): FakeElement[] => (markNode(a, [], (p) => p) as unknown as FakeElement).children[0]!.children;
const spansOf = (div: FakeElement) =>
  div.children.map((s) => ({ text: s.textContent, size: s.style.fontSize, weight: s.style.fontWeight, family: s.style.fontFamily, color: s.style.color }));

describe("a saved box with style runs", () => {
  beforeEach(() => setTextMeasurer(runMeasurer));

  // "hello " 27.5 + "big" bold 20 pt 36 = 63.5 fits 90; + " world" does not
  const big = (): Text => box({ text: "hello big world", w: 90, runs: [{ s: 6, e: 9, bold: true, size: 20 }] });

  it("one span per piece, in the right lines, with each line's s / e", () => {
    const a = big();
    expect(textLines(a).map((l) => [l.text, l.s, l.e, l.row])).toEqual([
      ["hello big", 0, 9, 0],
      ["world", 10, 15, 1],
    ]);
    expect(lineDivs(a).map(spansOf)).toEqual([
      [
        { text: "hello ", size: "10px", weight: "normal", family: '"Arial"', color: "#123456" },
        { text: "big", size: "20px", weight: "bold", family: '"Arial"', color: "#123456" },
      ],
      [{ text: "world", size: "10px", weight: "normal", family: '"Arial"', color: "#123456" }],
    ]);
    // the box keeps the base style: each line's strut
    const boxEl = (markNode(a, [], (p) => p) as unknown as FakeElement).children[0]!;
    expect([boxEl.style.fontSize, boxEl.style.lineHeight]).toEqual(["10px", "12.5px"]);
  });

  it("a row with a larger piece is taller and its baseline follows the largest ascent", () => {
    const a = big();
    // base 10 pt: A = (12.5 - 11.1) / 2 + 9 = 9.7; big 20 pt: A = (25 - 22.2) / 2 + 18 = 19.4
    const rows = textRows(a);
    expect(rows.map((r) => r.height)).toEqual([25, 12.5]);
    expect(rows[0]!.baseline).toBeCloseTo(19.4, 9);
    expect(rows[1]!.baseline).toBeCloseTo(9.7, 9);
    expect(rows.map((r) => r.top)).toEqual([0, 25]);
    expect(lineDivs(a).map((d) => [d.style.top, d.style.height])).toEqual([
      ["0px", "25px"],
      ["25px", "12.5px"],
    ]);
  });

  it("a deeper-descent font at the base size: the row takes the strut's ascent and the piece's descent", () => {
    // strut Arial 10: A 9.7, D 2.8; Georgia 10: A = (12.5 - 12.2) / 2 + 9.5 = 9.65, D = 2.85
    const a = box({ text: "ab cd", runs: [{ s: 3, e: 5, font: "Georgia" }] });
    const r = textRows(a)[0]!;
    expect(r.baseline).toBeCloseTo(9.7, 9);
    expect(r.height).toBeCloseTo(9.7 + 2.85, 9);
  });

  it("a run smaller than the base does not shrink its row", () => {
    const a = box({ text: "tiny", size: 20, runs: [{ s: 0, e: 4, size: 6 }] });
    expect(textRows(a).map((r) => r.height)).toEqual([25]);
    expect(textBoxHeight(a)).toBe(25);
  });

  it("a word spanning two styles wraps by the sum of its pieces", () => {
    // "ab " 12.5; "cd" 10 + "ef" (bold 20) 24 = 34: 46.5 > 40 wraps; in the
    // base style alone "cdef" is 20 and the line would fit (32.5)
    const a = box({ text: "ab cdef", w: 40, runs: [{ s: 5, e: 7, bold: true, size: 20 }] });
    expect(textLines(a).map((l) => [l.text, l.s, l.e])).toEqual([
      ["ab", 0, 2],
      ["cdef", 3, 7],
    ]);
    expect(textLines(box({ text: "ab cdef", w: 40 })).map((l) => l.text)).toEqual(["ab cdef"]);
    expect(lineDivs(a)[1]!.children.map((s) => s.textContent)).toEqual(["cd", "ef"]);
  });

  it("paragraph breaks inside a run: each paragraph's lines, offsets into the whole text", () => {
    const a = box({ text: "ab\r\ncd\nef", runs: [{ s: 1, e: 8, c: "#ff0000" }] });
    expect(textLines(a).map((l) => [l.text, l.s, l.e])).toEqual([
      ["ab", 0, 2],
      ["cd", 4, 6],
      ["ef", 7, 9],
    ]);
    expect(lineDivs(a).map((d) => d.children.map((s) => [s.textContent, s.style.color]))).toEqual([
      [["a", "#123456"], ["b", "#ff0000"]],
      [["cd", "#ff0000"]],
      [["e", "#ff0000"], ["f", "#123456"]],
    ]);
  });

  it("textBoxHeight: exactly textHeight for a box without runs, the row sum with runs", () => {
    // 3 rows of 10.7 pt: 3 × 13.375 summed is 40.125, textHeight 40.12499…
    const plain = box({ text: "a\nb\nc", size: 10.7 });
    expect(textBoxHeight(plain)).toBe(textHeight(3, 10.7));
    expect(textBoxHeight(plain)).not.toBe(13.375 + 13.375 + 13.375);
    const runs = box({ text: "a\nb\nc", size: 10.7, runs: [{ s: 2, e: 3, size: 21.4 }] });
    expect(textRows(runs).map((r) => r.height)).toEqual([13.375, 26.75, 13.375]);
    expect(textBoxHeight(runs)).toBe(13.375 + 26.75 + 13.375);
    // runs that change nothing are no runs (the 0.9.3 path)
    expect(textBoxHeight(box({ text: "a\nb\nc", size: 10.7, runs: [{ s: 0, e: 1, size: 10.7 }] }))).toBe(textHeight(3, 10.7));
  });

  it("right-to-left: the line takes its paragraph's direction, the spans are plain (no isolation)", () => {
    const a = box({ text: "שלום abc", w: 200, runs: [{ s: 5, e: 8, bold: true }] });
    const div = lineDivs(a)[0]!;
    expect(div.getAttribute("dir")).toBe("rtl");
    expect(div.children.map((s) => s.textContent)).toEqual(["שלום ", "abc"]);
    for (const s of div.children) {
      expect(s.getAttribute("dir")).toBeNull();
      expect(s.style.unicodeBidi ?? "").toBe("");
    }
  });

  it("styleRunSpan: family (alias first), size, weight, style, colour, line height", () => {
    const s = document.createElement("span") as unknown as FakeElement;
    const el = s as unknown as HTMLElement;
    styleRunSpan(el, { font: "Georgia", size: 14, c: "#abcdef", bold: true, italic: true });
    expect([s.style.fontFamily, s.style.fontSize, s.style.fontWeight, s.style.fontStyle, s.style.color, s.style.lineHeight]).toEqual([
      '"Georgia"',
      "14px",
      "bold",
      "italic",
      "#abcdef",
      "17.5px",
    ]);
    styleRunSpan(el, { font: "Impact", size: 8, c: "url(x)", bold: true, italic: true });
    expect([s.style.fontWeight, s.style.fontStyle, s.style.color]).toEqual(["normal", "normal", "#000000"]);
    styleRunSpan(el, { font: "Arial", fontId: ID_A, size: 8, c: "#000000", bold: false, italic: false });
    expect(s.style.fontFamily).toBe(`tf-${ID_A}, "Arial"`);
  });

  it("a run font still loading: its load starts and the box refills when it lands", async () => {
    const a = box({ text: "hello big", w: 200, runs: [{ s: 6, e: 9, font: "Arial", fontId: ID_A }] });
    const fo = markNode(a, [], (p) => p) as unknown as FakeElement;
    new FakeElement("svg").appendChild(fo);
    expect(f.ensureCalls.some((c) => c.includes(ID_A))).toBe(true);
    const before = fo.children[0]!.children[0]!;
    expect(before.children[1]!.style.fontFamily).toBe(`tf-${ID_A}, "Arial"`);
    for (const r of f.releases.splice(0)) r();
    await new Promise((r) => setTimeout(r, 0));
    const after = fo.children[0]!.children[0]!;
    expect(after).not.toBe(before);
    expect(after.children.map((s) => s.textContent)).toEqual(["hello ", "big"]);
  });

  it("a legacy box whose runs are legacy too makes no font call", () => {
    markNode(box({ text: "hello big", runs: [{ s: 6, e: 9, font: "Georgia", bold: true }] }), [], (p) => p);
    expect(f.ensureCalls).toEqual([]);
  });
});

describe("screen layout of a box with many lines and many runs (D3)", () => {
  it("walks the segments forward: visits grow with lines + segments, not their product", () => {
    // 400 paragraphs "ab": every "a" bold -> 800 segments, 400 lines
    const N = 400;
    const text = Array.from({ length: N }, () => "ab").join("\n");
    const runs = Array.from({ length: N }, (_, i) => ({ s: i * 3, e: i * 3 + 1, bold: true }));
    const a = box({ text, w: 400, runs });
    seg.visits = 0;
    seg.count = true;
    try {
      expect(textLines(a)).toHaveLength(N);
      textBoxHeight(a);
      markNode(a, [], (p) => p);
    } finally {
      seg.count = false;
    }
    const S = 2 * N;
    // three layouts (lines; lines + rows; lines + rows + spans): a few
    // visits per segment and line each; the old per-line scans read S * N
    expect(seg.visits).toBeGreaterThan(0);
    expect(seg.visits).toBeLessThan(30 * (S + N));
  });
});
