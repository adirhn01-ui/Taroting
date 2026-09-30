// The transparency checkerboard under an image project's canvas.
//
// It is CONTENT, not chrome: two fixed neutral palettes, never derived from
// the theme, so a custom theme can never paint the checker the same colour as
// the pixels it is meant to reveal. Which of the two is used is decided once
// per editor mount from the luminance of `--bg-app`, so it sits quietly on a
// dark app and a light one alike.
//
// Squares are 8 CSS px — 8·DPR device px — and stay that size at every zoom,
// the way every image editor draws it. The pattern is anchored at the canvas's
// top-left, so it travels with the image when it pans.

import type { Ctx2D } from "./index";

/** [square A, square B] */
export const CHECKER_DARK: readonly [string, string] = ["#2b2b2b", "#3a3a3a"];
export const CHECKER_LIGHT: readonly [string, string] = ["#e8e8e8", "#ffffff"];
/** Square edge in CSS px. */
export const CHECKER_CSS_PX = 8;

let palette: readonly [string, string] = CHECKER_DARK;

/** Relative luminance (0..1) of a #rgb / #rrggbb colour; null when it is not
 *  one (a theme var can hold anything a hand-edited settings file put there). */
export function hexLuminance(hex: string): number | null {
  let h = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(h)) return null;
  const lin = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** The palette for an app background: light app → light checker. An
 *  unreadable colour keeps the dark one (the shipped default theme). */
export function checkerPaletteFor(bgApp: string): readonly [string, string] {
  const l = hexLuminance(bgApp);
  return l !== null && l > 0.4 ? CHECKER_LIGHT : CHECKER_DARK;
}

/** Pick the palette from the live `--bg-app`. Called once per editor mount. */
export function pickCheckerPalette(): void {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-app");
  palette = checkerPaletteFor(bg);
}

interface Cached {
  a: string;
  side: number;
  pattern: CanvasPattern;
}
/** One pattern per target context, rebuilt only when the palette or the square
 *  size (DPR) changes: a steady frame allocates nothing. */
const patterns = new WeakMap<object, Cached>();

function patternFor(ctx: Ctx2D, side: number): CanvasPattern | null {
  const hit = patterns.get(ctx);
  if (hit && hit.a === palette[0] && hit.side === side) return hit.pattern;
  const tile = new OffscreenCanvas(side * 2, side * 2);
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = palette[0];
  t.fillRect(0, 0, side * 2, side * 2);
  t.fillStyle = palette[1];
  t.fillRect(side, 0, side, side);
  t.fillRect(0, side, side, side);
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return null;
  patterns.set(ctx, { a: palette[0], side, pattern });
  return pattern;
}

/** Fill the device-px rectangle (x, y, w, h) with the checker, its squares
 *  anchored at (x, y). Leaves the ctx transform at identity. */
export function fillChecker(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const side = Math.max(1, Math.round(CHECKER_CSS_PX * dpr));
  const pattern = patternFor(ctx, side);
  // Translating the ctx (not the pattern) anchors the squares without
  // allocating a DOMMatrix per frame. The anchor is rounded to whole device
  // px — a fractional pan would resample every square edge soft — but the
  // filled rectangle is not: it still covers exactly the image.
  const ax = Math.round(x);
  const ay = Math.round(y);
  ctx.setTransform(1, 0, 0, 1, ax, ay);
  ctx.fillStyle = pattern ?? palette[0];
  ctx.fillRect(x - ax, y - ay, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
