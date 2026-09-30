import { describe, expect, it } from "vitest";
import { IMAGE_BLANK_PRESETS } from "../core/image-project";
import type { MediaInfo } from "../core/types";
import {
  CUSTOM_SIZE,
  DEFAULT_PICK,
  backgroundOf,
  dismissible,
  focusAfterPicker,
  parseCanvasSide,
  photoProblem,
  resolveCanvasSize,
} from "./new-image-dialog";

describe("parseCanvasSide", () => {
  const rows: Array<[raw: string, want: number | null]> = [
    ["641", 641],
    [" 361 ", 361], // stray spaces around a typed number are not a mistake
    ["0640", 640], // nor is a leading zero
    ["1", 1], // the smallest canvas there is
    ["65535", 65535], // the largest one an image project may have
    ["65536", null], // one past it
    ["0", null],
    ["", null],
    ["12.5", null], // never rounded behind the user's back
    ["1e3", null], // Number() would read 1000
    ["-3", null],
    ["0x10", null], // Number() would read 16
    ["1234567", null],
    ["64 0", null],
  ];
  it.each(rows)("%j → %j", (raw, want) => {
    expect(parseCanvasSide(raw)).toBe(want);
  });
});

describe("resolveCanvasSize", () => {
  it("maps every preset to its own size, in order, with nothing swapped", () => {
    IMAGE_BLANK_PRESETS.forEach((p, i) => {
      // The custom fields hold a different, valid size: a preset must ignore them.
      expect(resolveCanvasSize(String(i), "641", "361")).toEqual({ w: p.w, h: p.h });
    });
    // A portrait preset stays portrait: w and h are not read from the wrong field.
    const portrait = IMAGE_BLANK_PRESETS.findIndex((p) => p.h > p.w);
    expect(portrait).toBeGreaterThanOrEqual(0);
    const dims = resolveCanvasSize(String(portrait), "", "")!;
    expect(dims.h).toBeGreaterThan(dims.w);
  });

  it("reads the custom fields only for Custom", () => {
    expect(resolveCanvasSize(CUSTOM_SIZE, "641", "361")).toEqual({ w: 641, h: 361 });
    expect(resolveCanvasSize(CUSTOM_SIZE, "361", "641")).toEqual({ w: 361, h: 641 });
    // A half-typed value left in the hidden fields never blocks a preset.
    expect(resolveCanvasSize("0", "0", "")).toEqual({
      w: IMAGE_BLANK_PRESETS[0]!.w,
      h: IMAGE_BLANK_PRESETS[0]!.h,
    });
  });

  it("has nothing to create when either custom side is not a side", () => {
    expect(resolveCanvasSize(CUSTOM_SIZE, "", "361")).toBeNull();
    expect(resolveCanvasSize(CUSTOM_SIZE, "641", "0")).toBeNull();
    expect(resolveCanvasSize(CUSTOM_SIZE, "641", "65536")).toBeNull();
  });

  it("refuses a choice that is no preset rather than guessing the first one", () => {
    // Number("") is 0 — the first preset — which is exactly the guess refused.
    expect(resolveCanvasSize("", "641", "361")).toBeNull();
    expect(resolveCanvasSize(String(IMAGE_BLANK_PRESETS.length), "641", "361")).toBeNull();
    expect(resolveCanvasSize("1.5", "641", "361")).toBeNull();
    expect(resolveCanvasSize("-1", "641", "361")).toBeNull();
  });
});

describe("backgroundOf", () => {
  it("maps the regulars, ignoring the picked colour", () => {
    expect(backgroundOf("transparent", "#a1b2c3")).toBe("transparent");
    expect(backgroundOf("white", "#a1b2c3")).toBe("#ffffff");
    expect(backgroundOf("black", "#a1b2c3")).toBe("#000000");
  });

  it("uses the picked colour for Colour, normalized", () => {
    expect(backgroundOf("colour", "#A1B2C3")).toBe("#a1b2c3");
    expect(backgroundOf("colour", "#abc")).toBe("#aabbcc");
  });

  it("never lets an unreadable colour into the project", () => {
    expect(backgroundOf("colour", "red; background: url(x)")).toBe(DEFAULT_PICK);
    expect(backgroundOf("colour", "")).toBe(DEFAULT_PICK);
    // The fallback is neither of the regulars beside it.
    expect(DEFAULT_PICK).not.toBe("#ffffff");
    expect(DEFAULT_PICK).not.toBe("#000000");
  });
});

describe("photoProblem", () => {
  function info(over: Partial<MediaInfo>): MediaInfo {
    return {
      path: "D:\\Pictures\\harbour.jpg",
      size: 5_242_880,
      mtimeMs: 1_726_000_000_000,
      kind: "image",
      duration: 0,
      hasAudio: false,
      width: 641,
      height: 361,
      ...over,
    };
  }

  it("accepts a sized still", () => {
    expect(photoProblem(info({}))).toBeNull();
  });

  it("asks for a still when the file is anything else", () => {
    expect(photoProblem(info({ kind: "gif", duration: 3 }))).toBe("Pick a still image.");
    expect(photoProblem(info({ kind: "video", duration: 12 }))).toBe("Pick a still image.");
    expect(photoProblem(info({ kind: "audio", width: undefined, height: undefined }))).toBe(
      "Pick a still image.",
    );
    expect(photoProblem(info({ generator: { type: "solid", color: "#204080" } }))).toBe(
      "Pick a still image.",
    );
  });

  it("names the photo whose size could not be read", () => {
    expect(photoProblem(info({ width: undefined }))).toBe("Couldn't read the size of harbour.");
    expect(photoProblem(info({ height: 0 }))).toBe("Couldn't read the size of harbour.");
    expect(photoProblem(info({ width: Number.NaN }))).toBe("Couldn't read the size of harbour.");
    expect(photoProblem(info({ height: Number.POSITIVE_INFINITY }))).toBe(
      "Couldn't read the size of harbour.",
    );
  });
});

describe("dismissible", () => {
  // Both axes varied: busy alone must not lock the dialog (the OS file picker
  // is still up, nothing is decided), and the picker flag alone means nothing.
  const rows: Array<[busy: boolean, inFilePicker: boolean, want: boolean]> = [
    [false, false, true], // idle: every way out works
    [false, true, true], // (never set without busy; harmless if it were)
    [true, true, true], // "From a photo" waiting on the OS picker: still cancellable
    [true, false, false], // past the picker, writing the project: ignored
  ];
  it.each(rows)("busy=%j inFilePicker=%j → %j", (busy, inFilePicker, want) => {
    expect(dismissible(busy, inFilePicker)).toBe(want);
  });
});

describe("focusAfterPicker", () => {
  // A stand-in for the few Element methods it uses. `closest` walks the node's
  // own chain (itself, then its ancestors) and honours the two selector forms
  // the real one is written in, `tag` and `tag:not(:disabled)`, so a selector
  // that stopped excluding disabled controls would change an answer below.
  interface Ctl {
    name: string;
    tag: string;
    disabled?: boolean;
    inDialog: boolean;
  }
  function matches(c: Ctl, selector: string): boolean {
    return selector.split(",").some((part) => {
      const m = /^\s*([a-z]+)(:not\(:disabled\))?\s*$/.exec(part);
      if (!m) throw new Error(`selector form the stand-in does not model: ${part}`);
      return m[1] === c.tag && !(m[2] && c.disabled);
    });
  }
  function pressed(...chain: Ctl[]): { closest(selector: string): Ctl | null } {
    return { closest: (selector) => chain.find((c) => matches(c, selector)) ?? null };
  }
  const dialog = { contains: (c: Ctl) => c.inDialog };
  const colour: Ctl = { name: "colour", tag: "button", inDialog: true };
  const white: Ctl = { name: "white", tag: "button", inDialog: true };
  const whiteLabel: Ctl = { name: "white-swatch", tag: "span", inDialog: true };
  const size: Ctl = { name: "size", tag: "select", inDialog: true };
  const create: Ctl = { name: "create", tag: "button", disabled: true, inDialog: true };
  const backdrop: Ctl = { name: "backdrop", tag: "div", inDialog: true };
  const done: Ctl = { name: "picker-done", tag: "button", inDialog: false };

  it("follows the click to the control that closed the popover", () => {
    expect(focusAfterPicker(pressed(white, backdrop), dialog, colour).name).toBe("white");
    // A press on the swatch inside the button still means the button.
    expect(focusAfterPicker(pressed(whiteLabel, white, backdrop), dialog, colour).name).toBe("white");
    expect(focusAfterPicker(pressed(size, backdrop), dialog, colour).name).toBe("size");
  });

  it("goes back to Colour for everything else", () => {
    expect(focusAfterPicker(null, dialog, colour).name).toBe("colour"); // Escape, a scroll
    expect(focusAfterPicker(pressed(backdrop), dialog, colour).name).toBe("colour");
    expect(focusAfterPicker(pressed(done), dialog, colour).name).toBe("colour"); // the popover's own Done
    // A disabled Create cannot take focus: handing it there would strand the
    // Tab trap on <body>.
    expect(focusAfterPicker(pressed(create, backdrop), dialog, colour).name).toBe("colour");
  });
});
