// Preview <-> export geometry parity.
//
// The same placement math exists TWICE: `computeTransformInto` here in
// `src/editor/preview/transforms.ts`, and `placement()` in
// `src-tauri/src/export/builder.rs`. Both files carry a comment claiming they
// mirror each other, and until this test nothing checked it — which is exactly
// how GitHub issue #1 shipped: the preview and the export disagreed about a
// generator's size for months and the suite could not see it.
//
// THE GOLDEN TABLE IS SHARED. `preview-export-parity.json` sits next to this
// file and is read by TWO suites:
//   * vitest, here, through the real `computeTransform`;
//   * cargo, in `src-tauri/src/export/builder.rs` `mod tests`
//     (`placement_matches_the_shared_preview_parity_table`), which pulls it in
//     with `include_str!("../../../src/editor/preview/preview-export-parity.json")`.
// Moving or renaming the JSON therefore breaks the RUST BUILD, not just this
// test. That is deliberate: the two sides must not be able to drift apart
// quietly.
//
// The table was generated from the TypeScript side (see "reference
// implementation" below) and is committed as-is. If a row ever fails, the
// fixture is not the suspect — one of the two implementations moved.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeTransform } from "./transforms";
import type { ClipCrop, ClipTransform } from "../../core/types";

/* ------------------------------------------------------------------ */
/* Reference implementation                                            */
/* ------------------------------------------------------------------ */
//
// The expected values were produced by running THIS file's `computeTransform`
// over the input rows, because the preview is the arbiter of correctness:
//   * builder.rs's own header says its chain "mirrors
//     src/editor/preview/transforms.ts ... exactly so the export matches the
//     preview" — the preview is named as the original, the export as the copy;
//   * it is what the user sees while editing, so any disagreement is by
//     definition an export bug;
//   * it is pure floating-point, while the export additionally discretises to
//     integers. Generating from the continuous side and checking the derived
//     integer side tests the derivation; the reverse would bake the export's
//     rounding into the "truth" and could not detect it drifting.
//
// The `out` integers (dw/dh/ox/oy) are what ffmpeg actually receives, so they
// follow the EXPORT's rounding conventions, reproduced below. They are not a
// second opinion — they are the documented, checkable consequence of the
// preview's floats, and both suites re-derive them independently.
//
// TWO BOXES, NOT ONE. A row carries a project canvas (`canvasW/H`) AND an
// export resolution (`exportW/H`); they coincide only for the "Original"
// preset. The table conflated them until an export at any other resolution was
// found to mis-place every off-centre clip: x/y are authored in canvas px and
// were being added straight to an output-px centring term, so a clip at x=307
// on a 1080p canvas landed 102 px off at 720p and 307 px off at 2160p — while a
// centred clip stayed exact at every resolution, which is why a table with one
// box per row could not see it.

/** ffmpeg/Rust `f64::round()`: ties go AWAY from zero. JS `Math.round()` breaks
 *  ties toward +Infinity, so `Math.round(-0.5)` is -0 where Rust gives -1. The
 *  table's `negative-half-offset-rounds-away-from-zero` row lands on exactly
 *  -0.5 to pin that difference; using `Math.round` here fails it. */
const roundAway = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));

/** Mirrors builder.rs `round_even`: round, then step to the next even integer
 *  toward zero. yuv420p needs even dimensions, so the export cannot use the
 *  preview's exact float extent. */
const roundEven = (v: number): number => {
  const n = roundAway(v);
  return n - (n % 2);
};

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

interface ParityCase {
  name: string;
  why: string;
  in: {
    mediaW: number | null;
    mediaH: number | null;
    /** the PROJECT canvas: the px space x/y and the crop rect are authored in */
    canvasW: number;
    canvasH: number;
    /** the EXPORT resolution: the px space ffmpeg is spoken to in */
    exportW: number;
    exportH: number;
    rotate: 0 | 90 | 180 | 270;
    flipH: boolean;
    flipV: boolean;
    crop: ClipCrop | null;
    scale: number;
    x: number;
    y: number;
  };
  out: {
    /** even-rounded display size, OUTPUT px — ffmpeg `scale=dw:dh` */
    dw: number;
    dh: number;
    /** integer overlay position, OUTPUT px — ffmpeg `overlay=ox:oy` */
    ox: number;
    oy: number;
    /** the preview's exact, un-rounded display extent in project px */
    dwExact: number;
    dhExact: number;
    /** the same extent with the fit measured against the EXPORT box, which is
     *  what the export scales to. Equal to dwExact/dhExact at "Original". */
    dwExactOut: number;
    dhExactOut: number;
    /** the preview's media shift that exposes the crop window */
    offXExact: number;
    offYExact: number;
    /** fit * userScale, project px per source px */
    k: number;
    /** pre-crop source dims — what a generator must be synthesized at */
    srcW: number;
    srcH: number;
    /** post-crop source dims — what sizes the opacity alpha mask */
    postCropW: number;
    postCropH: number;
    /** ffmpeg `crop=cw:ch:cx:cy`, or null when it would not narrow anything */
    cropFilter: [number, number, number, number] | null;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const TABLE: { cases: ParityCase[] } = JSON.parse(
  readFileSync(resolve(here, "preview-export-parity.json"), "utf8"),
);

const transformOf = (i: ParityCase["in"]): ClipTransform => ({
  rotate: i.rotate,
  flipH: i.flipH,
  flipV: i.flipV,
  scale: i.scale,
  x: i.x,
  y: i.y,
  opacity: 1,
  ...(i.crop ? { crop: i.crop } : {}),
});

/** The PREVIEW: the reference math with the project canvas as its box. Media
 *  dims are left absent when the row omits them, so the `?? project.width`
 *  fallback is genuinely exercised. */
const run = (c: ParityCase) => {
  const i = c.in;
  const media: { width?: number; height?: number } = {};
  if (i.mediaW !== null) media.width = i.mediaW;
  if (i.mediaH !== null) media.height = i.mediaH;
  return computeTransform(transformOf(i), media, { width: i.canvasW, height: i.canvasH });
};

/** The SAME reference math evaluated in the export box, which is what
 *  builder.rs `placement` does: it measures `fit` against the output
 *  resolution, so the media scales with the resolution by itself.
 *
 *  The media dims are pinned rather than left absent: srcW/srcH fall back to
 *  the PROJECT canvas in both implementations (an unknown-size media is
 *  canvas-sized to the preview), and letting this call's box supply them would
 *  silently move that fallback into the export space. */
const runAtExportRes = (c: ParityCase) => {
  const i = c.in;
  return computeTransform(
    transformOf(i),
    { width: i.mediaW ?? i.canvasW, height: i.mediaH ?? i.canvasH },
    { width: i.exportW, height: i.exportH },
  );
};

/** Project-canvas px -> output px, per axis. */
const ratio = (c: ParityCase) => ({
  sx: c.in.exportW / c.in.canvasW,
  sy: c.in.exportH / c.in.canvasH,
});

describe("preview/export placement parity (shared golden table)", () => {
  for (const c of TABLE.cases) {
    describe(c.name, () => {
      it("preview geometry matches the table", () => {
        const p = run(c);
        // exact: the fixture came from this function, so a float mismatch means
        // the preview math itself changed.
        expect(p.cropW).toBe(c.out.dwExact);
        expect(p.cropH).toBe(c.out.dhExact);
        expect(p.offX).toBe(c.out.offXExact);
        expect(p.offY).toBe(c.out.offYExact);
        expect(p.k).toBe(c.out.k);
        // the full frame scales with the crop window
        expect(p.mediaW).toBeCloseTo(c.out.srcW * p.k, 9);
        expect(p.mediaH).toBeCloseTo(c.out.srcH * p.k, 9);
      });

      it("rotate / flips / position pass through untouched", () => {
        const p = run(c);
        expect(p.rotate).toBe(c.in.rotate);
        expect(p.flipH).toBe(c.in.flipH);
        expect(p.flipV).toBe(c.in.flipV);
        expect(p.posX).toBe(c.in.x);
        expect(p.posY).toBe(c.in.y);
      });

      it("the export box scales the media by itself", () => {
        // `fit` is measured against the OUTPUT resolution, so the displayed
        // extent needs no ratio applied to it — it comes out of the same
        // reference function, just evaluated in the other box. At "Original"
        // this is the preview's own extent.
        const q = runAtExportRes(c);
        expect(q.cropW).toBe(c.out.dwExactOut);
        expect(q.cropH).toBe(c.out.dhExactOut);
      });

      it("discretises to the integers the export emits", () => {
        const p = run(c);
        const q = runAtExportRes(c);
        const { sx, sy } = ratio(c);
        expect(roundEven(q.cropW)).toBe(c.out.dw);
        expect(roundEven(q.cropH)).toBe(c.out.dh);
        // The export centres the EVEN-rounded box, exactly as builder.rs does:
        //   ox = round((exportW - dw) / 2 + x * exportW/canvasW)
        // The centring term is output px and posX is CANVAS px: the ratio is
        // what converts between them, and dropping it is the bug this axis
        // exists to catch.
        expect(roundAway((c.in.exportW - c.out.dw) / 2 + p.posX * sx)).toBe(c.out.ox);
        expect(roundAway((c.in.exportH - c.out.dh) / 2 + p.posY * sy)).toBe(c.out.oy);
      });

      it("the integer export position stays within a pixel and a quarter of the preview", () => {
        const p = run(c);
        const q = runAtExportRes(c);
        const { sx, sy } = ratio(c);
        // The preview positions the crop box continuously (CSS translate
        // -50%,-50%); the export must land on integers with even extents. The
        // worst case is bounded, and this pins the bound rather than trusting
        // it: round_even moves the extent by < 1.5 px, halved by the centring
        // (< 0.75), plus the final round (<= 0.5) → < 1.25 px. Measured in
        // OUTPUT px — the tolerance is about rounding, not about resolution.
        const previewLeft = (c.in.exportW - q.cropW) / 2 + p.posX * sx;
        const previewTop = (c.in.exportH - q.cropH) / 2 + p.posY * sy;
        expect(Math.abs(c.out.ox - previewLeft)).toBeLessThan(1.25);
        expect(Math.abs(c.out.oy - previewTop)).toBeLessThan(1.25);
        expect(Math.abs(c.out.dw - q.cropW)).toBeLessThan(1.5);
        expect(Math.abs(c.out.dh - q.cropH)).toBeLessThan(1.5);
      });

      it("source and crop-window sizes match the ones the export chain uses", () => {
        const p = run(c);
        // Issue #1 lived here: `srcW/srcH` is what a generator is synthesized
        // at and `postCropW/H` is what sizes the opacity alpha mask. If those
        // two disagree with the preview, alphamerge aborts the export.
        // The fallback box is the PROJECT CANVAS, never the export resolution:
        // source px are source px, and the crop rect is clamped against them.
        expect(c.out.srcW).toBe(c.in.mediaW ?? c.in.canvasW);
        expect(c.out.srcH).toBe(c.in.mediaH ?? c.in.canvasH);
        // The preview expresses the crop window as a display box; dividing out
        // k recovers the source-pixel rect the export passes to `crop=`.
        expect(Math.round(p.cropW / p.k)).toBe(c.out.postCropW);
        expect(Math.round(p.cropH / p.k)).toBe(c.out.postCropH);
        // `+ 0` normalises IEEE negative zero (offX is -0 when crop.x is 0),
        // which Object.is-based matchers treat as distinct from 0.
        const cropX = Math.round(-p.offX / p.k) + 0;
        const cropY = Math.round(-p.offY / p.k) + 0;
        if (c.out.cropFilter === null) {
          // no narrowing → the export emits no crop filter at all
          expect(cropX).toBe(0);
          expect(cropY).toBe(0);
          expect(c.out.postCropW).toBe(c.out.srcW);
          expect(c.out.postCropH).toBe(c.out.srcH);
        } else {
          expect([c.out.postCropW, c.out.postCropH, cropX, cropY]).toEqual(
            c.out.cropFilter,
          );
        }
      });
    });
  }
});

/* ------------------------------------------------------------------ */
/* Guard: the table must not be able to decay into a no-op            */
/* ------------------------------------------------------------------ */
//
// Issue #1's real lesson was not about alphamerge, it was about FIXTURES: the
// E2E that should have caught it used 640x360 for both the text media and the
// export resolution, so a size-confusion bug produced identical numbers either
// way. These assertions keep this table honest as rows get added.

describe("the parity table cannot coincide its way into passing", () => {
  const rows = TABLE.cases;

  it("covers the axes a placement bug could confuse", () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const has = (f: (c: ParityCase) => boolean) => rows.some(f);
    expect(has((c) => c.in.rotate === 90)).toBe(true);
    expect(has((c) => c.in.rotate === 270)).toBe(true);
    expect(has((c) => c.in.rotate === 180)).toBe(true);
    expect(has((c) => c.in.flipH && !c.in.flipV)).toBe(true);
    expect(has((c) => c.in.flipV && !c.in.flipH)).toBe(true);
    expect(has((c) => c.in.flipH && c.in.flipV)).toBe(true);
    expect(has((c) => c.out.cropFilter !== null)).toBe(true);
    expect(has((c) => c.in.crop !== null && c.out.cropFilter === null)).toBe(true);
    expect(has((c) => c.in.scale > 1)).toBe(true);
    expect(has((c) => c.in.scale < 1)).toBe(true);
    expect(has((c) => c.in.x !== 0 && c.in.y !== 0)).toBe(true);
    expect(has((c) => c.out.ox < 0)).toBe(true);
    expect(has((c) => c.out.oy < 0)).toBe(true);
    // both constraining axes, with both media orientations
    const widthBound = (c: ParityCase) => c.out.dw === c.in.canvasW;
    const heightBound = (c: ParityCase) => c.out.dh === c.in.canvasH;
    expect(has((c) => widthBound(c) && c.in.rotate === 0 && (c.in.mediaW ?? 0) > (c.in.mediaH ?? 0))).toBe(true);
    expect(has((c) => widthBound(c) && c.in.rotate === 0 && (c.in.mediaW ?? 0) < (c.in.mediaH ?? 0))).toBe(true);
    expect(has((c) => heightBound(c) && c.in.rotate === 0 && (c.in.mediaW ?? 0) > (c.in.mediaH ?? 0))).toBe(true);
    expect(has((c) => heightBound(c) && c.in.rotate === 0 && (c.in.mediaW ?? 0) < (c.in.mediaH ?? 0))).toBe(true);
    // a rotated case where the media is non-square AND the canvas is non-square
    expect(
      has(
        (c) =>
          (c.in.rotate === 90 || c.in.rotate === 270) &&
          c.in.mediaW !== c.in.mediaH &&
          c.in.canvasW !== c.in.canvasH,
      ),
    ).toBe(true);
  });

  it("never lets a media dimension coincide with a canvas dimension", () => {
    for (const c of rows) {
      if (c.in.mediaW === null) continue; // the deliberate "fall back" rows
      for (const [label, w, h] of [
        ["canvas", c.in.canvasW, c.in.canvasH],
        ["export", c.in.exportW, c.in.exportH],
      ] as const) {
        expect(c.in.mediaW, `${c.name}: mediaW must differ from ${label}W`).not.toBe(w);
        expect(c.in.mediaH, `${c.name}: mediaH must differ from ${label}H`).not.toBe(h);
        // ...and not cross-match either, which would hide a swapped-axis bug
        expect(c.in.mediaW, `${c.name}: mediaW must differ from ${label}H`).not.toBe(h);
        expect(c.in.mediaH, `${c.name}: mediaH must differ from ${label}W`).not.toBe(w);
      }
    }
  });

  /* ---- the export-resolution axis ---- */
  //
  // Same lesson as the media-vs-canvas guard above, one level out: a row whose
  // export resolution equals its project canvas cannot tell the two px spaces
  // apart, and for years every row was such a row. These keep at least a few
  // rows genuinely off-Original, and — crucially — assert that on those rows
  // the WRONG formula would produce a visibly different answer.

  /** What a builder that added canvas-px x/y straight onto an output-px
   *  centring term would emit. This is the shipped bug, kept here so the rows
   *  below have to actually diverge from it. */
  const unscaledOffsetOx = (c: ParityCase) => roundAway((c.in.exportW - c.out.dw) / 2 + c.in.x);
  const unscaledOffsetOy = (c: ParityCase) => roundAway((c.in.exportH - c.out.dh) / 2 + c.in.y);

  it("exports several rows at a resolution the canvas does not share", () => {
    const offOriginal = rows.filter(
      (c) => c.in.exportW !== c.in.canvasW || c.in.exportH !== c.in.canvasH,
    );
    expect(offOriginal.length).toBeGreaterThanOrEqual(4);
    // both directions, so an error that only shows when scaling one way cannot
    // hide in the other
    expect(offOriginal.some((c) => c.in.exportW > c.in.canvasW)).toBe(true);
    expect(offOriginal.some((c) => c.in.exportW < c.in.canvasW)).toBe(true);
    // a non-aspect-preserving export, where the two axes scale by different
    // factors: the only shape that can catch one ratio used for both, or the
    // two swapped
    expect(
      offOriginal.some(
        (c) => c.in.exportW / c.in.canvasW !== c.in.exportH / c.in.canvasH,
      ),
    ).toBe(true);
    // every off-Original row must carry offsets, or it says nothing about them
    expect(offOriginal.every((c) => c.in.x !== 0 || c.in.y !== 0)).toBe(true);
  });

  it("keeps rows where the export resolution genuinely moves the clip", () => {
    // On both axes at once, by a margin no rounding could account for.
    const moved = rows.filter(
      (c) =>
        Math.abs(unscaledOffsetOx(c) - c.out.ox) >= 2 &&
        Math.abs(unscaledOffsetOy(c) - c.out.oy) >= 2,
    );
    expect(moved.length).toBeGreaterThanOrEqual(2);
    // ...and one where only x moves, because the export squashes a single axis
    expect(
      rows.some(
        (c) =>
          Math.abs(unscaledOffsetOx(c) - c.out.ox) >= 2 &&
          unscaledOffsetOy(c) === c.out.oy &&
          c.in.y !== 0,
      ),
    ).toBe(true);
    // At Original the two formulas MUST agree — if they ever diverge there,
    // the ratio is being applied where there is nothing to convert.
    for (const c of rows) {
      if (c.in.exportW !== c.in.canvasW || c.in.exportH !== c.in.canvasH) continue;
      expect(unscaledOffsetOx(c), `${c.name}: ox at Original`).toBe(c.out.ox);
      expect(unscaledOffsetOy(c), `${c.name}: oy at Original`).toBe(c.out.oy);
      expect(c.out.dwExactOut, `${c.name}: extent at Original`).toBe(c.out.dwExact);
      expect(c.out.dhExactOut, `${c.name}: extent at Original`).toBe(c.out.dhExact);
    }
    // ...and on an off-Original row that scales both axes equally, the export
    // extent must actually differ from the preview's — a row whose media
    // happened to land the same size proves nothing about the scaling. (A
    // squashed export is excluded: it can leave the constraining axis, and so
    // the fit, exactly where it was.)
    for (const c of rows) {
      const { sx, sy } = ratio(c);
      if (sx === 1 || sx !== sy) continue;
      expect(c.out.dwExactOut, `${c.name}: extent must scale`).not.toBe(c.out.dwExact);
      expect(c.out.dhExactOut, `${c.name}: extent must scale`).not.toBe(c.out.dhExact);
    }
  });

  it("pairs an off-Original row with an otherwise identical Original one", () => {
    // The strongest form of the guard: two rows that differ in NOTHING but the
    // export resolution. Whatever their ox/oy disagreement is, the resolution
    // is the only thing that can have caused it.
    const same = (a: ParityCase, b: ParityCase) =>
      a.in.mediaW === b.in.mediaW && a.in.mediaH === b.in.mediaH &&
      a.in.canvasW === b.in.canvasW && a.in.canvasH === b.in.canvasH &&
      a.in.rotate === b.in.rotate && a.in.scale === b.in.scale &&
      a.in.x === b.in.x && a.in.y === b.in.y;
    const pairs = rows.flatMap((a) =>
      rows.filter(
        (b) =>
          same(a, b) &&
          a.in.exportW === a.in.canvasW &&
          b.in.exportW !== b.in.canvasW,
      ).map((b) => [a, b] as const),
    );
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const [orig, scaled] of pairs) {
      expect(scaled.out.ox, `${scaled.name} vs ${orig.name}`).not.toBe(orig.out.ox);
    }
  });

  it("keeps most fit ratios off round numbers and most scales off 1", () => {
    const nonIntegralFit = rows.filter(
      (c) => Math.abs(c.out.dwExact - Math.round(c.out.dwExact)) > 1e-6
        || Math.abs(c.out.dhExact - Math.round(c.out.dhExact)) > 1e-6,
    );
    expect(nonIntegralFit.length).toBeGreaterThanOrEqual(rows.length / 2);
    expect(rows.filter((c) => c.in.scale !== 1).length).toBeGreaterThanOrEqual(5);
    // at least one row where the exact extent is an ODD integer, so the
    // even-rounding is genuinely exercised rather than being a no-op
    expect(
      rows.some((c) => c.out.dwExact === Math.round(c.out.dwExact) && c.out.dw !== c.out.dwExact),
    ).toBe(true);
  });

  it("gives every row a distinct name and a stated reason", () => {
    expect(new Set(rows.map((c) => c.name)).size).toBe(rows.length);
    for (const c of rows) expect(c.why.length).toBeGreaterThan(30);
  });
});
